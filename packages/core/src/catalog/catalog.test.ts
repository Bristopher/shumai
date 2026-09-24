import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssetStatus, AssetType, prisma } from '@shumai/db'
import { setupTestDbHooks } from '@shumai/db/test'
import { s3Service } from '@shumai/core/src/s3/s3'
import { catalogRecordKey, CatalogAssetRecord, StorageCatalogService } from './catalog'
import { restoreFromCatalog } from './restore'

// In-memory storage so the catalog can be written and read back.
const store = new Map<string, Buffer>()
vi.mock('@shumai/core/src/s3/s3', () => ({
  s3Service: {
    putObject: vi.fn(async (_bucket: string, key: string, body: string) => {
      store.set(key, Buffer.from(body))
    }),
    deleteObject: vi.fn(async (_bucket: string, key: string) => (store.delete(key) ? 1 : 0)),
    getObject: vi.fn(async (_bucket: string, key: string) => {
      const buffer = store.get(key)
      if (!buffer) throw new Error('NoSuchKey')
      return { buffer, contentType: 'application/json' }
    }),
    headObject: vi.fn(async (_bucket: string, key: string) => {
      if (!store.has(key)) throw new Error('NoSuchKey')
      return { key, size: store.get(key)!.length }
    }),
    listObjects: vi.fn(async (_bucket: string, prefix: string) =>
      [...store.keys()].filter((k) => k.startsWith(prefix)),
    ),
  },
}))

const queued = async () =>
  (await prisma.storageCatalogQueue.findMany({ select: { id: true } }))
    .map((r) => r.id)
    .filter((id) => id !== 'catalog:complete')
    .sort()

const record = (id: string) => {
  const buffer = store.get(catalogRecordKey(id))
  return buffer ? (JSON.parse(buffer.toString()) as CatalogAssetRecord) : undefined
}

