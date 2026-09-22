/**
 * Read the camera settings a photo was taken with (camera, lens, exposure, date taken, and the
 * Fujifilm film simulation) from its EXIF, without decoding the image.
 *
 * Handles JPEG (APP1 "Exif"), TIFF-based RAW files (Sony ARW, Nikon NEF, Canon CR2, DNG, ...) and
 * Fujifilm RAF (whose header points at an embedded JPEG that carries the full EXIF). Reads go
 * through the same bounds-checked `ByteSource` as the RAW preview parser, so only the header and
 * the few IFDs involved are read, and every file-controlled offset and loop is capped.
 */
import * as fs from 'fs'
import { type ByteSource, BufferSource, FileSource, detectRawFormat } from './raw-preview'

export interface PhotoExif {
  make?: string
  model?: string
  lensModel?: string
  /**
   * When the photo was taken, as an ISO string. When the camera recorded its UTC offset
   * (OffsetTimeOriginal) this is the true instant; otherwise the camera's wall-clock time is
   * written as if it were UTC.
   */
  capturedAt?: string
  /** Seconds. */
  exposureTime?: number
  fNumber?: number
  iso?: number
  /** Millimetres. */
  focalLength?: number
  focalLength35?: number
  /** Fujifilm film simulation, e.g. "Classic Chrome" or "Acros Ye". */
  filmSimulation?: string
  /**
   * The Fujifilm recipe: every in-camera look setting as one readable string (see
   * `describeFujiRecipe`). Photos taken with the same recipe share it exactly.
   */
  fujiRecipe?: string
}

const MAX_IFD_ENTRIES = 512
const MAX_STRING = 256
const MAX_JPEG_SEGMENTS = 64

const TAG_MAKE = 0x010f
const TAG_MODEL = 0x0110
const TAG_DATETIME = 0x0132
const TAG_EXIF_IFD = 0x8769
const TAG_EXPOSURE_TIME = 0x829a
const TAG_F_NUMBER = 0x829d
const TAG_ISO = 0x8827
const TAG_DATETIME_ORIGINAL = 0x9003
const TAG_OFFSET_TIME_ORIGINAL = 0x9011
const TAG_FOCAL_LENGTH = 0x920a
const TAG_MAKER_NOTE = 0x927c
const TAG_SUBSEC_ORIGINAL = 0x9291
const TAG_FOCAL_LENGTH_35 = 0xa405
const TAG_LENS_MODEL = 0xa434

const FUJI_SHARPNESS = 0x1001
const FUJI_WHITE_BALANCE = 0x1002
const FUJI_SATURATION = 0x1003
const FUJI_COLOR_TEMPERATURE = 0x1005
const FUJI_WB_FINE_TUNE = 0x100a
const FUJI_NOISE_REDUCTION = 0x100e
const FUJI_CLARITY = 0x100f
const FUJI_SHADOW_TONE = 0x1040
const FUJI_HIGHLIGHT_TONE = 0x1041
const FUJI_GRAIN_ROUGHNESS = 0x1047
const FUJI_COLOR_CHROME = 0x1048
const FUJI_BW_WARM_COOL = 0x1049
const FUJI_BW_MAGENTA_GREEN = 0x104b
const FUJI_GRAIN_SIZE = 0x104c
const FUJI_COLOR_CHROME_BLUE = 0x104e
const FUJI_FILM_MODE = 0x1401

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4]

interface Tiff {
  src: ByteSource
  base: number
  be: boolean
}

interface Entry {
  tag: number
  type: number
  count: number
  valueOffset: number
}

function readIfd(t: Tiff, at: number): Entry[] {
  const head = t.src.read(at, 2)
  if (!head) return []
  const count = t.be ? head.readUInt16BE(0) : head.readUInt16LE(0)
  if (count === 0 || count > MAX_IFD_ENTRIES) return []
  const table = t.src.read(at + 2, count * 12)
  if (!table) return []
  const entries: Entry[] = []
  for (let i = 0; i < count; i++) {
    const p = i * 12
    const tag = t.be ? table.readUInt16BE(p) : table.readUInt16LE(p)
    const type = t.be ? table.readUInt16BE(p + 2) : table.readUInt16LE(p + 2)
    const n = t.be ? table.readUInt32BE(p + 4) : table.readUInt32LE(p + 4)
    const size = TYPE_SIZE[type] ?? 0
    if (size === 0 || n === 0) continue
    const total = size * n
    const valueOffset =
      total <= 4
        ? at + 2 + p + 8
        : t.base + (t.be ? table.readUInt32BE(p + 8) : table.readUInt32LE(p + 8))
    entries.push({ tag, type, count: n, valueOffset })
  }
  return entries
}

