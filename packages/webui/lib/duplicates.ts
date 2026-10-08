import type { DuplicateGroup } from '@shumai/dtos'

/** Ids of every copy except the oldest one in each group (groups arrive oldest first). */
export function selectExtraCopies(groups: DuplicateGroup[]): Set<string> {
  const ids = new Set<string>()
  for (const group of groups) {
    for (const asset of group.assets.slice(1)) ids.add(asset.id)
  }
  return ids
}

/** True when every copy of at least one group is selected, which would delete the file entirely. */
export function selectionRemovesAllCopies(
  groups: DuplicateGroup[],
  selected: Set<string>,
): boolean {
  return groups.some((g) => g.assets.length > 0 && g.assets.every((a) => selected.has(a.id)))
}

/** Total size of the selected copies. */
export function selectedBytes(groups: DuplicateGroup[], selected: Set<string>): number {
  let total = 0
  for (const group of groups) {
    for (const asset of group.assets) {
      if (selected.has(asset.id)) total += asset.sizeByte
    }
  }
  return total
}

/** Drops ids that are no longer listed, for example after a refetch following a delete. */
export function pruneSelection(groups: DuplicateGroup[], selected: Set<string>): Set<string> {
  const live = new Set(groups.flatMap((g) => g.assets.map((a) => a.id)))
  return new Set([...selected].filter((id) => live.has(id)))
}
