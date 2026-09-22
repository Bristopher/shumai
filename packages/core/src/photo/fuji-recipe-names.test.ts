import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@shumai/db'
import { setupTestDbHooks } from '@shumai/db/test'
import { FujiRecipeNameService } from './fuji-recipe-names'

describe('FujiRecipeNameService', () => {
  setupTestDbHooks()

  let service: FujiRecipeNameService
  let projectA: string
  let projectB: string
  let otherTeamProject: string

  beforeEach(async () => {
    service = new FujiRecipeNameService()
    const team = await prisma.team.create({ data: { name: 'recipes' } })
    const other = await prisma.team.create({ data: { name: 'other' } })
    projectA = (await prisma.project.create({ data: { name: 'a', teamId: team.id } })).id
    projectB = (await prisma.project.create({ data: { name: 'b', teamId: team.id } })).id
    otherTeamProject = (await prisma.project.create({ data: { name: 'c', teamId: other.id } })).id
  })

  it('names recipes for the whole team, and keeps teams apart', async () => {
    expect(await service.list(projectA)).toEqual({})
    await service.set(projectA, 'Classic Neg. | Clarity 0', 'Cuban Neg')
    await service.set(projectA, 'Classic Chrome | Clarity -3', "Reggie's Portra")
    expect(await service.list(projectB)).toEqual({
      'Classic Neg. | Clarity 0': 'Cuban Neg',
      'Classic Chrome | Clarity -3': "Reggie's Portra",
    })
    expect(await service.list(otherTeamProject)).toEqual({})
  })

  it('renames, and removes a name when it is empty', async () => {
    await service.set(projectA, 'Classic Neg. | Clarity 0', 'Cuban Neg')
    await service.set(projectA, 'Classic Neg. | Clarity 0', 'Cuban Negative')
    expect(await service.list(projectA)).toEqual({ 'Classic Neg. | Clarity 0': 'Cuban Negative' })
    expect(await service.set(projectA, 'Classic Neg. | Clarity 0', '')).toEqual({})
  })
})
