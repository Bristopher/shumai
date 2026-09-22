import { prisma } from '@shumai/db'
import { Prisma, AssetType, WorkflowTaskType } from '@shumai/db'
import { AssetService, assetService } from '@shumai/core/src/asset/asset'
import {
  AssetInfo,
  PHOTO_FACETS,
  stackKey,
  type FileTypeCount,
  type PhotoFacet,
  type PhotoFacets,
} from '@shumai/dtos'
import { SearchRequest } from '@shumai/dtos'
import { PaginatedData, decodeCursor, encodeCursor, PageInfo } from '@shumai/core/src/pagination'
import { generateSearchNgrams } from '@shumai/core/src/utils/ngram'
import { workflowService } from '@shumai/workflow-core'
import { HTTPException } from 'hono/http-exception'
import {
  CAPTURE_DATE_SQL,
  STACK_KEY_SQL,
  STACK_RANK_SQL,
  SqlQueryBuilder,
} from './sql-query-builder'

export class SearchService {
  constructor(
    private readonly prismaClient: typeof prisma = prisma,
    private readonly assetSvc: AssetService = assetService,
  ) {}

  async search(folderId: string, req: SearchRequest): Promise<PaginatedData<AssetInfo[]>> {
    const targetFolderIds =
      req.recursively === false ? [folderId] : await this.assetSvc.getDescendantFolderIds(folderId)

    const targetTypes =
      req.assetType === 'folder' ? [AssetType.folder] : [AssetType.file, AssetType.version_stack]

    // ----------------------------------------------------------------------
    // AI Semantic search
    // ----------------------------------------------------------------------
    if (req.query && req.isSemantic) {
      // 1. Check if embedding agent exists and is enabled
      const team = await this.prismaClient.asset.findUnique({
        where: { id: folderId },
        select: { project: { select: { teamId: true } } },
      })
      const teamId = team?.project?.teamId
      if (!teamId) throw new Error('Team ID not found for folder')

      const embeddingAgent = await this.prismaClient.agent.findFirst({
        where: { teamId, type: 'embedding', enabled: true },
      })

      if (!embeddingAgent) {
        throw new HTTPException(422, {
          message: 'Embedding agent not configured or disabled for this team.',
        })
      }

      // 2. Generate query embedding via workflow
      const task = await this.prismaClient.workflowTask.create({
        data: {
          type: WorkflowTaskType.query_embedding_for_search,
          teamId,
          assetId: folderId,
          payload: {
            projectId: '',
            queryEmbeddingForSearch: { text: req.query },
          } as PrismaJson.WorkflowTaskPayload,
          status: 'pending',
        },
      })

      const completedTask = await workflowService.executeWait(task)
      const output = completedTask.output as Record<string, unknown> | null
      const queryVector = output?.embedding as number[] | undefined

      if (!queryVector) {
        throw new Error('Failed to generate query embedding')
      }

      // 3. Construct raw SQL using SqlQueryBuilder
      const vectorJson = JSON.stringify(queryVector)
      const builder = new SqlQueryBuilder()
        .select(
          Prisma.sql`a.id as "assetId", ae.start_time as "startTime", ae.end_time as "endTime", (ae.embedding <=> ${vectorJson}::vector) as "distance"`,
        )
        .from(Prisma.sql`assets a JOIN asset_embeddings ae ON a.id = ae.asset_id`)
        .addWhere(Prisma.sql`a.is_deleted = false`)

      if (targetFolderIds.length > 0) {
        builder.addWhere(Prisma.sql`a.parent_id = ANY(${targetFolderIds})`)
      }

      if (req.showSymlink) {
        builder.addWhere(Prisma.sql`
          (a.type = ANY(${targetTypes}::"AssetType"[]) OR (a.type = 'symlink' AND a.target_id IN (SELECT id FROM assets WHERE type = ANY(${targetTypes}::"AssetType"[]))))
        `)
      } else {
        builder.addWhere(Prisma.sql`a.type = ANY(${targetTypes}::"AssetType"[])`)
      }

      if (req.conditions && req.conditions.length > 0) {
        builder.addSearchConditions(req.operator, req.conditions, { skipNameContains: true })
      }

      if (req.assetType !== 'folder') {
        builder.addFileTypeFilter(req.fileTypes).addPhotoFilter(req.photo)
      }

      const nameCond = req.conditions?.find((c) => c.field === 'name' && c.operator === 'contains')
      if (nameCond) {
        const valStr = String(nameCond.value)
        const ngrams = generateSearchNgrams(valStr)

        if (ngrams.length > 0) {
          builder.addWhere(Prisma.sql`a.name_ngram @> ${ngrams}::text[]`)
          builder.addWhere(Prisma.sql`a.name ILIKE ${'%' + valStr + '%'}`)
        } else {
          builder.addWhere(Prisma.sql`a.name ILIKE ${'%' + valStr + '%'}`)
        }
      }

      builder.orderBy(Prisma.sql`distance ASC`)

      // 4. Paginate in SQL using limit/offset
      let limit = req.first || 20
      if (limit <= 0 || limit > 200) {
        limit = 20
      }

      let offset = 0
      if (req.after) {
        offset = decodeCursor(req.after)
      }

      builder.limit(limit + 1).offset(offset)

      // 5. Execute raw SQL query
      const query = builder.build()
      const semanticMatches = await this.prismaClient.$queryRaw<
        {
          assetId: string
          startTime: number | null
          endTime: number | null
          distance: number
        }[]
      >(query)

      const hasNextPage = semanticMatches.length > limit
      const finalMatches = hasNextPage ? semanticMatches.slice(0, limit) : semanticMatches

      // 6. Map back to full rich metadata and return time-based duplicate segments
      const uniqueIds = Array.from(new Set(finalMatches.map((m) => m.assetId)))
      const fetchedInfos = await this.assetSvc.listAssetsByIds(uniqueIds, req.previewFormat)
      const assetInfosMap = new Map<string, AssetInfo>()
      for (const info of fetchedInfos) {
        assetInfosMap.set(info.id, info)
      }

      const data: AssetInfo[] = []
      for (const match of finalMatches) {
        const baseInfo = assetInfosMap.get(match.assetId)
        if (baseInfo) {
          data.push({
            ...baseInfo,
            startTime: match.startTime,
            endTime: match.endTime,
          })
        }
      }

      const pageInfo: PageInfo = {}
      const countBuilder = new SqlQueryBuilder()
        .select(Prisma.sql`COUNT(*)`)
        .from(Prisma.sql`assets a JOIN asset_embeddings ae ON a.id = ae.asset_id`)
        .addWhere(Prisma.sql`a.is_deleted = false`)

      if (targetFolderIds.length > 0) {
        countBuilder.addWhere(Prisma.sql`a.parent_id = ANY(${targetFolderIds})`)
      }
      if (req.showSymlink) {
        countBuilder.addWhere(Prisma.sql`
          (a.type = ANY(${targetTypes}::"AssetType"[]) OR (a.type = 'symlink' AND a.target_id IN (SELECT id FROM assets WHERE type = ANY(${targetTypes}::"AssetType"[]))))
        `)
      } else {
        countBuilder.addWhere(Prisma.sql`a.type = ANY(${targetTypes}::"AssetType"[])`)
      }

      if (req.conditions && req.conditions.length > 0) {
        countBuilder.addSearchConditions(req.operator, req.conditions, { skipNameContains: true })
      }

      if (req.assetType !== 'folder') {
        countBuilder.addFileTypeFilter(req.fileTypes).addPhotoFilter(req.photo)
      }

      if (nameCond) {
        const valStr = String(nameCond.value)
        const ngrams = generateSearchNgrams(valStr)
        if (ngrams.length > 0) {
          countBuilder.addWhere(Prisma.sql`a.name_ngram @> ${ngrams}::text[]`)
          countBuilder.addWhere(Prisma.sql`a.name ILIKE ${'%' + valStr + '%'}`)
        } else {
          countBuilder.addWhere(Prisma.sql`a.name ILIKE ${'%' + valStr + '%'}`)
        }
      }

      const countRes = await this.prismaClient.$queryRaw<{ count: bigint }[]>(countBuilder.build())
      const totalCount = Number(countRes[0]?.count || 0)
      pageInfo.total = totalCount

      if (totalCount < 2000) {
        countBuilder.select(Prisma.sql`SUM(COALESCE(a.size_byte, 0))::bigint as sum`)
        const sumRes = await this.prismaClient.$queryRaw<{ sum: bigint | null }[]>(
          countBuilder.build(),
        )
        pageInfo.totalSize = Number(sumRes[0]?.sum || 0)
      } else {
        pageInfo.totalSize = -1
      }

      if (hasNextPage) {
        pageInfo.cursor = encodeCursor(offset + limit)
      }

      return { data, pageInfo }
    }

    // ----------------------------------------------------------------------
    // Non-semantic search (using SqlQueryBuilder)
    // ----------------------------------------------------------------------
    const stacked = !!req.stack && req.assetType !== 'folder'
    const builder = new SqlQueryBuilder()
      .select(Prisma.sql`a.id as "assetId"`)
      .from(Prisma.sql`assets a`)
      .addWhere(Prisma.sql`a.is_deleted = false`)

    if (targetFolderIds.length > 0) {
      builder.addWhere(Prisma.sql`a.parent_id = ANY(${targetFolderIds})`)
    }

    if (req.showSymlink) {
      builder.addWhere(Prisma.sql`
        (a.type = ANY(${targetTypes}::"AssetType"[]) OR (a.type = 'symlink' AND a.target_id IN (SELECT id FROM assets WHERE type = ANY(${targetTypes}::"AssetType"[]))))
      `)
    } else {
      builder.addWhere(Prisma.sql`a.type = ANY(${targetTypes}::"AssetType"[])`)
    }

    if (req.conditions && req.conditions.length > 0) {
      builder.addSearchConditions(req.operator, req.conditions, { skipNameContains: true })
    }

    if (req.assetType !== 'folder') {
      builder.addFileTypeFilter(req.fileTypes).addPhotoFilter(req.photo).stackByBaseName(stacked)
    }
    if (stacked) {
      builder.select(
        Prisma.sql`a.id as "assetId", a.stack_count as "stackCount", a.parent_id as "parentId", ${STACK_KEY_SQL} as "stackKey"`,
      )
    }

    // name contains n-grams / Switching Search Optimization
    let countOverride: number | undefined
    let useNgram = false
    let valStr = ''
    let ngrams: string[] = []

    const nameCond = req.conditions?.find((c) => c.field === 'name' && c.operator === 'contains')

    if (nameCond) {
      valStr = String(nameCond.value)
      ngrams = generateSearchNgrams(valStr)

      if (ngrams.length > 0) {
        const PROBE_LIMIT = 10001

        // Build SQL probe query to limit and fetch selective IDs
        const probeBuilder = new SqlQueryBuilder()
          .select(Prisma.sql`a.id`)
          .from(Prisma.sql`assets a`)
          .addWhere(Prisma.sql`a.is_deleted = false`)

        if (targetFolderIds.length > 0) {
          probeBuilder.addWhere(Prisma.sql`a.parent_id = ANY(${targetFolderIds})`)
        }

        if (req.showSymlink) {
          probeBuilder.addWhere(Prisma.sql`
            (a.type = ANY(${targetTypes}::"AssetType"[]) OR (a.type = 'symlink' AND a.target_id IN (SELECT id FROM assets WHERE type = ANY(${targetTypes}::"AssetType"[]))))
          `)
        } else {
          probeBuilder.addWhere(Prisma.sql`a.type = ANY(${targetTypes}::"AssetType"[])`)
        }

        if (req.conditions && req.conditions.length > 0) {
          probeBuilder.addSearchConditions(req.operator, req.conditions, { skipNameContains: true })
        }

        if (req.assetType !== 'folder') {
          probeBuilder
            .addFileTypeFilter(req.fileTypes)
            .addPhotoFilter(req.photo)
            .stackByBaseName(stacked)
        }

        probeBuilder.addWhere(Prisma.sql`a.name_ngram @> ${ngrams}::text[]`)
        probeBuilder.addWhere(Prisma.sql`a.name ILIKE ${'%' + valStr + '%'}`)
        probeBuilder.limit(PROBE_LIMIT)

        const probeMatches = await this.prismaClient.$queryRaw<{ id: string }[]>(
          probeBuilder.build(),
        )
        const probeCount = probeMatches.length

        if (probeCount < PROBE_LIMIT) {
          useNgram = true
          countOverride = probeCount
        } else {
          countOverride = PROBE_LIMIT
        }
      }
    }

    if (nameCond) {
      if (useNgram && ngrams.length > 0) {
        builder.addWhere(Prisma.sql`a.name_ngram @> ${ngrams}::text[]`)
        builder.addWhere(Prisma.sql`a.name ILIKE ${'%' + valStr + '%'}`)
      } else {
        builder.addWhere(Prisma.sql`a.name ILIKE ${'%' + valStr + '%'}`)
      }
    }

    // Sorting
    let orderSql = Prisma.sql`a.sort_index ASC`
    if (req.sort) {
      const direction = req.sort.order === 'desc' ? Prisma.raw('DESC') : Prisma.raw('ASC')
      if (req.sort.field === 'custom') {
        orderSql = Prisma.sql`a.sort_index ASC`
      } else if (req.sort.field === 'name') {
        orderSql = Prisma.sql`a.name ${direction}`
      } else if (req.sort.field === 'created_at' || req.sort.field === 'createdAt') {
        orderSql = Prisma.sql`a.created_at ${direction}`
      } else if (req.sort.field === 'size_byte' || req.sort.field === 'sizeByte') {
        orderSql = Prisma.sql`a.size_byte ${direction}`
      } else if (req.sort.field === 'captureDate' || req.sort.field === 'capture_date') {
        // Files without a date taken go last; ties keep a stable order for offset pagination.
        orderSql = Prisma.sql`${CAPTURE_DATE_SQL} ${direction} NULLS LAST, a.name ${direction}, a.id ASC`
      } else {
        orderSql = Prisma.sql`a.id DESC`
      }
    }
    builder.orderBy(orderSql)

    // Paginate in SQL using limit/offset
    let limit = req.first || 20
    if (limit <= 0 || limit > 200) {
      limit = 20
    }

    let offset = 0
    if (req.after) {
      offset = decodeCursor(req.after)
    }

    builder.limit(limit + 1).offset(offset)

    // Execute raw SQL query
    const query = builder.build()
    const matches =
      await this.prismaClient.$queryRaw<
        { assetId: string; stackCount?: bigint; parentId?: string | null; stackKey?: string }[]
      >(query)

    const hasNextPage = matches.length > limit
    const finalMatches = hasNextPage ? matches.slice(0, limit) : matches

    // Map back to full rich metadata
    const uniqueIds = Array.from(new Set(finalMatches.map((m) => m.assetId)))
    const fetchedInfos = await this.assetSvc.listAssetsByIds(uniqueIds, req.previewFormat)
    const assetInfosMap = new Map<string, AssetInfo>()
    for (const info of fetchedInfos) {
      assetInfosMap.set(info.id, info)
    }

    const stacks = stacked ? await this.loadStackMembers(finalMatches, req) : new Map()

    const data: AssetInfo[] = []
    for (const match of finalMatches) {
      const baseInfo = assetInfosMap.get(match.assetId)
      if (baseInfo) {
        const members = stacks.get(match.assetId)
        data.push(members ? { ...baseInfo, stack: { count: members.length, members } } : baseInfo)
      }
    }

    const pageInfo: PageInfo = {}
    let totalCount = countOverride
    if (totalCount === undefined) {
      const countBuilder = new SqlQueryBuilder()
        .select(Prisma.sql`COUNT(*)`)
        .from(Prisma.sql`assets a`)
        .addWhere(Prisma.sql`a.is_deleted = false`)

      if (targetFolderIds.length > 0) {
        countBuilder.addWhere(Prisma.sql`a.parent_id = ANY(${targetFolderIds})`)
      }

      if (req.showSymlink) {
        countBuilder.addWhere(Prisma.sql`
          (a.type = ANY(${targetTypes}::"AssetType"[]) OR (a.type = 'symlink' AND a.target_id IN (SELECT id FROM assets WHERE type = ANY(${targetTypes}::"AssetType"[]))))
        `)
      } else {
        countBuilder.addWhere(Prisma.sql`a.type = ANY(${targetTypes}::"AssetType"[])`)
      }

      if (req.conditions && req.conditions.length > 0) {
        countBuilder.addSearchConditions(req.operator, req.conditions, { skipNameContains: true })
      }

      if (req.assetType !== 'folder') {
        countBuilder
          .addFileTypeFilter(req.fileTypes)
          .addPhotoFilter(req.photo)
          .stackByBaseName(stacked)
      }

      if (nameCond) {
        countBuilder.addWhere(Prisma.sql`a.name ILIKE ${'%' + valStr + '%'}`)
      }

      const countRes = await this.prismaClient.$queryRaw<{ count: bigint }[]>(countBuilder.build())
      totalCount = Number(countRes[0]?.count || 0)
      pageInfo.total = totalCount

      if (totalCount < 2000) {
        countBuilder.select(
          stacked
            ? Prisma.sql`SUM(a.stack_size)::bigint as sum`
            : Prisma.sql`SUM(COALESCE(a.size_byte, 0))::bigint as sum`,
        )
        const sumRes = await this.prismaClient.$queryRaw<{ sum: bigint | null }[]>(
          countBuilder.build(),
        )
        pageInfo.totalSize = Number(sumRes[0]?.sum || 0)
      } else {
        pageInfo.totalSize = -1
      }
    } else {
      pageInfo.total = totalCount
      if (totalCount < 2000) {
        const countBuilder = new SqlQueryBuilder()
          .select(
            stacked
              ? Prisma.sql`SUM(a.stack_size)::bigint as sum`
              : Prisma.sql`SUM(COALESCE(a.size_byte, 0))::bigint as sum`,
          )
          .from(Prisma.sql`assets a`)
          .addWhere(Prisma.sql`a.is_deleted = false`)

        if (targetFolderIds.length > 0) {
          countBuilder.addWhere(Prisma.sql`a.parent_id = ANY(${targetFolderIds})`)
        }

        if (req.showSymlink) {
          countBuilder.addWhere(Prisma.sql`
            (a.type = ANY(${targetTypes}::"AssetType"[]) OR (a.type = 'symlink' AND a.target_id IN (SELECT id FROM assets WHERE type = ANY(${targetTypes}::"AssetType"[]))))
          `)
        } else {
          countBuilder.addWhere(Prisma.sql`a.type = ANY(${targetTypes}::"AssetType"[])`)
        }

        if (req.conditions && req.conditions.length > 0) {
          countBuilder.addSearchConditions(req.operator, req.conditions, { skipNameContains: true })
        }

        if (req.assetType !== 'folder') {
          countBuilder
            .addFileTypeFilter(req.fileTypes)
            .addPhotoFilter(req.photo)
            .stackByBaseName(stacked)
        }

        if (nameCond) {
          countBuilder.addWhere(Prisma.sql`a.name ILIKE ${'%' + valStr + '%'}`)
        }

        const sumRes = await this.prismaClient.$queryRaw<{ sum: bigint | null }[]>(
          countBuilder.build(),
        )
        pageInfo.totalSize = Number(sumRes[0]?.sum || 0)
      } else {
        pageInfo.totalSize = -1
      }
    }

    if (hasNextPage) {
      pageInfo.cursor = encodeCursor(offset + limit)
    }

    return { data, pageInfo }
  }

