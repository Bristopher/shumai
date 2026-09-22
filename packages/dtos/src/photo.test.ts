import { describe, expect, it } from 'vitest'
import {
  isPhotoFilterActive,
  recipeClarity,
  recipeWithoutClarity,
  stackKey,
  suggestRecipeNames,
} from './photo'

const PORTRA = 'Classic Chrome | Grain Weak Small | WB Auto R+2 B-4 | Highlight -1 | Clarity -3'
const PORTRA_C0 = 'Classic Chrome | Grain Weak Small | WB Auto R+2 B-4 | Highlight -1 | Clarity 0'
const OTHER = 'Classic Neg. | Grain Off | WB Auto R+4 B-5 | Highlight -1.5 | Clarity 0'

describe('stackKey', () => {
  it('drops a trailing .xmp and then the last extension, case-insensitively', () => {
    expect(stackKey('DSCF5543.JPG')).toBe('dscf5543')
    expect(stackKey('DSCF5543.RAF.xmp')).toBe('dscf5543')
    expect(stackKey('DSCF5543.xmp')).toBe('dscf5543')
    expect(stackKey('notes')).toBe('notes')
  })
})

describe('recipe clarity helpers', () => {
  it('splits clarity off a settings line', () => {
    expect(recipeWithoutClarity(PORTRA)).toBe(recipeWithoutClarity(PORTRA_C0))
    expect(recipeClarity(PORTRA)).toBe('-3')
    expect(recipeClarity(PORTRA_C0)).toBe('0')
  })

  it('suggests the name of the same recipe with another clarity, plain and noted', () => {
    expect(
      suggestRecipeNames(PORTRA_C0, { [PORTRA]: "Reggie's Portra", [OTHER]: 'Cuban Neg' }),
    ).toEqual(["Reggie's Portra", "Reggie's Portra (Clarity 0)"])
  })

  it('does not stack clarity notes when the named one already has one', () => {
    expect(suggestRecipeNames(PORTRA, { [PORTRA_C0]: "Reggie's Portra (Clarity 0)" })).toEqual([
      "Reggie's Portra",
      "Reggie's Portra (Clarity -3)",
    ])
  })

  it('suggests nothing for a recipe with no clarity sibling', () => {
    expect(suggestRecipeNames(OTHER, { [PORTRA]: "Reggie's Portra" })).toEqual([])
  })
})

describe('isPhotoFilterActive', () => {
  it('is active when any facet, the recipe included, has a value', () => {
    expect(isPhotoFilterActive(undefined)).toBe(false)
    expect(isPhotoFilterActive({ camera: [] })).toBe(false)
    expect(isPhotoFilterActive({ fujiRecipe: [OTHER] })).toBe(true)
  })
})
