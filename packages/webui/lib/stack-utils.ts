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