function find(entries: Entry[], tag: number): Entry | undefined {
  return entries.find((e) => e.tag === tag)
}

function readString(t: Tiff, e: Entry | undefined): string | undefined {
  if (!e || (e.type !== 2 && e.type !== 7)) return undefined
  const b = t.src.read(e.valueOffset, Math.min(e.count, MAX_STRING))
  if (!b) return undefined
  const s = b.toString('latin1').replace(/\0.*$/s, '').trim()
  return s || undefined
}

function readNumber(t: Tiff, e: Entry | undefined, index = 0): number | undefined {
  if (!e || index >= e.count) return undefined
  const size = TYPE_SIZE[e.type] ?? 0
  const b = t.src.read(e.valueOffset + index * size, size)
  if (!b) return undefined
  const u16 = (o: number) => (t.be ? b.readUInt16BE(o) : b.readUInt16LE(o))
  const u32 = (o: number) => (t.be ? b.readUInt32BE(o) : b.readUInt32LE(o))
  const s32 = (o: number) => (t.be ? b.readInt32BE(o) : b.readInt32LE(o))
  switch (e.type) {
    case 1:
      return b[0]
    case 3:
      return u16(0)
    case 4:
      return u32(0)
    case 8:
      return t.be ? b.readInt16BE(0) : b.readInt16LE(0)
    case 9:
      return s32(0)
    case 5: {
      const d = u32(4)
      return d === 0 ? undefined : u32(0) / d
    }
    case 10: {
      const d = s32(4)
      return d === 0 ? undefined : s32(0) / d
    }
    default:
      return undefined
  }
}

/** The TIFF header offset of the first "Exif" APP1 segment of the JPEG at `offset`. */
function jpegTiffBase(src: ByteSource, offset: number): number | null {
  const soi = src.read(offset, 2)
  if (!soi || soi[0] !== 0xff || soi[1] !== 0xd8) return null
  let p = offset + 2
  for (let i = 0; i < MAX_JPEG_SEGMENTS; i++) {
    const h = src.read(p, 4)
    if (!h || h[0] !== 0xff) return null
    const marker = h[1]
    if (marker === 0xda || marker === 0xd9) return null
    const len = h.readUInt16BE(2)
    if (len < 2) return null
    if (marker === 0xe1 && src.read(p + 4, 6)?.toString('latin1') === 'Exif\0\0') return p + 10
    p += 2 + len
  }
  return null
}

function openTiff(src: ByteSource, base: number): { t: Tiff; ifd0: number } | null {
  const h = src.read(base, 8)
  if (!h) return null
  const order = h.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') return null
  const be = order === 'MM'
  const ifd0 = be ? h.readUInt32BE(4) : h.readUInt32LE(4)
  return { t: { src, base, be }, ifd0: base + ifd0 }
}

// Fujifilm MakerNote FilmMode (0x1401) and, for monochrome, Saturation (0x1003) values, as
// documented by ExifTool's FujiFilm tables.
const FUJI_FILM_MODES: Record<number, string> = {
  0x000: 'Provia',
  0x100: 'Studio Portrait',
  0x110: 'Studio Portrait Enhanced Saturation',
  0x120: 'Astia',
  0x130: 'Studio Portrait Increased Sharpness',
  0x200: 'Velvia',
  0x300: 'Studio Portrait Ex',
  0x400: 'Velvia',
  0x500: 'Pro Neg. Std',
  0x501: 'Pro Neg. Hi',
  0x600: 'Classic Chrome',
  0x700: 'Eterna',
  0x800: 'Classic Neg.',
  0x900: 'Eterna Bleach Bypass',
  0xa00: 'Nostalgic Neg.',
  0xb00: 'Reala Ace',
}

const FUJI_MONOCHROME: Record<number, string> = {
  0x300: 'Monochrome',
  0x301: 'Monochrome R',
  0x302: 'Monochrome Ye',
  0x303: 'Monochrome G',
  0x310: 'Sepia',
  0x500: 'Acros',
  0x501: 'Acros R',
  0x502: 'Acros Ye',
  0x503: 'Acros G',
}

/** The raw Fujifilm MakerNote values that make up a recipe. */
export interface FujiRecipeSettings {
  filmMode?: number
  saturation?: number
  whiteBalance?: number
  colorTemperature?: number
  wbShiftRed?: number
  wbShiftBlue?: number
  highlight?: number
  shadow?: number
  sharpness?: number
  noiseReduction?: number
  clarity?: number
  grainRoughness?: number
  grainSize?: number
  colorChrome?: number
  colorChromeBlue?: number
  bwWarmCool?: number
  bwMagentaGreen?: number
}

