import { prisma, Prisma } from '@shumai/db'
import { logger } from '@shumai/core/src/logger'
import { s3Service } from '@shumai/core/src/s3/s3'

/**
 * Storage catalog: a self-describing copy of the library kept in storage next to the files.
 *
 * Database triggers (migration add_storage_catalog_queue) put the id of every changed asset, project and
 * metadata field into storage_catalog_queue. This service drains that queue every few seconds and writes one
 * small JSON record per object under catalog/, or deletes the record once the object is gone. If the
 * database is ever lost, scripts/restore-from-catalog.ts rebuilds the folders, files, tags and trash state
 * from these records and the files already in storage.
 *
 * Records point at their parent by id rather than holding a path, so renaming or moving a folder rewrites
 * one record, not one per file below it.
 */

export const CATALOG_PREFIX = 'catalog/'
export const CATALOG_RECORD_VERSION = 1

const SYNC_INTERVAL_MS = 5000
const SYNC_BATCH_SIZE = 500
const WRITE_CONCURRENCY = 16
/** Queue row that exists while the catalog is complete; removed whenever the feature is switched off. */
const COMPLETE_SENTINEL = 'catalog:complete'

const PROJECT_PREFIX = 'project:'
const FIELD_PREFIX = 'field:'

export function storageCatalogEnabled(): boolean {
  return process.env.STORAGE_CATALOG_ENABLED === 'true'
}

function bucket(): string {
  return process.env.S3_BUCKET || 'shumai'
}

/** Storage key of the catalog record for a queue id. */
export function catalogRecordKey(queueId: string): string {
  if (queueId.startsWith(PROJECT_PREFIX)) {
    return `${CATALOG_PREFIX}projects/${queueId.slice(PROJECT_PREFIX.length)}.json`
  }
  if (queueId.startsWith(FIELD_PREFIX)) {
    return `${CATALOG_PREFIX}metadata-fields/${encodeURIComponent(queueId.slice(FIELD_PREFIX.length))}.json`
  }
  return `${CATALOG_PREFIX}assets/${queueId}.json`
}

export interface CatalogMetadataValue {
  stringValue?: string
  numberValue?: number
  booleanValue?: boolean
  jsonValue?: unknown
  dateValue?: string
}

export interface CatalogAssetRecord {
  v: number
  kind: 'asset'
  id: string
  type: string
  name: string
  status: string
  parentId: string | null
  projectId: string | null
  targetId: string | null
  sortIndex: string | null
  storageKey: string | null
  mediaType: string | null
  sizeByte: string
  fileCount: number
  hasJpegPreview: boolean
  isDeleted: boolean
  deletedAt: string | null
  creatorId: string | null
  createdAt: string
  updatedAt: string
  metadata: Record<string, CatalogMetadataValue>
}

export interface CatalogProjectRecord {
  v: number
  kind: 'project'
  id: string
  name: string
  teamId: string
  rootFolderId: string | null
  shareRootId: string | null
  metadataOverrides: unknown
  createdAt: string
}

export interface CatalogFieldRecord {
  v: number
  kind: 'metadataField'
  id: string
  key: string
  scope: string | null
  config: unknown
  readOnly: boolean
  description: string
  teamId: string | null
  projectId: string | null
}

export type CatalogRecord = CatalogAssetRecord | CatalogProjectRecord | CatalogFieldRecord

type Write = { key: string; body: string | null; queueId: string }

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

export class StorageCatalogService {
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private syncRunning = false
  private completeMarkerCleared = false

  startCatalogSync(intervalMs = SYNC_INTERVAL_MS) {
    if (this.syncRunning) return
    this.syncRunning = true
    const run = async () => {
      if (!this.syncRunning) return
      try {
        let processed = 0
        do {
          processed = await this.syncOnce()
        } while (processed === SYNC_BATCH_SIZE && this.syncRunning)
      } catch (err) {
        logger.error({ err }, 'Storage catalog sync failed')
      }
      if (this.syncRunning) this.syncTimer = setTimeout(run, intervalMs)
    }
    this.syncTimer = setTimeout(run, 0)
  }

  stopCatalogSync() {
    this.syncRunning = false
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = null
  }

  /**
   * One pass: make sure the catalog has been backfilled, then mirror up to one batch of queued changes into
   * storage. When the feature is off the batch is only discarded, so the queue never grows. Returns the
   * number of queue rows taken.
   */
  async syncOnce(): Promise<number> {
    if (!storageCatalogEnabled()) {
      // Changes made while the catalog is off are not recorded, so it must be rebuilt when switched on.
      if (!this.completeMarkerCleared) {
        await prisma.storageCatalogQueue.deleteMany({ where: { id: COMPLETE_SENTINEL } })
        this.completeMarkerCleared = true
      }
      return (await this.claimBatch()).length
    }
    this.completeMarkerCleared = false

    await this.ensureBackfilled()
    const ids = await this.claimBatch()
    if (ids.length === 0) return 0

    const failed: string[] = []
    try {
      const writes = await this.buildWrites(ids)
      await runLimited(writes, WRITE_CONCURRENCY, async (write) => {
        try {
          if (write.body === null) {
            await s3Service.deleteObject(bucket(), write.key)
          } else {
            await s3Service.putObject(
              bucket(),
              write.key,
              write.body,
              Buffer.byteLength(write.body),
              'application/json',
            )
          }
        } catch (err) {
          failed.push(write.queueId)
          logger.warn({ err, key: write.key }, 'Failed to write storage catalog record, will retry')
        }
      })
    } catch (err) {
      // Could not even read the rows: put the whole batch back and let the next pass retry it.
      await this.requeue(ids)
      throw err
    }
    if (failed.length > 0) await this.requeue(failed)
    return ids.length
  }

