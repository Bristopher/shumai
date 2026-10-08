import { AssetStatus, AssetType, prisma } from '@shumai/db'
import type { Prisma } from '@shumai/db'
import type {
  CheckDuplicatesRequest,
  CheckDuplicatesResponse,
  ListDuplicatesResponse,
} from '@shumai/dtos'
import {
  groupDuplicateRows,
  toDuplicateAssetInfo,
  type DuplicateRow,
  type FolderRef,
} from './duplicates-group'

const MAX_ANCESTOR_LOOKUPS = 64

export class DuplicateService {
  constructor(private readonly prismaClient: typeof prisma = prisma) {}

  /** Live, non-symlink files of a project that already have a content hash. */
  private hashedFilesWhere(projectId: string): Prisma.AssetWhereInput {
    return {
      projectId,
      type: AssetType.file,
      isDeleted: false,
      targetId: null,
      status: { notIn: [AssetStatus.trashed, AssetStatus.pending_purge] },
      contentHash: { not: null },
    }
  }

  private async loadFolders(parentIds: (string | null)[]): Promise<Map<string, FolderRef>> {
    const folders = new Map<string, FolderRef>()
    let pending = [...new Set(parentIds.filter((id): id is string => !!id))]
    for (let depth = 0; pending.length > 0 && depth < MAX_ANCESTOR_LOOKUPS; depth++) {
      const rows = await this.prismaClient.asset.findMany({
        where: { id: { in: pending } },
        select: { id: true, name: true, parentId: true, type: true },
      })
      for (const row of rows) folders.set(row.id, row)
      pending = [
        ...new Set(
          rows.map((r) => r.parentId).filter((id): id is string => !!id && !folders.has(id)),
        ),
      ]
    }
    return folders
  }

  private async fetchRows(projectId: string, hashes: string[]): Promise<DuplicateRow[]> {
    const rows = await this.prismaClient.asset.findMany({
      where: { ...this.hashedFilesWhere(projectId), contentHash: { in: hashes } },
      select: {
        id: true,
        name: true,
        parentId: true,
        sizeByte: true,
        createdAt: true,
        contentHash: true,
      },
    })
    return rows.filter((r): r is typeof r & { contentHash: string } => !!r.contentHash)
  }

  /** Lists groups of byte-identical files in a project, biggest wasted space first. */
  async listGroups(projectId: string, limit: number): Promise<ListDuplicatesResponse> {
    const grouped = await this.prismaClient.asset.groupBy({
      by: ['contentHash'],
      where: this.hashedFilesWhere(projectId),
      _count: { _all: true },
      _sum: { sizeByte: true },
      _max: { sizeByte: true },
      having: { contentHash: { _count: { gt: 1 } } },
    })

    const ranked = grouped
      .filter((g): g is typeof g & { contentHash: string } => !!g.contentHash)
      .map((g) => ({
        contentHash: g.contentHash,
        wasted: Number(g._sum.sizeByte ?? 0) - Number(g._max.sizeByte ?? 0),
      }))
      .sort((a, b) => b.wasted - a.wasted || a.contentHash.localeCompare(b.contentHash))

    const selected = ranked.slice(0, limit).map((g) => g.contentHash)
    if (selected.length === 0) return { groups: [], truncated: false }

    const rows = await this.fetchRows(projectId, selected)
    const folders = await this.loadFolders(rows.map((r) => r.parentId))
    return {
      groups: groupDuplicateRows(rows, folders),
      truncated: ranked.length > limit,
    }
  }

  /**
   * For each (size, hash) pair, returns the files already in the project with the same hash and
   * size. Used to warn before uploading a file that already exists.
   */
  async checkHashes(
    projectId: string,
    files: CheckDuplicatesRequest['files'],
  ): Promise<CheckDuplicatesResponse> {
    const sizeByHash = new Map<string, Set<number>>()
    for (const f of files) {
      const sizes = sizeByHash.get(f.contentHash) ?? new Set<number>()
      sizes.add(f.sizeByte)
      sizeByHash.set(f.contentHash, sizes)
    }

    const rows = await this.fetchRows(projectId, [...sizeByHash.keys()])
    const matching = rows.filter((r) => sizeByHash.get(r.contentHash)?.has(Number(r.sizeByte)))
    const folders = await this.loadFolders(matching.map((r) => r.parentId))

    const byHash = new Map<string, DuplicateRow[]>()
    for (const row of matching) {
      const list = byHash.get(row.contentHash) ?? []
      list.push(row)
      byHash.set(row.contentHash, list)
    }

    return {
      matches: [...byHash].map(([contentHash, list]) => ({
        contentHash,
        assets: list
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((r) => toDuplicateAssetInfo(r, folders)),
      })),
    }
  }
}

export const duplicateService = new DuplicateService()