function readFujiMakerNote(
  src: ByteSource,
  note: Entry,
): { filmSimulation?: string; settings: FujiRecipeSettings } | undefined {
  // "FUJIFILM" + little-endian offset of the IFD, both relative to the start of the note.
  const head = src.read(note.valueOffset, 12)
  if (!head || head.toString('latin1', 0, 8) !== 'FUJIFILM') return undefined
  const t: Tiff = { src, base: note.valueOffset, be: false }
  const entries = readIfd(t, note.valueOffset + head.readUInt32LE(8))
  const get = (tag: number, index = 0) => readNumber(t, find(entries, tag), index)
  const settings: FujiRecipeSettings = {
    filmMode: get(FUJI_FILM_MODE),
    saturation: get(FUJI_SATURATION),
    whiteBalance: get(FUJI_WHITE_BALANCE),
    colorTemperature: get(FUJI_COLOR_TEMPERATURE),
    wbShiftRed: get(FUJI_WB_FINE_TUNE, 0),
    wbShiftBlue: get(FUJI_WB_FINE_TUNE, 1),
    highlight: get(FUJI_HIGHLIGHT_TONE),
    shadow: get(FUJI_SHADOW_TONE),
    sharpness: get(FUJI_SHARPNESS),
    noiseReduction: get(FUJI_NOISE_REDUCTION),
    clarity: get(FUJI_CLARITY),
    grainRoughness: get(FUJI_GRAIN_ROUGHNESS),
    grainSize: get(FUJI_GRAIN_SIZE),
    colorChrome: get(FUJI_COLOR_CHROME),
    colorChromeBlue: get(FUJI_COLOR_CHROME_BLUE),
    bwWarmCool: get(FUJI_BW_WARM_COOL),
    bwMagentaGreen: get(FUJI_BW_MAGENTA_GREEN),
  }
  const mono = settings.saturation !== undefined ? FUJI_MONOCHROME[settings.saturation] : undefined
  const filmSimulation =
    mono ?? (settings.filmMode === undefined ? undefined : FUJI_FILM_MODES[settings.filmMode])
  return { filmSimulation, settings }
}

// Value tables from ExifTool's FujiFilm tags; the tone curves and clarity are linear.
const FUJI_SHARPNESS_STEPS: Record<number, string> = {
  0x0: '-4',
  0x1: '-3',
  0x2: '-2',
  0x82: '-1',
  0x3: '0',
  0x84: '+1',
  0x4: '+2',
  0x5: '+3',
  0x6: '+4',
}
const FUJI_COLOR_STEPS: Record<number, string> = {
  0x4e0: '-4',
  0x4c0: '-3',
  0x400: '-2',
  0x180: '-1',
  0x0: '0',
  0x80: '+1',
  0x100: '+2',
  0xc0: '+3',
  0xe0: '+4',
}
const FUJI_NR_STEPS: Record<number, string> = {
  0x2e0: '-4',
  0x2c0: '-3',
  0x200: '-2',
  0x280: '-1',
  0x0: '0',
  0x180: '+1',
  0x100: '+2',
  0x1c0: '+3',
  0x1e0: '+4',
}
const FUJI_WB_MODES: Record<number, string> = {
  0x0: 'Auto',
  0x1: 'Auto White Priority',
  0x2: 'Auto Ambience Priority',
  0x100: 'Daylight',
  0x200: 'Cloudy',
  0x300: 'Fluorescent 1',
  0x301: 'Fluorescent 2',
  0x302: 'Fluorescent 3',
  0x400: 'Incandescent',
  0x500: 'Flash',
  0x600: 'Underwater',
}
const FUJI_STRENGTH: Record<number, string> = { 0: 'Off', 32: 'Weak', 64: 'Strong' }
const FUJI_GRAIN_SIZES: Record<number, string> = { 0: '', 16: ' Small', 32: ' Large' }

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

/**
 * One readable line for a Fujifilm recipe, stable for identical settings, e.g.
 * "Classic Neg. | Grain Off | Color Chrome Weak | FX Blue Weak | WB Auto R+4 B-5 |
 * Highlight -1.5 | Shadow +2 | Color -1 | Sharpness +1 | NR 0 | Clarity 0".
 * Dynamic range and exposure are left out: they change shot to shot within one recipe.
 * Returns undefined when the film simulation is unknown.
 */