  /** Queue every asset, project and metadata field once, so the catalog also covers the existing library. */
  async ensureBackfilled() {
    const complete = await prisma.storageCatalogQueue.findUnique({
      where: { id: COMPLETE_SENTINEL },
    })
    if (complete) return
    await prisma.$transaction([
      prisma.$executeRaw`INSERT INTO storage_catalog_queue (id) SELECT id FROM assets ON CONFLICT (id) DO NOTHING`,
      prisma.$executeRaw`INSERT INTO storage_catalog_queue (id) SELECT 'project:' || id FROM projects ON CONFLICT (id) DO NOTHING`,
      prisma.$executeRaw`INSERT INTO storage_catalog_queue (id) SELECT 'field:' || key FROM metadata_fields ON CONFLICT (id) DO NOTHING`,
      prisma.storageCatalogQueue.create({ data: { id: COMPLETE_SENTINEL } }),
    ])
    logger.info('Storage catalog: queued the whole library for its first sync')
  }

  /** Atomically take up to one batch of queued ids, oldest first. Safe with several server instances. */
  private async claimBatch(): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      DELETE FROM storage_catalog_queue
      WHERE id IN (
        SELECT id FROM storage_catalog_queue
        WHERE id <> ${COMPLETE_SENTINEL}
        ORDER BY queued_at
        LIMIT ${SYNC_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`
    return rows.map((r) => r.id)
  }

  private async requeue(ids: string[]) {
    await prisma.storageCatalogQueue.createMany({
      data: ids.map((id) => ({ id })),
      skipDuplicates: true,
    })
  }

  private async buildWrites(ids: string[]): Promise<Write[]> {
    const assetIds: string[] = []
    const projectIds: string[] = []
    const fieldKeys: string[] = []
    for (const id of ids) {
      if (id.startsWith(PROJECT_PREFIX)) projectIds.push(id.slice(PROJECT_PREFIX.length))
      else if (id.startsWith(FIELD_PREFIX)) fieldKeys.push(id.slice(FIELD_PREFIX.length))
      else assetIds.push(id)
    }

    const [assets, projects, fields] = await Promise.all([
      assetIds.length
        ? prisma.asset.findMany({
            where: { id: { in: assetIds } },
            include: { storageKey: { select: { key: true } }, metadataValues: true },
          })
        : [],
      projectIds.length ? prisma.project.findMany({ where: { id: { in: projectIds } } }) : [],
      fieldKeys.length ? prisma.metadataField.findMany({ where: { key: { in: fieldKeys } } }) : [],
    ])

    const bodies = new Map<string, string>()
    for (const a of assets) bodies.set(a.id, JSON.stringify(toAssetRecord(a)))
    for (const p of projects) bodies.set(PROJECT_PREFIX + p.id, JSON.stringify(toProjectRecord(p)))
    for (const f of fields) bodies.set(FIELD_PREFIX + f.key, JSON.stringify(toFieldRecord(f)))

    // A queued id with no row left means the object was deleted: remove its record.
    return ids.map((queueId) => ({
      queueId,
      key: catalogRecordKey(queueId),
      body: bodies.get(queueId) ?? null,
    }))
  }
}

type AssetWithCatalogData = Prisma.AssetGetPayload<{
  include: { storageKey: { select: { key: true } }; metadataValues: true }
}>

export function toAssetRecord(a: AssetWithCatalogData): CatalogAssetRecord {
  const metadata: Record<string, CatalogMetadataValue> = {}
  for (const m of a.metadataValues) {
    const value: CatalogMetadataValue = {}
    if (m.stringValue !== null) value.stringValue = m.stringValue
    if (m.numberValue !== null) value.numberValue = m.numberValue
    if (m.booleanValue !== null) value.booleanValue = m.booleanValue
    if (m.jsonValue !== null) value.jsonValue = m.jsonValue
    if (m.dateValue !== null) value.dateValue = m.dateValue.toISOString()
    metadata[m.fieldKey] = value
  }
  return {
    v: CATALOG_RECORD_VERSION,
    kind: 'asset',
    id: a.id,
    type: a.type,
    name: a.name,
    status: a.status,
    parentId: a.parentId,
    projectId: a.projectId,
    targetId: a.targetId,
    sortIndex: a.sortIndex,
    storageKey: a.storageKey?.key ?? null,
    mediaType: a.mediaType,
    sizeByte: a.sizeByte.toString(),
    fileCount: a.fileCount,
    hasJpegPreview: a.hasJpegPreview,
    isDeleted: a.isDeleted,
    deletedAt: a.deletedAt?.toISOString() ?? null,
    creatorId: a.creatorId,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    metadata,
  }
}

export function toProjectRecord(p: Prisma.ProjectGetPayload<object>): CatalogProjectRecord {
  return {
    v: CATALOG_RECORD_VERSION,
    kind: 'project',
    id: p.id,
    name: p.name,
    teamId: p.teamId,
    rootFolderId: p.rootFolderId,
    shareRootId: p.shareRootId,
    metadataOverrides: p.metadataOverrides,
    createdAt: p.createdAt.toISOString(),
  }
}

export function toFieldRecord(f: Prisma.MetadataFieldGetPayload<object>): CatalogFieldRecord {
  return {
    v: CATALOG_RECORD_VERSION,
    kind: 'metadataField',
    id: f.id,
    key: f.key,
    scope: f.scope,
    config: f.config,
    readOnly: f.readOnly,
    description: f.description,
    teamId: f.teamId,
    projectId: f.projectId,
  }
}

export const storageCatalogService = new StorageCatalogService()
