import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sharp from 'sharp'
import {
  BufferSource,
  choosePreviewForSize,
  detectRawFormat,
  extractRawPreviewFromFile,
  findRawPreviews,
  getRawPreviewSizeFromFile,
  largestPreview,
  orientedSize,
  parseJpegDimensions,
  readJpegExifOrientation,
  type RawPreview,
  type RawPreviewResult,
} from './raw-preview'
import { TAG, fakeJpeg, fakeRaf, fakeTiff } from './raw-preview.test-helpers'

const src = (b: Buffer) => new BufferSource(b)

/** Sony-style layout: IFD0 is the full-size preview, IFD1 the thumbnail, sensor size declared. */
function sonyLikeArw(opts: { orientation?: number; bigEndian?: boolean } = {}) {
  const big = fakeJpeg(1500, 1000)
  const small = fakeJpeg(300, 200)
  const file = fakeTiff(
    [
      {
        entries: [
          { tag: TAG.imageWidth, type: 4, value: 6000 },
          { tag: TAG.imageHeight, type: 4, value: 4000 },
          { tag: TAG.orientation, type: 3, value: opts.orientation ?? 1 },
          { tag: TAG.jpegIfOffset, type: 4, value: { blob: 0 } },
          { tag: TAG.jpegIfLength, type: 4, value: { blobLen: 0 } },
        ],
        next: 1,
      },
      {
        entries: [
          { tag: TAG.newSubfileType, type: 4, value: 1 },
          { tag: TAG.jpegIfOffset, type: 4, value: { blob: 1 } },
          { tag: TAG.jpegIfLength, type: 4, value: { blobLen: 1 } },
        ],
        next: null,
      },
    ],
    [big, small],
    { bigEndian: opts.bigEndian },
  )
  return { file, big, small }
}

function preview(width: number, height: number, extra: Partial<RawPreview> = {}): RawPreview {
  return {
    offset: width * 7 + height,
    length: 5000,
    width,
    height,
    orientation: 1,
    fromTag: true,
    ...extra,
  }
}

function result(candidates: RawPreview[]): RawPreviewResult {
  return { format: 'tiff', candidates, rawWidth: 0, rawHeight: 0 }
}

