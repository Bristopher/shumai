/**
 * XMP sidecars: find the photo an `.xmp` belongs to, and tell whether its edits can be rendered.
 *
 * darktable names its sidecars `NAME.EXT.xmp`; Lightroom / Camera Raw uses `NAME.xmp`. Only
 * darktable edits can be rendered outside the editor that made them (through darktable-cli);
 * Lightroom's `crs:` develop settings have no faithful open renderer.
 */
import { RAW_IMAGE_EXTENSIONS } from './mime'

export type XmpEditor = 'darktable' | 'lightroom' | 'unknown'

export interface XmpClassification {
  editor: XmpEditor
  /** True when the sidecar carries develop edits (not just a rating, tags or an empty history). */
  hasEdits: boolean
}

const PREFERRED_PHOTO_EXTENSIONS: readonly string[] = [
  ...RAW_IMAGE_EXTENSIONS,
  '.jpg',
  '.jpeg',
  '.heic',
  '.heif',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
]

export function isXmpSidecar(filename?: string | null): boolean {
  return (filename || '').toLowerCase().endsWith('.xmp')
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

function rank(name: string): number {
  const i = PREFERRED_PHOTO_EXTENSIONS.indexOf(extOf(name))
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

/**
 * Pick the photo a sidecar describes from the names of the files next to it.
 *
 * `NAME.EXT.xmp` matches exactly `NAME.EXT`. `NAME.xmp` matches any `NAME.<photo ext>`, a RAW
 * first (the file Lightroom actually edited), then JPEG/HEIC, then other images. Names compare
 * case-insensitively. Returns the sibling's name as given, or null.
 */
export function pickXmpSource(xmpName: string, siblingNames: readonly string[]): string | null {
  if (!isXmpSidecar(xmpName)) return null
  const inner = xmpName.slice(0, -'.xmp'.length)
  const photos = siblingNames.filter((n) => !isXmpSidecar(n) && rank(n) !== Number.MAX_SAFE_INTEGER)

  if (rank(inner) !== Number.MAX_SAFE_INTEGER) {
    const exact = photos.find((n) => n.toLowerCase() === inner.toLowerCase())
    if (exact) return exact
  }

  const stem = inner.toLowerCase()
  const byStem = photos.filter((n) => n.slice(0, n.lastIndexOf('.')).toLowerCase() === stem)
  if (byStem.length === 0) return null
  return byStem.reduce((best, n) => (rank(n) < rank(best) ? n : best))
}

/** Which editor wrote a sidecar, and whether it holds develop edits. Reads the XMP text only. */
export function classifyXmp(text: string): XmpClassification {
  if (/darktable:xmp_version/.test(text)) {
    const end = /darktable:history_end\s*=\s*"(\d+)"/.exec(text)
    const endTag = /<darktable:history_end>(\d+)<\/darktable:history_end>/.exec(text)
    const n = Number((end ?? endTag)?.[1] ?? 0)
    return { editor: 'darktable', hasEdits: n > 0 }
  }
  if (/crs:|camera-raw-settings/.test(text)) {
    const has =
      /crs:HasSettings\s*=\s*"True"/i.test(text) ||
      /<crs:HasSettings>True<\/crs:HasSettings>/i.test(text)
    return { editor: 'lightroom', hasEdits: has }
  }
  return { editor: 'unknown', hasEdits: false }
}
