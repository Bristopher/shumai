/**
 * Keeps the `xmp_*` metadata of media files in step with the XMP sidecars next to them.
 * Call `syncXmpSidecars` with a media file or a sidecar: it re-reads every sidecar that can belong
 * to files with the same name stem in that folder and writes, or clears, the values.
 */
import { AssetType, Prisma, prisma } from '@shumai/db'
import { logger } from '../logger'
import { s3Service } from '../s3/s3'
import { metadataService } from './metadata'
import {
  MAX_XMP_SIDECAR_BYTES,
  XMP_FIELD_KEYS,
  isXmpSidecarName,
  pairSidecars,
  parseXmpSidecar,
  xmpMetadataUpdates,
  xmpStem,
  type XmpSidecar,
} from './xmp-sidecar'

type Client = Prisma.TransactionClient | typeof prisma

async function writeUpdates(
  client: Client,
  assetId: string,
  updates: ReturnType<typeof xmpMetadataUpdates>,
): Promise<void> {
  if (client === prisma) {
    await metadataService.updateAssetMetadata(assetId, updates, true)
  } else {
    await metadataService.updateAssetMetadataInTx(
      client as Prisma.TransactionClient,
      assetId,
      updates,
      true,
    )
  }
}

/**
 * Read a sidecar asset. Returns undefined when it could not be read (leave the values alone),
 * null when it was read but holds nothing usable (clear the values).
 */
async function loadSidecar(sidecar: {
  id: string
  sizeByte: bigint
  storageKey: { key: string } | null
}): Promise<XmpSidecar | null | undefined> {
  const key = sidecar.storageKey?.key
  if (!key) return undefined
  if (Number(sidecar.sizeByte) > MAX_XMP_SIDECAR_BYTES) return null
  try {
    const { buffer } = await s3Service.getObject(process.env.S3_BUCKET || 'shumai', key)
    return await parseXmpSidecar(buffer)
  } catch (err) {
    logger.warn({ assetId: sidecar.id, err }, 'Failed to read XMP sidecar from storage')
    return undefined
  }
}

/**
 * Sync the sidecar values for the files that share a name stem with `assetId` (a media file or a
 * sidecar), in the same folder. Safe to call for any asset; it does nothing for folders.
 */
export async function syncXmpSidecars(assetId: string, client: Client = prisma): Promise<void> {
  const asset = await client.asset.findUnique({
    where: { id: assetId },
    select: {
      name: true,
      type: true,
      parentId: true,
      parent: { select: { type: true, parentId: true } },
    },
  })
  if (!asset || asset.type !== AssetType.file || !asset.parentId || asset.name.startsWith('.')) {
    return
  }
  const folderId =
    asset.parent?.type === AssetType.version_stack ? asset.parent.parentId : asset.parentId
  if (!folderId) return
  const stem = xmpStem(asset.name)
  if (!stem) return

  // Every file of the folder that could pair with this name: "<stem>.<anything>" or "<stem>".
  const candidates = await client.asset.findMany({
    where: {
      type: AssetType.file,
      isDeleted: false,
      OR: [
        { parentId: folderId },
        { parent: { type: AssetType.version_stack, parentId: folderId } },
      ],
      AND: [
        {
          OR: [
            { name: { startsWith: `${stem}.`, mode: 'insensitive' } },
            { name: { equals: stem, mode: 'insensitive' } },
          ],
        },
      ],
    },
    select: {
      id: true,
      name: true,
      createdAt: true,
      sizeByte: true,
      storageKey: { select: { key: true } },
    },
  })
  const pairs = pairSidecars(candidates)
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const mediaIds = candidates.filter((c) => !isXmpSidecarName(c.name)).map((c) => c.id)
  if (mediaIds.length === 0) return

  const parsed = new Map<string, XmpSidecar | null | undefined>()
  const clearIds: string[] = []
  for (const mediaId of mediaIds) {
    const sidecarId = pairs.get(mediaId)
    if (!sidecarId) {
      clearIds.push(mediaId)
      continue
    }
    if (!parsed.has(sidecarId)) parsed.set(sidecarId, await loadSidecar(byId.get(sidecarId)!))
    const xmp = parsed.get(sidecarId)
    if (xmp === undefined) continue
    await writeUpdates(client, mediaId, xmpMetadataUpdates(xmp))
  }

  // Media that lost their sidecar: only touch the ones that still hold sidecar values.
  if (clearIds.length > 0) {
    const stale = await client.assetMetadataValue.findMany({
      where: {
        assetId: { in: clearIds },
        fieldKey: { in: [...XMP_FIELD_KEYS] },
        OR: [
          { stringValue: { not: null } },
          { numberValue: { not: null } },
          { booleanValue: { not: null } },
        ],
      },
      select: { assetId: true },
      distinct: ['assetId'],
    })
    for (const { assetId: staleId } of stale) {
      await writeUpdates(client, staleId, xmpMetadataUpdates(null))
    }
  }
}

/** Like `syncXmpSidecars` but never throws: sidecar trouble must not fail an upload or transcode. */
export async function trySyncXmpSidecars(assetId: string, client: Client = prisma): Promise<void> {
  try {
    await syncXmpSidecars(assetId, client)
  } catch (err) {
    logger.warn({ assetId, err }, 'Failed to sync XMP sidecar metadata')
  }
}