  /**
   * The files of each stacked row that has more than one, keyed by the shown file's id. Members
   * pass the same file-type and camera filters as the listing, so a hidden sidecar stays hidden.
   */
  private async loadStackMembers(
    rows: { assetId: string; stackCount?: bigint; parentId?: string | null; stackKey?: string }[],
    req: SearchRequest,
  ): Promise<Map<string, { id: string; name: string }[]>> {
    const multi = rows.filter((r) => Number(r.stackCount ?? 1) > 1 && r.parentId && r.stackKey)
    const out = new Map<string, { id: string; name: string }[]>()
    if (multi.length === 0) return out

    const types = [AssetType.file, AssetType.version_stack]
    const builder = new SqlQueryBuilder()
      .select(Prisma.sql`a.id, a.name, a.parent_id as "parentId", ${STACK_KEY_SQL} as "stackKey"`)
      .from(Prisma.sql`assets a`)
      .addWhere(Prisma.sql`a.is_deleted = false`)
      .addWhere(Prisma.sql`a.type = ANY(${types}::"AssetType"[])`)
      .addWhere(Prisma.sql`a.parent_id = ANY(${multi.map((r) => r.parentId!)})`)
      .addWhere(Prisma.sql`${STACK_KEY_SQL} = ANY(${multi.map((r) => r.stackKey!)}::text[])`)
      .addFileTypeFilter(req.fileTypes)
      .addPhotoFilter(req.photo)
      .orderBy(Prisma.sql`${STACK_RANK_SQL}, a.name ASC, a.id ASC`)
    const members = await this.prismaClient.$queryRaw<
      { id: string; name: string; parentId: string; stackKey: string }[]
    >(builder.build())

    const byGroup = new Map<string, { id: string; name: string }[]>()
    for (const m of members) {
      const group = `${m.parentId}/${m.stackKey}`
      const list = byGroup.get(group) ?? []
      list.push({ id: m.id, name: m.name })
      byGroup.set(group, list)
    }
    for (const r of multi) {
      const list = byGroup.get(`${r.parentId}/${r.stackKey}`)
      if (list && list.length > 1) out.set(r.assetId, list)
    }
    return out
  }