export function describeFujiRecipe(
  s: FujiRecipeSettings,
  filmSimulation: string | undefined,
): string | undefined {
  if (!filmSimulation) return undefined
  const parts = [filmSimulation]
  if (s.grainRoughness !== undefined) {
    const rough = FUJI_STRENGTH[s.grainRoughness] ?? String(s.grainRoughness)
    parts.push(`Grain ${rough}${rough === 'Off' ? '' : (FUJI_GRAIN_SIZES[s.grainSize ?? 0] ?? '')}`)
  }
  if (s.colorChrome !== undefined) {
    parts.push(`Color Chrome ${FUJI_STRENGTH[s.colorChrome] ?? s.colorChrome}`)
  }
  if (s.colorChromeBlue !== undefined) {
    parts.push(`FX Blue ${FUJI_STRENGTH[s.colorChromeBlue] ?? s.colorChromeBlue}`)
  }
  if (s.whiteBalance !== undefined) {
    const mode =
      s.whiteBalance === 0xff0
        ? `${s.colorTemperature ?? '?'}K`
        : (FUJI_WB_MODES[s.whiteBalance] ?? `Custom ${s.whiteBalance.toString(16)}`)
    // Newer bodies store the shift in 1/20 steps.
    const r = Math.round((s.wbShiftRed ?? 0) / 20)
    const b = Math.round((s.wbShiftBlue ?? 0) / 20)
    parts.push(`WB ${mode} R${signed(r)} B${signed(b)}`)
  }
  // Tone curves: raw -16 per +1 step, in half steps on newer bodies.
  if (s.highlight !== undefined) parts.push(`Highlight ${signed(-s.highlight / 16)}`)
  if (s.shadow !== undefined) parts.push(`Shadow ${signed(-s.shadow / 16)}`)
  const mono = s.saturation !== undefined && FUJI_MONOCHROME[s.saturation] !== undefined
  if (mono) {
    if (s.bwWarmCool !== undefined || s.bwMagentaGreen !== undefined) {
      parts.push(`Mono WC ${signed(s.bwWarmCool ?? 0)} MG ${signed(s.bwMagentaGreen ?? 0)}`)
    }
  } else if (s.saturation !== undefined) {
    parts.push(`Color ${FUJI_COLOR_STEPS[s.saturation] ?? `0x${s.saturation.toString(16)}`}`)
  }
  if (s.sharpness !== undefined && FUJI_SHARPNESS_STEPS[s.sharpness] !== undefined) {
    parts.push(`Sharpness ${FUJI_SHARPNESS_STEPS[s.sharpness]}`)
  }
  if (s.noiseReduction !== undefined && FUJI_NR_STEPS[s.noiseReduction] !== undefined) {
    parts.push(`NR ${FUJI_NR_STEPS[s.noiseReduction]}`)
  }
  if (s.clarity !== undefined) parts.push(`Clarity ${signed(Math.round(s.clarity / 1000))}`)
  return parts.join(' | ')
}

