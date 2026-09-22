import { describe, expect, it } from 'vitest'
import {
  cameraName,
  exifDateToIso,
  formatShutterSpeed,
  photoExifMetadata,
  readPhotoExifFromBuffer,
} from './photo-exif'

// --- a tiny little-endian TIFF/EXIF writer ------------------------------------------------------

type Value =
  | { ascii: string }
  | { short: number }
  | { long: number }
  | { rational: [number, number] }
  | { undefined: Buffer }

interface Tag {
  tag: number
  value: Value
}

/** Serialises an IFD at `at` (absolute in the TIFF) followed by its out-of-line data. */
function writeIfd(tags: Tag[], at: number): Buffer {
  const sorted = [...tags].sort((a, b) => a.tag - b.tag)
  const head = Buffer.alloc(2 + sorted.length * 12 + 4)
  head.writeUInt16LE(sorted.length, 0)
  const data: Buffer[] = []
  let dataAt = at + head.length
  sorted.forEach(({ tag, value }, i) => {
    const p = 2 + i * 12
    let type: number
    let count: number
    let bytes: Buffer
    if ('ascii' in value) {
      type = 2
      bytes = Buffer.from(value.ascii + '\0', 'latin1')
      count = bytes.length
    } else if ('short' in value) {
      type = 3
      count = 1
      bytes = Buffer.alloc(2)
      bytes.writeUInt16LE(value.short)
    } else if ('long' in value) {
      type = 4
      count = 1
      bytes = Buffer.alloc(4)
      bytes.writeUInt32LE(value.long)
    } else if ('rational' in value) {
      type = 5
      count = 1
      bytes = Buffer.alloc(8)
      bytes.writeUInt32LE(value.rational[0])
      bytes.writeUInt32LE(value.rational[1], 4)
    } else {
      type = 7
      bytes = value.undefined
      count = bytes.length
    }
    head.writeUInt16LE(tag, p)
    head.writeUInt16LE(type, p + 2)
    head.writeUInt32LE(count, p + 4)
    if (bytes.length <= 4) {
      bytes.copy(head, p + 8)
    } else {
      head.writeUInt32LE(dataAt, p + 8)
      data.push(bytes)
      dataAt += bytes.length
    }
  })
  return Buffer.concat([head, ...data])
}

/** A Fujifilm MakerNote: "FUJIFILM", the IFD offset (12), then an IFD relative to the note. */
function fujiNote(tags: Tag[]): Buffer {
  const header = Buffer.alloc(12)
  header.write('FUJIFILM', 0, 'latin1')
  header.writeUInt32LE(12, 8)
  // Offsets inside the note are relative to its start, which writeIfd models as base 0.
  return Buffer.concat([header, writeIfd(tags, 12)])
}

/** A little-endian TIFF with IFD0 and an EXIF sub-IFD. */
function tiff(ifd0: Tag[], exif: Tag[]): Buffer {
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])
  // IFD0 needs the EXIF pointer before its own size is known: write it twice.
  const withPtr = (ptr: number) => [...ifd0, { tag: 0x8769, value: { long: ptr } }]
  const first = writeIfd(withPtr(0), 8)
  const exifAt = 8 + first.length
  return Buffer.concat([header, writeIfd(withPtr(exifAt), 8), writeIfd(exif, exifAt)])
}

/** SOI + APP1 "Exif" + a TIFF + SOS + EOI. */
function jpegWithExif(t: Buffer): Buffer {
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t])
  const len = Buffer.alloc(2)
  len.writeUInt16BE(app1.length + 2)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    len,
    app1,
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]),
  ])
}

/** A RAF: magic, the embedded JPEG's offset (0x54) and length (0x58), then the JPEG. */
function raf(jpeg: Buffer): Buffer {
  const head = Buffer.alloc(0x100)
  head.write('FUJIFILMCCD-RAW 0201', 0, 'latin1')
  head.writeUInt32BE(0x100, 0x54)
  head.writeUInt32BE(jpeg.length, 0x58)
  return Buffer.concat([head, jpeg])
}

const X100VI_EXIF = tiff(
  [
    { tag: 0x010f, value: { ascii: 'FUJIFILM' } },
    { tag: 0x0110, value: { ascii: 'X100VI' } },
  ],
  [
    { tag: 0x829a, value: { rational: [1, 250] } },
    { tag: 0x829d, value: { rational: [56, 10] } },
    { tag: 0x8827, value: { short: 250 } },
    { tag: 0x9003, value: { ascii: '2026:09:06 11:32:57' } },
    { tag: 0x9011, value: { ascii: '-04:00' } },
    { tag: 0x9291, value: { ascii: '16' } },
    { tag: 0x920a, value: { rational: [230, 10] } },
    { tag: 0xa405, value: { short: 35 } },
    { tag: 0x927c, value: { undefined: fujiNote([{ tag: 0x1401, value: { short: 0x800 } }]) } },
  ],
)