  /**
   * The files that share `assetId`'s folder and base name (its shot: DSCF5543.JPG, .RAF,
   * .RAF.xmp), itself included, in display order. Empty when the asset does not exist.
   */
  async stackMembersOf(assetId: string): Promise<{ id: string; name: string }[]> {
    const asset = await this.prismaClient.asset.findUnique({
      where: { id: assetId },
      select: { parentId: true, name: true },
    })
    if (!asset?.parentId) return []
    const types = [AssetType.file, AssetType.version_stack]
    const builder = new SqlQueryBuilder()
      .select(Prisma.sql`a.id, a.name`)
      .from(Prisma.sql`assets a`)
      .addWhere(Prisma.sql`a.is_deleted = false`)
      .addWhere(Prisma.sql`a.type = ANY(${types}::"AssetType"[])`)
      .addWhere(Prisma.sql`a.parent_id = ${asset.parentId}`)
      .addWhere(Prisma.sql`${STACK_KEY_SQL} = ${stackKey(asset.name)}`)
      .orderBy(Prisma.sql`${STACK_RANK_SQL}, a.name ASC, a.id ASC`)
      .limit(50)
    return this.prismaClient.$queryRaw<{ id: string; name: string }[]>(builder.build())
  }

  /**
   * The camera, lens and film simulation values in a folder, with how many shots (files stacked
   * by base name) carry each, most common first. Feeds the camera filter's choices.
   */
  async photoFacets(folderId: string, recursively = false): Promise<PhotoFacets> {
    const folderIds = recursively
      ? await this.assetSvc.getDescendantFolderIds(folderId)
      : [folderId]
    const types = [AssetType.file, AssetType.version_stack]
    const facetByKey = new Map<string, PhotoFacet>(
      (Object.entries(PHOTO_FACETS) as [PhotoFacet, string][]).map(([facet, key]) => [key, facet]),
    )
    const rows = await this.prismaClient.$queryRaw<
      Array<{ key: string; value: string; count: bigint }>
    >(Prisma.sql`
      SELECT v.field_key AS key, v.string_value AS value,
        count(DISTINCT (a.parent_id, ${STACK_KEY_SQL})) AS count
      FROM asset_metadata_values v
      JOIN assets a ON a.id = v.asset_id
      WHERE a.is_deleted = false
        AND a.parent_id = ANY(${folderIds})
        AND a.type = ANY(${types}::"AssetType"[])
        AND v.field_key = ANY(${[...facetByKey.keys()]}::text[])
        AND v.string_value IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 3 DESC, 2 ASC
      LIMIT 300
    `)
    const facets: PhotoFacets = { camera: [], lens: [], filmSimulation: [], fujiRecipe: [] }
    for (const r of rows) {
      const facet = facetByKey.get(r.key)
      if (facet) facets[facet].push({ value: r.value, count: Number(r.count) })
    }
    return facets
  }

  /**
   * How many files of each extension a folder holds (lowercase, "" for none), most common
   * first. Feeds the file-type filter's list of choices.
   */
  async fileTypeCounts(folderId: string, recursively = false): Promise<FileTypeCount[]> {
    const folderIds = recursively
      ? await this.assetSvc.getDescendantFolderIds(folderId)
      : [folderId]
    const fileTypes = [AssetType.file, AssetType.version_stack]
    const rows = await this.prismaClient.$queryRaw<
      Array<{ extension: string | null; count: bigint }>
    >(Prisma.sql`
      SELECT lower(substring(a.name from '\\.([^.]+)$')) AS extension, count(*) AS count
      FROM assets a
      WHERE a.is_deleted = false
        AND a.parent_id = ANY(${folderIds})
        AND a.type = ANY(${fileTypes}::"AssetType"[])
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC
      LIMIT 100
    `)
    return rows.map((r) => ({ extension: r.extension ?? '', count: Number(r.count) }))
  }
}

export const searchService = new SearchService()
