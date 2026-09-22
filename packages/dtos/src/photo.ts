import { z } from 'zod'

/**
 * Photo browsing: filtering by the camera EXIF that transcoding stores as system metadata fields
 * (`camera`, `lens`, `film_simulation`, `capture_date`), and stacking the files of one shot
 * (DSCF5543.JPG, .RAF, .RAF.xmp) into one card.
 */

/** Filterable EXIF facets, keyed by request property, valued by metadata field key. */
export const PHOTO_FACETS = {
  camera: 'camera',
  lens: 'lens',
  filmSimulation: 'film_simulation',
  /** The recipe's settings line (see describeFujiRecipe in core). */
  fujiRecipe: 'fuji_recipe',
} as const
export type PhotoFacet = keyof typeof PHOTO_FACETS

const facetValuesSchema = z.array(z.string().trim().min(1).max(200)).max(50).optional()

export const photoFilterSchema = z.object({
  camera: facetValuesSchema,
  lens: facetValuesSchema,
  filmSimulation: facetValuesSchema,
  fujiRecipe: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
})
export type PhotoFilter = z.infer<typeof photoFilterSchema>

/** True when the filter would change the listing. */
export function isPhotoFilterActive(filter: PhotoFilter | undefined): boolean {
  if (!filter) return false
  return (Object.keys(PHOTO_FACETS) as PhotoFacet[]).some((k) => (filter[k]?.length ?? 0) > 0)
}

export const photoFacetValueSchema = z.object({
  value: z.string(),
  /** Shots (files stacked by base name) with this value. */
  count: z.number(),
})
export type PhotoFacetValue = z.infer<typeof photoFacetValueSchema>

export const photoFacetsSchema = z.object({
  camera: z.array(photoFacetValueSchema),
  lens: z.array(photoFacetValueSchema),
  filmSimulation: z.array(photoFacetValueSchema),
  fujiRecipe: z.array(photoFacetValueSchema),
})
export type PhotoFacets = z.infer<typeof photoFacetsSchema>

/** Sort field for "date taken" (EXIF DateTimeOriginal, or a video's creation time). */
export const CAPTURE_DATE_SORT_FIELD = 'captureDate'

/**
 * The stack a file belongs to: its lowercased name with a trailing ".xmp" and then its last
 * extension removed, so DSCF5543.JPG, DSCF5543.RAF, DSCF5543.RAF.xmp and DSCF5543.xmp share
 * "dscf5543". Mirrors the SQL in `SqlQueryBuilder` (STACK_KEY_SQL).
 */
export function stackKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.xmp$/, '')
    .replace(/\.[^.]+$/, '')
}

export const stackMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type StackMember = z.infer<typeof stackMemberSchema>

export const assetStackSchema = z.object({
  /** Files in the stack, the shown one included. */
  count: z.number(),
  /** Every file of the stack in display order (photo, RAW, video, other, sidecars). */
  members: z.array(stackMemberSchema),
})
export type AssetStack = z.infer<typeof assetStackSchema>

/**
 * Names given to Fujifilm recipes, per team: recipe settings line -> name. Several settings lines
 * may share a name (the same recipe with Clarity 0, say).
 */
export const fujiRecipeNamesSchema = z.record(z.string().min(1).max(500), z.string().max(100))
export type FujiRecipeNames = z.infer<typeof fujiRecipeNamesSchema>

export const setFujiRecipeNameRequestSchema = z.object({
  settings: z.string().trim().min(1).max(500),
  /** Empty removes the name. */
  name: z.string().trim().max(100),
})
export type SetFujiRecipeNameRequest = z.infer<typeof setFujiRecipeNameRequestSchema>

/** The part of a recipe's settings line that clarity does not change. */
export function recipeWithoutClarity(settings: string): string {
  return settings.replace(/ \| Clarity [+-]?\d+$/, '')
}

/** The clarity of a recipe's settings line, e.g. "0" or "-4", if present. */
export function recipeClarity(settings: string): string | undefined {
  return settings.match(/ \| Clarity ([+-]?\d+)$/)?.[1]
}

/**
 * Names to offer for an unnamed recipe: for each named recipe that differs only in clarity, its
 * name and the name with this recipe's clarity noted, e.g. "Reggie's Portra (Clarity 0)".
 */
export function suggestRecipeNames(settings: string, names: FujiRecipeNames): string[] {
  const base = recipeWithoutClarity(settings)
  const clarity = recipeClarity(settings)
  const out: string[] = []
  for (const [other, name] of Object.entries(names)) {
    if (other === settings || !name || recipeWithoutClarity(other) !== base) continue
    const plain = name.replace(/ \(Clarity [+-]?\d+\)$/, '')
    for (const s of [plain, clarity !== undefined ? `${plain} (Clarity ${clarity})` : plain]) {
      if (!out.includes(s)) out.push(s)
    }
  }
  return out
}