describe('readPhotoExif', () => {
  it('reads camera settings and the film simulation from a Fujifilm JPEG', () => {
    expect(readPhotoExifFromBuffer(jpegWithExif(X100VI_EXIF), 'DSCF5543.JPG')).toEqual({
      make: 'FUJIFILM',
      model: 'X100VI',
      capturedAt: '2026-09-06T15:32:57.160Z',
      exposureTime: 0.004,
      fNumber: 5.6,
      iso: 250,
      focalLength: 23,
      focalLength35: 35,
      filmSimulation: 'Classic Neg.',
    })
  })

  it('reads a RAF through its embedded JPEG', () => {
    const exif = readPhotoExifFromBuffer(raf(jpegWithExif(X100VI_EXIF)), 'DSCF5543.RAF')
    expect(exif?.model).toBe('X100VI')
    expect(exif?.filmSimulation).toBe('Classic Neg.')
  })

  it('reads a TIFF-based RAW (Sony ARW) directly, with its lens', () => {
    const arw = tiff(
      [
        { tag: 0x010f, value: { ascii: 'SONY' } },
        { tag: 0x0110, value: { ascii: 'ILCE-7CM2' } },
      ],
      [
        { tag: 0x9003, value: { ascii: '2026:09:05 08:00:00' } },
        { tag: 0x829a, value: { rational: [1, 2] } },
        { tag: 0xa434, value: { ascii: 'FE 40mm F2.5 G' } },
      ],
    )
    const exif = readPhotoExifFromBuffer(arw, '_DSC2028.ARW')
    expect(exif).toMatchObject({
      make: 'SONY',
      model: 'ILCE-7CM2',
      lensModel: 'FE 40mm F2.5 G',
      exposureTime: 0.5,
      // No OffsetTimeOriginal: the wall-clock time is kept as if it were UTC.
      capturedAt: '2026-09-05T08:00:00.000Z',
    })
    expect(exif?.filmSimulation).toBeUndefined()
  })

  it('names monochrome film simulations from the Saturation tag', () => {
    const t = tiff(
      [{ tag: 0x010f, value: { ascii: 'FUJIFILM' } }],
      [
        {
          tag: 0x927c,
          value: {
            undefined: fujiNote([
              { tag: 0x1003, value: { short: 0x502 } },
              { tag: 0x1401, value: { short: 0x000 } },
            ]),
          },
        },
      ],
    )
    expect(readPhotoExifFromBuffer(jpegWithExif(t))?.filmSimulation).toBe('Acros Ye')
  })

  it('returns null for files without EXIF, and for truncated or hostile data', () => {
    expect(readPhotoExifFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull()
    expect(readPhotoExifFromBuffer(Buffer.from('not an image'))).toBeNull()
    expect(readPhotoExifFromBuffer(jpegWithExif(X100VI_EXIF).subarray(0, 40))).toBeNull()
    // An EXIF pointer far past the end of the file.
    const bad = tiff([{ tag: 0x010f, value: { ascii: 'X' } }], [])
    bad.writeUInt32LE(0x7fffffff, bad.length - 10)
    expect(() => readPhotoExifFromBuffer(jpegWithExif(bad))).not.toThrow()
  })
})

describe('photo EXIF helpers', () => {
  it('converts EXIF dates, honouring the recorded UTC offset', () => {
    expect(exifDateToIso('2026:09:06 11:32:57', '16', '-04:00')).toBe('2026-09-06T15:32:57.160Z')
    expect(exifDateToIso('2026:09:06 11:32:57')).toBe('2026-09-06T11:32:57.000Z')
    expect(exifDateToIso('0000:00:00 00:00:00')).toBeUndefined()
    expect(exifDateToIso('garbage')).toBeUndefined()
  })

  it('names cameras without repeating the maker', () => {
    expect(cameraName('FUJIFILM', 'X100VI')).toBe('FUJIFILM X100VI')
    expect(cameraName('Canon', 'Canon EOS R5')).toBe('Canon EOS R5')
    expect(cameraName(undefined, 'X100VI')).toBe('X100VI')
  })

  it('formats shutter speeds like a camera', () => {
    expect(formatShutterSpeed(0.004)).toBe('1/250')
    expect(formatShutterSpeed(1 / 34)).toBe('1/34')
    expect(formatShutterSpeed(2)).toBe('2s')
    expect(formatShutterSpeed(0)).toBeUndefined()
  })

  it('maps EXIF to metadata-field updates', () => {
    const exif = readPhotoExifFromBuffer(jpegWithExif(X100VI_EXIF))
    expect(photoExifMetadata(exif)).toEqual([
      { key: 'capture_date', value: '2026-09-06T15:32:57.160Z' },
      { key: 'camera', value: 'FUJIFILM X100VI' },
      { key: 'film_simulation', value: 'Classic Neg.' },
      { key: 'focal_length', value: 23 },
      { key: 'aperture', value: 5.6 },
      { key: 'shutter_speed', value: '1/250' },
      { key: 'iso', value: 250 },
    ])
    expect(photoExifMetadata(null)).toEqual([])
  })
})
