import { prisma } from '@shumai/db'
import { metadataService } from '@shumai/core/src/metadata/metadata'
import { searchService } from '@shumai/core/src/search/search'

/** The label a project's (or team's) dropdown field needs for automatic filling. */
export const PHOTOGRAPHER_FIELD_NAME = 'Photographer'

/**
 * Fills a project's "Photographer" dropdown from the name recorded in a photo: the camera's
 * Artist (Fujifilm: Copyright Info > Author) or Lightroom's Creator in the XMP. The name picks the
 * option with the same display name, ignoring case, and adds one when none matches. The files of
 * the same shot (RAW, JPG, sidecars) get it too. Files that already have a photographer keep it,
 * so a hand-set value always wins.
 */
export class PhotographerService {
  constructor(private readonly client: typeof prisma = prisma) {}

  /** The key of the dropdown field named "Photographer" visible in the asset's project, if any. */
  private async fieldKeyFor(assetId: string): Promise<string | null> {
    const asset = await this.client.asset.findUnique({
      where: { id: assetId },
      select: { projectId: true, project: { select: { teamId: true } } },
    })
    if (!asset?.projectId) return null
    const fields = await this.client.metadataField.findMany({
      where: {
        OR: [
          { scope: 'PROJECT', projectId: asset.projectId },
          { scope: 'TEAM', teamId: asset.project?.teamId ?? '' },
        ],
      },
    })
    // A project's own field wins over a team-wide one.
    fields.sort((a, b) => Number(b.scope === 'PROJECT') - Number(a.scope === 'PROJECT'))
    const field = fields.find((f) => {
      const config = f.config as PrismaJson.FieldConfig | null
      return (
        config?.type === 'select' &&
        config.name?.trim().toLowerCase() === PHOTOGRAPHER_FIELD_NAME.toLowerCase()
      )
    })
    return field?.key ?? null
  }

  /**
   * Sets the photographer on `assetId` and the other files of its shot that have none yet.
   * Returns how many files were set; 0 when the project has no Photographer field.
   */
  async fillFromName(assetId: string, name: string | undefined): Promise<number> {
    const trimmed = name?.trim()
    if (!trimmed) return 0
    const key = await this.fieldKeyFor(assetId)
    if (!key) return 0

    const members = await searchService.stackMembersOf(assetId)
    const ids = members.length > 0 ? members.map((m) => m.id) : [assetId]
    const taken = await this.client.assetMetadataValue.findMany({
      where: { assetId: { in: ids }, fieldKey: key },
      select: { assetId: true },
    })
    const done = new Set(taken.map((t) => t.assetId))
    let set = 0
    for (const id of ids) {
      if (done.has(id)) continue
      await metadataService.updateAssetMetadata(id, [
        { key, value: { newOption: { value: trimmed } } },
      ])
      set++
    }
    return set
  }
}

export const photographerService = new PhotographerService()
