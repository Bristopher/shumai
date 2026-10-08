import { z } from 'zod'

/** SHA-256 digest as 64 hex characters; normalised to lowercase to match what is stored. */
export const contentHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'Must be a 64 character SHA-256 hex digest')
  .transform((v) => v.toLowerCase())

export const duplicateAssetInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Folder path of the file inside the project, for example `Shoots/2026/Day 1`. */
  path: z.string(),
  parentId: z.string().nullable(),
  sizeByte: z.number(),
  createdAt: z.string(),
})
export type DuplicateAssetInfo = z.infer<typeof duplicateAssetInfoSchema>

export const duplicateGroupSchema = z.object({
  contentHash: z.string(),
  sizeByte: z.number(),
  count: z.number(),
  /** Bytes that would be freed by keeping a single copy. */
  wastedBytes: z.number(),
  assets: z.array(duplicateAssetInfoSchema),
})
export type DuplicateGroup = z.infer<typeof duplicateGroupSchema>

export const listDuplicatesRequestSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
})
export type ListDuplicatesRequest = z.infer<typeof listDuplicatesRequestSchema>

export const listDuplicatesResponseSchema = z.object({
  groups: z.array(duplicateGroupSchema),
  /** True when more duplicate groups exist than `limit`. */
  truncated: z.boolean(),
})
export type ListDuplicatesResponse = z.infer<typeof listDuplicatesResponseSchema>

export const MAX_DUPLICATE_CHECK_FILES = 100

export const checkDuplicatesRequestSchema = z.object({
  files: z
    .array(
      z.object({
        sizeByte: z.number().int().nonnegative(),
        contentHash: contentHashSchema,
      }),
    )
    .min(1)
    .max(MAX_DUPLICATE_CHECK_FILES),
})
export type CheckDuplicatesRequest = z.infer<typeof checkDuplicatesRequestSchema>

export const checkDuplicatesResponseSchema = z.object({
  matches: z.array(
    z.object({
      contentHash: z.string(),
      assets: z.array(duplicateAssetInfoSchema),
    }),
  ),
})
export type CheckDuplicatesResponse = z.infer<typeof checkDuplicatesResponseSchema>
