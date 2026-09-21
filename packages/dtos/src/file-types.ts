import { z } from 'zod'

/**
 * File-type filtering for the file browser. A filter names extensions ("jpg", "raf") and/or
 * groups ("group:raw"); the server expands groups and matches the file name's last extension,
 * case-insensitively.
 */
export const FILE_TYPE_GROUPS = {
  /** Camera RAW formats. */
  raw: [
    'raf',
    'arw',
    'srf',
    'sr2',
    'dng',
    'cr2',
    'cr3',
    'crw',
    'nef',
    'nrw',
    'orf',
    'rw2',
    'pef',
    'srw',
    'x3f',
    '3fr',
    'iiq',
    'rwl',
  ],
  jpeg: ['jpg', 'jpeg'],
  heif: ['heic', 'heif', 'hif'],
  video: ['mov', 'mp4', 'm4v', 'mkv', 'avi', 'mts', 'm2ts', 'mxf', 'webm'],
  /**
   * Editing and sidecar files: XMP (Lightroom, darktable, Camera Raw), RawTherapee .pp3, DxO
   * .dop, Capture One .cos/.cop/.cot/.cof/.comask, ON1 .on1, Affinity/ACDSee .acr, Luminar .arp.
   */
  editing: ['xmp', 'pp3', 'dop', 'cos', 'cop', 'cot', 'cof', 'comask', 'on1', 'acr', 'arp'],
} as const satisfies Record<string, readonly string[]>

export type FileTypeGroup = keyof typeof FILE_TYPE_GROUPS

export const FILE_TYPE_GROUP_PREFIX = 'group:'

const fileTypeTokenSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(group:[a-z]+|[a-z0-9]{1,10})$/,
    'expected an extension like "jpg" or a group like "group:raw"',
  )

export const fileTypeFilterSchema = z.object({
  /** Show only files whose extension is in this list (extensions and/or groups). */
  include: z.array(fileTypeTokenSchema).max(64).optional(),
  /** Hide files whose extension is in this list (extensions and/or groups). */
  exclude: z.array(fileTypeTokenSchema).max(64).optional(),
})
export type FileTypeFilter = z.infer<typeof fileTypeFilterSchema>

/** Expand groups into their extensions; drop unknown groups; de-duplicate. Lowercase output. */
export function expandFileTypes(tokens: readonly string[] | undefined): string[] {
  const out = new Set<string>()
  for (const raw of tokens ?? []) {
    const t = raw.trim().toLowerCase().replace(/^\./, '')
    if (t.startsWith(FILE_TYPE_GROUP_PREFIX)) {
      const group = t.slice(FILE_TYPE_GROUP_PREFIX.length) as FileTypeGroup
      for (const ext of FILE_TYPE_GROUPS[group] ?? []) out.add(ext)
    } else if (t) {
      out.add(t)
    }
  }
  return [...out]
}

/** True when the filter would change the listing. */
export function isFileTypeFilterActive(filter: FileTypeFilter | undefined): boolean {
  return !!filter && ((filter.include?.length ?? 0) > 0 || (filter.exclude?.length ?? 0) > 0)
}

/** The last extension of a file name, lowercase and without the dot ("" when there is none). */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

export const fileTypeCountSchema = z.object({
  extension: z.string(),
  count: z.number(),
})
export type FileTypeCount = z.infer<typeof fileTypeCountSchema>