describe('JPEG header parsing', () => {
  it('reads dimensions from the SOF marker', () => {
    const j = fakeJpeg(4416, 2944)
    expect(parseJpegDimensions(src(j), 0, j.length)).toEqual({ width: 4416, height: 2944 })
  })

  it('reads EXIF orientation from APP1', () => {
    const j = fakeJpeg(640, 480, { orientation: 6 })
    expect(readJpegExifOrientation(src(j), 0, j.length)).toBe(6)
    const plain = fakeJpeg(640, 480)
    expect(readJpegExifOrientation(src(plain), 0, plain.length)).toBeNull()
  })

  it('rejects data that is not a JPEG', () => {
    const junk = Buffer.alloc(4096, 0x41)
    expect(parseJpegDimensions(src(junk), 0, junk.length)).toBeNull()
  })

  it('parses a real JPEG written by sharp, including its orientation', async () => {
    const real = await sharp({
      create: { width: 120, height: 80, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .jpeg()
      .withMetadata({ orientation: 8 })
      .toBuffer()
    expect(parseJpegDimensions(src(real), 0, real.length)).toEqual({ width: 120, height: 80 })
    expect(readJpegExifOrientation(src(real), 0, real.length)).toBe(8)
  })
})

describe('detectRawFormat', () => {
  it('identifies the containers by magic bytes', () => {
    expect(detectRawFormat(src(fakeRaf(fakeJpeg(64, 64))))).toBe('raf')
    expect(detectRawFormat(src(sonyLikeArw().file))).toBe('tiff')
    expect(detectRawFormat(src(sonyLikeArw({ bigEndian: true }).file))).toBe('tiff')
    expect(detectRawFormat(src(fakeTiff([{ entries: [], next: null }], [], { magic: 43 })))).toBe(
      'bigtiff',
    )
  })

  it('returns unknown for garbage and for input shorter than a header', () => {
    expect(detectRawFormat(src(Buffer.alloc(4096, 0x13)))).toBe('unknown')
    expect(detectRawFormat(src(Buffer.from('II')))).toBe('unknown')
  })
})

describe('findRawPreviews', () => {
  it('finds a RAF preview through the header table and takes orientation from its EXIF', () => {
    const jpeg = fakeJpeg(4416, 2944, { orientation: 6 })
    const r = findRawPreviews(src(fakeRaf(jpeg)), 'DSCF5056.RAF')
    expect(r.format).toBe('raf')
    expect(r.error).toBeUndefined()
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0]).toMatchObject({
      offset: 0x100,
      length: jpeg.length,
      width: 4416,
      height: 2944,
      orientation: 6,
      fromTag: true,
    })
  })

  it('walks a TIFF IFD chain, reads the sensor size and applies the container orientation', () => {
    for (const bigEndian of [false, true]) {
      const r = findRawPreviews(src(sonyLikeArw({ orientation: 8, bigEndian }).file), 'a.ARW')
      expect(r.format).toBe('tiff')
      expect(r.rawWidth).toBe(6000)
      expect(r.rawHeight).toBe(4000)
      expect(r.candidates.map((c) => [c.width, c.height])).toEqual([
        [1500, 1000],
        [300, 200],
      ])
      expect(r.candidates.every((c) => c.orientation === 8)).toBe(true)
    }
  })

  it('finds a JPEG-compressed strip in a SubIFD (the DNG / NEF layout)', () => {
    const strip = fakeJpeg(1024, 683)
    const file = fakeTiff(
      [
        {
          entries: [
            { tag: TAG.imageWidth, type: 4, value: 6000 },
            { tag: TAG.imageHeight, type: 4, value: 4000 },
            { tag: TAG.subIfds, type: 13, value: { ifd: 1 } },
          ],
          next: null,
        },
        {
          entries: [
            { tag: TAG.newSubfileType, type: 4, value: 1 },
            { tag: TAG.compression, type: 3, value: 7 },
            { tag: TAG.stripOffsets, type: 4, value: { blob: 0 } },
            { tag: TAG.stripByteCounts, type: 4, value: { blobLen: 0 } },
          ],
          next: null,
        },
      ],
      [strip],
    )
    const r = findRawPreviews(src(file), 'a.dng')
    expect(r.candidates.map((c) => [c.width, c.height])).toEqual([[1024, 683]])
  })

  it('rejects a "preview" larger than the sensor it claims to preview', () => {
    const file = fakeTiff(
      [
        {
          entries: [
            { tag: TAG.imageWidth, type: 4, value: 600 },
            { tag: TAG.imageHeight, type: 4, value: 400 },
            { tag: TAG.jpegIfOffset, type: 4, value: { blob: 0 } },
            { tag: TAG.jpegIfLength, type: 4, value: { blobLen: 0 } },
          ],
          next: null,
        },
      ],
      [fakeJpeg(6000, 4000)],
    )
    const r = findRawPreviews(src(file), 'a.ARW')
    expect(r.candidates).toHaveLength(0)
    expect(r.error).toMatch(/no valid embedded JPEG/)
  })

  it('terminates on an IFD cycle and still returns what it found', () => {
    const file = fakeTiff(
      [
        {
          entries: [
            { tag: TAG.jpegIfOffset, type: 4, value: { blob: 0 } },
            { tag: TAG.jpegIfLength, type: 4, value: { blobLen: 0 } },
          ],
          next: 1,
        },
        { entries: [{ tag: TAG.newSubfileType, type: 4, value: 1 }], next: 0 },
      ],
      [fakeJpeg(1600, 1066)],
    )
    const r = findRawPreviews(src(file), 'a.ARW')
    expect(r.candidates.map((c) => c.width)).toEqual([1600])
  })

  it('refuses BigTIFF instead of misreading its 8-byte offsets', () => {
    const r = findRawPreviews(src(fakeTiff([{ entries: [], next: null }], [], { magic: 43 })))
    expect(r.format).toBe('bigtiff')
    expect(r.candidates).toHaveLength(0)
    expect(r.error).toMatch(/BigTIFF/)
  })

  it('returns an error, not an exception, for garbage and for out-of-range pointers', () => {
    expect(findRawPreviews(src(Buffer.alloc(8192, 0x5a))).error).toBeDefined()
    const broken = fakeRaf(fakeJpeg(800, 600))
    broken.writeUInt32BE(0x7fffffff, 0x54)
    expect(() => findRawPreviews(src(broken), 'x.RAF')).not.toThrow()
  })

  it('trims padding after the EOI that the declared length included', () => {
    const jpeg = fakeJpeg(1500, 1000)
    const padded = Buffer.concat([jpeg, Buffer.alloc(3000)])
    const file = fakeTiff(
      [
        {
          entries: [
            { tag: TAG.jpegIfOffset, type: 4, value: { blob: 0 } },
            { tag: TAG.jpegIfLength, type: 4, value: { blobLen: 0 } },
          ],
          next: null,
        },
      ],
      [padded],
    )
    const r = findRawPreviews(src(file), 'a.ARW')
    expect(r.candidates[0].length).toBe(jpeg.length)
  })

  it('falls back to scanning for an SOI when no tag points at a preview', () => {
    const file = Buffer.concat([
      fakeTiff([{ entries: [{ tag: TAG.imageWidth, type: 4, value: 6000 }], next: null }], []),
      Buffer.alloc(100),
      fakeJpeg(1200, 800),
    ])
    const r = findRawPreviews(src(file), 'a.ARW')
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0].fromTag).toBe(false)
  })
})

