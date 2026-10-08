import { describe, expect, it } from 'vitest'
import {
  checkDuplicatesRequestSchema,
  contentHashSchema,
  listDuplicatesRequestSchema,
  MAX_DUPLICATE_CHECK_FILES,
} from './duplicates'

const HASH = 'a'.repeat(64)

describe('contentHashSchema', () => {
  it('accepts 64 hex characters and lowercases them', () => {
    expect(contentHashSchema.parse('A'.repeat(64))).toBe(HASH)
  })

  it.each(['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])('rejects %j', (v) => {
    expect(contentHashSchema.safeParse(v).success).toBe(false)
  })
})

describe('checkDuplicatesRequestSchema', () => {
  it('accepts a valid request', () => {
    const parsed = checkDuplicatesRequestSchema.parse({
      files: [{ sizeByte: 10, contentHash: HASH }],
    })
    expect(parsed.files[0].contentHash).toBe(HASH)
  })

  it('rejects an empty file list', () => {
    expect(checkDuplicatesRequestSchema.safeParse({ files: [] }).success).toBe(false)
  })

  it('rejects more files than the limit', () => {
    const files = Array.from({ length: MAX_DUPLICATE_CHECK_FILES + 1 }, () => ({
      sizeByte: 1,
      contentHash: HASH,
    }))
    expect(checkDuplicatesRequestSchema.safeParse({ files }).success).toBe(false)
  })

  it('rejects negative or fractional sizes and bad hashes', () => {
    const bad = [
      { sizeByte: -1, contentHash: HASH },
      { sizeByte: 1.5, contentHash: HASH },
      { sizeByte: 1, contentHash: 'nope' },
    ]
    for (const file of bad) {
      expect(checkDuplicatesRequestSchema.safeParse({ files: [file] }).success).toBe(false)
    }
  })
})

describe('listDuplicatesRequestSchema', () => {
  it('defaults the limit and coerces query strings', () => {
    expect(listDuplicatesRequestSchema.parse({}).limit).toBe(50)
    expect(listDuplicatesRequestSchema.parse({ limit: '20' }).limit).toBe(20)
  })

  it('rejects out of range limits', () => {
    expect(listDuplicatesRequestSchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(listDuplicatesRequestSchema.safeParse({ limit: '201' }).success).toBe(false)
  })
})
