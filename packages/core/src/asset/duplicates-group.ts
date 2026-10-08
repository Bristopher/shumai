import type { DuplicateAssetInfo, DuplicateGroup } from '@shumai/dtos'

export interface DuplicateRow {
  id: string
  name: string
  parentId: string | null
  sizeByte: bigint | number
  createdAt: Date
  contentHash: string
}

export interface FolderRef {
  id: string
  name: string
  parentId: string | null
  type: string
}

const MAX_PATH_DEPTH = 64

/**
 * Builds the folder path (without the file name) from the nearest folder up to the project root.
 * The project root folder is left out so paths read relative to the project.
 */
export function buildFolderPath(parentId: string | null, folders: Map<string, FolderRef>): string {
  const parts: string[] = []
  const seen = new Set<string>()
  let current = parentId
  while (current && parts.length < MAX_PATH_DEPTH && !seen.has(current)) {
    seen.add(current)
    const folder = folders.get(current)
    if (!folder) break
    if (folder.type !== 'root') parts.push(folder.name)
    current = folder.parentId
  }
  return parts.reverse().join('/')
}

export function toDuplicateAssetInfo(
  row: DuplicateRow,
  folders: Map<string, FolderRef>,
): DuplicateAssetInfo {
  return {
    id: row.id,
    name: row.name,
    path: buildFolderPath(row.parentId, folders),
    parentId: row.parentId,
    sizeByte: Number(row.sizeByte),
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Groups rows by content hash, drops hashes seen only once, orders each group oldest first (the
 * oldest copy is the natural one to keep) and orders groups by the space they waste, largest first.
 */
export function groupDuplicateRows(
  rows: DuplicateRow[],
  folders: Map<string, FolderRef>,
): DuplicateGroup[] {
  const byHash = new Map<string, DuplicateRow[]>()
  for (const row of rows) {
    const list = byHash.get(row.contentHash)
    if (list) list.push(row)
    else byHash.set(row.contentHash, [row])
  }

  const groups: DuplicateGroup[] = []
  for (const [contentHash, list] of byHash) {
    if (list.length < 2) continue
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    const sizes = list.map((r) => Number(r.sizeByte))
    const total = sizes.reduce((sum, s) => sum + s, 0)
    const largest = Math.max(...sizes)
    groups.push({
      contentHash,
      sizeByte: largest,
      count: list.length,
      wastedBytes: total - largest,
      assets: list.map((r) => toDuplicateAssetInfo(r, folders)),
    })
  }

  groups.sort((a, b) => b.wastedBytes - a.wastedBytes || a.contentHash.localeCompare(b.contentHash))
  return groups
}