/** "2026:09:20 14:03:22" (+ sub-seconds, + "-07:00") to an ISO string. */
export function exifDateToIso(
  value: string | undefined,
  subSec?: string,
  offset?: string,
): string | undefined {
  const m = value?.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return undefined
  const [, y, mo, d, h, mi, s] = m
  if (y === '0000') return undefined
  const ms = (subSec?.match(/^\d+/)?.[0] ?? '0').padEnd(3, '0').slice(0, 3)
  const zone = offset?.match(/^[+-]\d{2}:\d{2}$/) ? offset : 'Z'
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}${zone}`)
  return isNaN(date.getTime()) ? undefined : date.toISOString()
}

function round(n: number | undefined, digits: number): number | undefined {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function readTiffExif(src: ByteSource, base: number): PhotoExif | null {
  const opened = openTiff(src, base)
  if (!opened) return null
  const { t, ifd0 } = opened
  const top = readIfd(t, ifd0)
  if (top.length === 0) return null

  const out: PhotoExif = {
    make: readString(t, find(top, TAG_MAKE)),
    model: readString(t, find(top, TAG_MODEL)),
  }
  let dateTime = readString(t, find(top, TAG_DATETIME))

  const exifPtr = readNumber(t, find(top, TAG_EXIF_IFD))
  if (exifPtr !== undefined && exifPtr > 0) {
    const exif = readIfd(t, base + exifPtr)
    const original = readString(t, find(exif, TAG_DATETIME_ORIGINAL))
    if (original) dateTime = original
    out.capturedAt = exifDateToIso(
      dateTime,
      original ? readString(t, find(exif, TAG_SUBSEC_ORIGINAL)) : undefined,
      original ? readString(t, find(exif, TAG_OFFSET_TIME_ORIGINAL)) : undefined,
    )
    out.exposureTime = round(readNumber(t, find(exif, TAG_EXPOSURE_TIME)), 6)
    out.fNumber = round(readNumber(t, find(exif, TAG_F_NUMBER)), 1)
    out.iso = round(readNumber(t, find(exif, TAG_ISO)), 0)
    out.focalLength = round(readNumber(t, find(exif, TAG_FOCAL_LENGTH)), 1)
    out.focalLength35 = round(readNumber(t, find(exif, TAG_FOCAL_LENGTH_35)), 0)
    out.lensModel = readString(t, find(exif, TAG_LENS_MODEL))
    const note = find(exif, TAG_MAKER_NOTE)
    if (note && /fujifilm/i.test(out.make ?? '')) {
      const fuji = readFujiMakerNote(src, note)
      out.filmSimulation = fuji?.filmSimulation
      out.fujiRecipe = fuji && describeFujiRecipe(fuji.settings, fuji.filmSimulation)
    }
  } else {
    out.capturedAt = exifDateToIso(dateTime)
  }

  for (const k of Object.keys(out) as (keyof PhotoExif)[]) {
    if (out[k] === undefined) delete out[k]
  }
  return Object.keys(out).length > 0 ? out : null
}

/** The photo's camera settings, or null when it has no readable EXIF. Never throws. */
export function readPhotoExif(src: ByteSource, filename = ''): PhotoExif | null {
  try {
    const magic = src.read(0, Math.min(2, src.size()))
    if (magic && magic[0] === 0xff && magic[1] === 0xd8) {
      const base = jpegTiffBase(src, 0)
      return base === null ? null : readTiffExif(src, base)
    }
    const format = detectRawFormat(src, filename)
    if (format === 'tiff') return readTiffExif(src, 0)
    if (format === 'raf') {
      // Fuji's header: big-endian offset of the embedded JPEG at 0x54.
      const off = src.read(0x54, 4)?.readUInt32BE(0)
      const base = off ? jpegTiffBase(src, off) : null
      return base === null ? null : readTiffExif(src, base)
    }
    return null
  } catch {
    return null
  }
}

export function readPhotoExifFromBuffer(data: Uint8Array, filename = ''): PhotoExif | null {
  return readPhotoExif(new BufferSource(data), filename)
}

export function readPhotoExifFromFile(filePath: string): PhotoExif | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    return readPhotoExif(new FileSource(fd), filePath)
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** "FUJIFILM" + "X100VI" -> "FUJIFILM X100VI"; a model that already names its maker is kept. */
export function cameraName(make?: string, model?: string): string | undefined {
  if (!model) return make
  if (!make) return model
  const brand = make.split(/\s+/)[0].toLowerCase()
  return model.toLowerCase().startsWith(brand) ? model : `${make} ${model}`
}

/** 0.004 -> "1/250", 0.5 -> "1/2", 2 -> "2s", 1.3 -> "1.3s". */
export function formatShutterSpeed(seconds?: number): string | undefined {
  if (seconds === undefined || !(seconds > 0)) return undefined
  if (seconds >= 1) return `${Math.round(seconds * 10) / 10}s`
  return `1/${Math.round(1 / seconds)}`
}

/** The metadata-field updates for a photo's EXIF (keys from `system_fields.ts`). */
export function photoExifMetadata(
  exif: PhotoExif | null,
): { key: string; value: string | number }[] {
  if (!exif) return []
  const updates: { key: string; value: string | number }[] = []
  const camera = cameraName(exif.make, exif.model)
  if (exif.capturedAt) updates.push({ key: 'capture_date', value: exif.capturedAt })
  if (camera) updates.push({ key: 'camera', value: camera })
  if (exif.lensModel) updates.push({ key: 'lens', value: exif.lensModel })
  if (exif.filmSimulation) updates.push({ key: 'film_simulation', value: exif.filmSimulation })
  if (exif.fujiRecipe) updates.push({ key: 'fuji_recipe', value: exif.fujiRecipe })
  if (exif.focalLength) updates.push({ key: 'focal_length', value: exif.focalLength })
  if (exif.fNumber) updates.push({ key: 'aperture', value: exif.fNumber })
  const shutter = formatShutterSpeed(exif.exposureTime)
  if (shutter) updates.push({ key: 'shutter_speed', value: shutter })
  if (exif.iso) updates.push({ key: 'iso', value: exif.iso })
  return updates
}

/** The metadata keys `photoExifMetadata` can write. */
export const PHOTO_EXIF_FIELD_KEYS = [
  'capture_date',
  'camera',
  'lens',
  'film_simulation',
  'fuji_recipe',
  'focal_length',
  'aperture',
  'shutter_speed',
  'iso',
] as const
