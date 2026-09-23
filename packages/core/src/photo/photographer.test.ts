import { beforeEach, describe, expect, it } from 'vitest'
import { AssetType, prisma } from '@shumai/db'
import { setupTestDbHooks } from '@shumai/db/test'
import { PhotographerService } from './photographer'

describe('PhotographerService', () => {
  setupTestDbHooks()

  let service: PhotographerService
  let projectId: string
  let folderId: string
  let fieldKey: string

  const file = async (name: string) =>
    (
      await prisma.asset.create({
        data: { name, type: AssetType.file, projectId, parentId: folderId, status: 'processed' },
      })
    ).id

  const photographerOf = async (assetId: string) =>
    (
      await prisma.assetMetadataValue.findFirst({
        where: { assetId, fieldKey },
      })
    )?.stringValue ?? null

  beforeEach(async () => {
    service = new PhotographerService()
    const team = await prisma.team.create({ data: { name: 'photographers' } })
    projectId = (await prisma.project.create({ data: { name: 'trip', teamId: team.id } })).id
    folderId = (
      await prisma.asset.create({
        data: { name: 'root', type: AssetType.folder, projectId, status: 'uploaded' },
      })
    ).id
    fieldKey = (
      await prisma.metadataField.create({
        data: {
          key: `photographer-${projectId}`,
          scope: 'PROJECT',
          projectId,
          config: {
            name: 'Photographer',
            type: 'select',
            select: {
              options: [
                { id: 'christopher-buzicky', displayName: 'Christopher Buzicky', color: 'blue' },
                { id: 'hari-babaria', displayName: 'Hari Babaria', color: 'orange' },
              ],
            },
          },
        },
      })
    ).key
  })

  it("tags the shot's files with the matching option, ignoring case", async () => {
    const jpg = await file('DSCF1499.JPG')
    const raf = await file('DSCF1499.RAF')
    const xmp = await file('DSCF1499.RAF.xmp')
    const other = await file('DSCF1500.JPG')

    expect(await service.fillFromName(raf, '  hari BABARIA ')).toBe(3)
    for (const id of [jpg, raf, xmp]) expect(await photographerOf(id)).toBe('hari-babaria')
    expect(await photographerOf(other)).toBeNull()
  })

  it('never overwrites a photographer that is already set', async () => {
    const jpg = await file('DSCF5915.JPG')
    const raf = await file('DSCF5915.RAF')
    await prisma.assetMetadataValue.create({
      data: { assetId: jpg, fieldKey, stringValue: 'christopher-buzicky' },
    })

    expect(await service.fillFromName(raf, 'Hari Babaria')).toBe(1)
    expect(await photographerOf(jpg)).toBe('christopher-buzicky')
    expect(await photographerOf(raf)).toBe('hari-babaria')
  })

  it('adds an option for a new name', async () => {
    const jpg = await file('IMG_0001.JPG')
    expect(await service.fillFromName(jpg, 'Torrie')).toBe(1)
    expect(await photographerOf(jpg)).toBe('torrie')
    const field = await prisma.metadataField.findUniqueOrThrow({ where: { key: fieldKey } })
    const options = (field.config as PrismaJson.FieldConfig).select?.options ?? []
    expect(options.map((o) => o.displayName)).toContain('Torrie')
  })

  it('does nothing without a name or without a Photographer field', async () => {
    const jpg = await file('IMG_0002.JPG')
    expect(await service.fillFromName(jpg, '   ')).toBe(0)
    await prisma.metadataField.delete({ where: { key: fieldKey } })
    expect(await service.fillFromName(jpg, 'Hari Babaria')).toBe(0)
  })
})
