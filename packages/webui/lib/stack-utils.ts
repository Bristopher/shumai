import type { AssetInfo } from '@shumai/dtos'

/**
 * The ids an action on `items` should touch: a stacked card (Stack on in the toolbar) stands for
 * every file of its shot, so deleting, moving or downloading it covers them all.
 */
export function expandStackIds(items: Pick<AssetInfo, 'id' | 'stack'>[]): string[] {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.stack?.members.length) {
      for (const member of item.stack.members) ids.add(member.id)
    }
    ids.add(item.id)
  }
  return [...ids]
}

/** True when the item is a stacked card standing for more than one file. */
export function isStacked(item: Pick<AssetInfo, 'stack'>): boolean {
  return (item.stack?.members.length ?? 0) > 1
}

/**
 * The file ids to delete: plain items as they are, and for stacked cards only the members the
 * user ticked in the delete dialog (`selected`).
 */
export function stackDeleteIds(
  items: Pick<AssetInfo, 'id' | 'stack'>[],
  selected: ReadonlySet<string>,
): string[] {
  const ids = new Set<string>()
  for (const item of items) {
    if (isStacked(item)) {
      for (const member of item.stack!.members) if (selected.has(member.id)) ids.add(member.id)
    } else {
      ids.add(item.id)
    }
  }
  return [...ids]
}