describe('storage catalog', () => {
  setupTestDbHooks()

  let service: StorageCatalogService
  let teamId: string
  let projectId: string
  let rootId: string

  const folder = async (name: string, parentId: string) =>
    (
      await prisma.asset.create({
        data: { name, type: AssetType.folder, status: AssetStatus.uploaded, projectId, parentId },
      })
    ).id

  const file = async (name: string, parentId: string) => {
    const storageKeyId = (
      await prisma.storageKey.create({ data: { key: `files/${name}-key/${name}` } })
    ).id
    return (
      await prisma.asset.create({
        data: {
          name,
          type: AssetType.file,
          status: AssetStatus.processed,
          projectId,
          parentId,
          storageKeyId,
        },
      })
    ).id
  }

  const drain = async () => {
    while ((await service.syncOnce()) > 0) {
      /* keep syncing until the queue is empty */
    }
  }

  beforeEach(async () => {
    vi.stubEnv('STORAGE_CATALOG_ENABLED', 'true')
    store.clear()
    service = new StorageCatalogService()
    teamId = (await prisma.team.create({ data: { name: 'catalog-team' } })).id
    projectId = (await prisma.project.create({ data: { name: 'Trip', teamId } })).id
    rootId = (
      await prisma.asset.create({
        data: { name: 'root', type: AssetType.folder, status: AssetStatus.uploaded, projectId },
      })
    ).id
    await prisma.project.update({ where: { id: projectId }, data: { rootFolderId: rootId } })
    await drain()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  describe('change capture (database triggers)', () => {
    it('queues created, renamed, moved and deleted assets', async () => {
      const a = await folder('A', rootId)
      const b = await folder('B', rootId)
      const f = await file('DSCF0001.JPG', a)
      expect(await queued()).toEqual([a, b, f].sort())

      await drain()
      await prisma.asset.update({ where: { id: f }, data: { name: 'renamed.JPG' } })
      await prisma.asset.update({ where: { id: a }, data: { parentId: b } })
      expect(await queued()).toEqual([a, f].sort())

      await drain()
      await prisma.asset.delete({ where: { id: f } })
      expect(await queued()).toEqual([f])
    })

    it('queues bulk trash and raw SQL changes that bypass the services', async () => {
      const a = await folder('A', rootId)
      const f1 = await file('1.JPG', a)
      const f2 = await file('2.JPG', a)
      await drain()

      await prisma.asset.updateMany({
        where: { parentId: a },
        data: { isDeleted: true, status: AssetStatus.trashed, deletedAt: new Date() },
      })
      expect(await queued()).toEqual([f1, f2].sort())

      await drain()
      await prisma.$executeRaw`UPDATE assets SET status = 'pending_purge' WHERE id = ${a}`
      expect(await queued()).toEqual([a])
    })

    it('ignores updates that do not change what the catalog records', async () => {
      const f = await file('size.JPG', rootId)
      await drain()
      await prisma.asset.update({ where: { id: f }, data: { sizeByte: 12345n, fileCount: 3 } })
      await prisma.asset.update({ where: { id: f }, data: { name: 'size.JPG' } })
      expect(await queued()).toEqual([])
    })

    it('queues metadata value, project and field changes', async () => {
      const f = await file('tagged.JPG', rootId)
      await drain()

      await prisma.assetMetadataValue.create({
        data: { assetId: f, fieldKey: 'camera', stringValue: 'X100VI' },
      })
      await prisma.project.update({ where: { id: projectId }, data: { name: 'Trip 2026' } })
      await prisma.metadataField.create({
        data: {
          key: 'photographer',
          scope: 'PROJECT',
          projectId,
          config: { name: 'Photographer', type: 'text' },
        },
      })
      expect(await queued()).toEqual([f, `project:${projectId}`, 'field:photographer'].sort())
    })
  })

  describe('writer', () => {
    it('writes one record per object, with the parent id and tags', async () => {
      const a = await folder('Hari', rootId)
      const f = await file('DSCF1154.MOV', a)
      await prisma.assetMetadataValue.create({
        data: { assetId: f, fieldKey: 'camera', stringValue: 'X-S20' },
      })
      await drain()

      const r = record(f)!
      expect(r).toMatchObject({
        kind: 'asset',
        name: 'DSCF1154.MOV',
        parentId: a,
        projectId,
        storageKey: 'files/DSCF1154.MOV-key/DSCF1154.MOV',
        metadata: { camera: { stringValue: 'X-S20' } },
      })
      expect(
        JSON.parse(store.get(catalogRecordKey(`project:${projectId}`))!.toString()),
      ).toMatchObject({
        kind: 'project',
        name: 'Trip',
        rootFolderId: rootId,
      })
    })

    it('rewrites only the folder record when a folder moves', async () => {
      const a = await folder('A', rootId)
      const b = await folder('B', rootId)
      await file('1.JPG', a)
      await file('2.JPG', a)
      await drain()
      vi.mocked(s3Service.putObject).mockClear()

      await prisma.asset.update({ where: { id: a }, data: { parentId: b } })
      await drain()

      expect(s3Service.putObject).toHaveBeenCalledTimes(1)
      expect(record(a)!.parentId).toBe(b)
    })

    it('removes the record once the asset is gone', async () => {
      const f = await file('gone.JPG', rootId)
      await drain()
      expect(record(f)).toBeDefined()

      await prisma.asset.delete({ where: { id: f } })
      await drain()
      expect(record(f)).toBeUndefined()
    })

    it('puts a change back in the queue when storage fails', async () => {
      const f = await file('retry.JPG', rootId)
      vi.mocked(s3Service.putObject).mockRejectedValueOnce(new Error('storage down'))
      await service.syncOnce()
      expect(await queued()).toEqual([f])

      await drain()
      expect(record(f)).toBeDefined()
    })

    it('when disabled, empties the queue without writing, and backfills when enabled again', async () => {
      const f = await file('offline.JPG', rootId)
      vi.stubEnv('STORAGE_CATALOG_ENABLED', 'false')
      vi.mocked(s3Service.putObject).mockClear()
      await drain()
      expect(s3Service.putObject).not.toHaveBeenCalled()
      expect(await queued()).toEqual([])

      vi.stubEnv('STORAGE_CATALOG_ENABLED', 'true')
      await drain()
      expect(record(f)).toBeDefined()
      expect(record(rootId)).toBeDefined()
    })
  })

  describe('restore', () => {
    it('rebuilds folders, files, tags and trash state in an empty library', async () => {
      const hari = await folder('Hari Babaria', rootId)
      const shot = await file('DSCF1153.RAF', hari)
      const trashed = await file('old.JPG', hari)
      await prisma.metadataField.create({
        data: {
          key: 'photographer-field',
          scope: 'PROJECT',
          projectId,
          config: {
            name: 'Photographer',
            type: 'select',
            select: { options: [{ id: 'hari', displayName: 'Hari Babaria', color: 'orange' }] },
          },
        },
      })
      await prisma.assetMetadataValue.create({
        data: { assetId: shot, fieldKey: 'photographer-field', stringValue: 'hari' },
      })
      await prisma.asset.update({
        where: { id: trashed },
        data: { isDeleted: true, status: AssetStatus.trashed, deletedAt: new Date() },
      })
      await drain()

      // Lose the library (the files and the catalog stay in storage).
      await prisma.project.update({ where: { id: projectId }, data: { rootFolderId: null } })
      await prisma.asset.deleteMany({ where: { projectId } })
      await prisma.metadataField.deleteMany({ where: { projectId } })
      await prisma.project.delete({ where: { id: projectId } })
      store.set('files/DSCF1153.RAF-key/DSCF1153.RAF', Buffer.from('raw'))
      store.set('files/old.JPG-key/old.JPG', Buffer.from('jpg'))

      const dry = await restoreFromCatalog({ dryRun: true })
      expect(dry.assets.created).toBe(4)
      expect(await prisma.asset.count({ where: { projectId } })).toBe(0)

      const report = await restoreFromCatalog()
      expect(report.missingFiles).toEqual([])
      expect(report.orphans).toEqual([])

      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
      expect(project).toMatchObject({ name: 'Trip', teamId, rootFolderId: rootId })
      expect(await prisma.asset.findUniqueOrThrow({ where: { id: shot } })).toMatchObject({
        name: 'DSCF1153.RAF',
        parentId: hari,
        isDeleted: false,
      })
      expect(await prisma.asset.findUniqueOrThrow({ where: { id: trashed } })).toMatchObject({
        isDeleted: true,
        status: AssetStatus.trashed,
      })
      const value = await prisma.assetMetadataValue.findFirstOrThrow({ where: { assetId: shot } })
      expect(value).toMatchObject({ fieldKey: 'photographer-field', stringValue: 'hari' })

      // Running it again changes nothing.
      const again = await restoreFromCatalog()
      expect(again.assets).toEqual({ created: 0, skipped: 4 })
    })

    it('refuses to guess a team that does not exist', async () => {
      await drain()
      store.set(
        catalogRecordKey('project:elsewhere'),
        Buffer.from(
          JSON.stringify({
            v: 1,
            kind: 'project',
            id: 'elsewhere',
            name: 'X',
            teamId: 'no-such-team',
          }),
        ),
      )
      await expect(restoreFromCatalog({ dryRun: true })).rejects.toThrow(/team/)
    })
  })
})
