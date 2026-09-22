import { prisma } from '@shumai/db'
import type { FujiRecipeNames } from '@shumai/dtos'

/**
 * The names a team gives its Fujifilm recipes. Cameras record a recipe's settings but not its name,
 * so a name is attached to the exact settings line (`fuji_recipe` field) once, and then applies to
 * every photo taken with those settings. Stored in system settings, one entry per team.
 */
export class FujiRecipeNameService {
  constructor(private readonly client: typeof prisma = prisma) {}

  private key(teamId: string): string {
    return `team:${teamId}:fujiRecipeNames`
  }

  private async teamOf(projectId: string): Promise<string> {
    const project = await this.client.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    })
    if (!project) throw new Error('Project not found')
    return project.teamId
  }

  async list(projectId: string): Promise<FujiRecipeNames> {
    const row = await this.client.systemSettings.findUnique({
      where: { key: this.key(await this.teamOf(projectId)) },
    })
    const value = row?.value
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as FujiRecipeNames)
      : {}
  }

  /** Name a recipe's settings line; an empty name removes it. Returns every name. */
  async set(projectId: string, settings: string, name: string): Promise<FujiRecipeNames> {
    const key = this.key(await this.teamOf(projectId))
    return this.client.$transaction(async (tx) => {
      const row = await tx.systemSettings.findUnique({ where: { key } })
      const names = { ...((row?.value as FujiRecipeNames | null) ?? {}) }
      if (name) names[settings] = name
      else delete names[settings]
      await tx.systemSettings.upsert({
        where: { key },
        create: { key, value: names },
        update: { value: names },
      })
      return names
    })
  }
}

export const fujiRecipeNameService = new FujiRecipeNameService()