describe('choosePreviewForSize', () => {
  const three = result([preview(6000, 4000), preview(1616, 1080), preview(160, 120)])

  it('picks the smallest on-aspect preview that still covers the target edge', () => {
    expect(choosePreviewForSize(three, 533)?.width).toBe(1616)
    expect(choosePreviewForSize(three, 1616)?.width).toBe(1616)
    expect(choosePreviewForSize(three, 1617)?.width).toBe(6000)
  })

  it('skips an off-aspect decoy even when it is the smallest sufficient size', () => {
    const r = result([preview(6000, 4000), preview(1616, 1080), preview(256, 256)])
    expect(choosePreviewForSize(r, 200)?.width).toBe(1616)
  })

  it('falls back to the largest on-aspect preview when none reaches the edge', () => {
    expect(choosePreviewForSize(three, 99999)?.width).toBe(6000)
    expect(largestPreview(three)?.width).toBe(6000)
  })

  it('returns null when there are no candidates', () => {
    expect(choosePreviewForSize(result([]), 300)).toBeNull()
  })
})

describe('orientedSize', () => {
  it('swaps width and height for the transposing orientations 5 to 8', () => {
    for (const o of [1, 2, 3, 4]) {
      expect(orientedSize(preview(300, 200, { orientation: o }))).toEqual({
        width: 300,
        height: 200,
      })
    }
    for (const o of [5, 6, 7, 8]) {
      expect(orientedSize(preview(300, 200, { orientation: o }))).toEqual({
        width: 200,
        height: 300,
      })
    }
  })
})

describe('file helpers', () => {
  const made: string[] = []
  const write = (name: string, data: Buffer) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-preview-test-'))
    made.push(dir)
    const p = path.join(dir, name)
    fs.writeFileSync(p, data)
    return p
  }
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('extracts exactly the chosen JPEG bytes from a RAF on disk', () => {
    const jpeg = fakeJpeg(4416, 2944, { orientation: 6 })
    const p = write('DSCF5056.RAF', fakeRaf(jpeg))
    const got = extractRawPreviewFromFile(p, 533)
    expect(got).not.toBeNull()
    expect(got!.jpeg.equals(jpeg)).toBe(true)
    expect(got).toMatchObject({ width: 4416, height: 2944, orientation: 6 })
  })

  it('reports the displayed (oriented) size of the largest preview', () => {
    const p = write('a.ARW', sonyLikeArw({ orientation: 6 }).file)
    expect(getRawPreviewSizeFromFile(p)).toEqual({ width: 1000, height: 1500 })
  })

  it('chooses the small preview for a thumbnail and the big one for full size', () => {
    const { file, big, small } = sonyLikeArw()
    const p = write('a.ARW', file)
    expect(extractRawPreviewFromFile(p, 300)!.jpeg.equals(small)).toBe(true)
    expect(extractRawPreviewFromFile(p, Infinity)!.jpeg.equals(big)).toBe(true)
  })

  it('returns null for a RAW with no usable preview', () => {
    const p = write(
      'a.ARW',
      fakeTiff([{ entries: [{ tag: TAG.imageWidth, type: 4, value: 6000 }], next: null }], []),
    )
    expect(extractRawPreviewFromFile(p, 300)).toBeNull()
    expect(getRawPreviewSizeFromFile(p)).toBeNull()
  })
})
