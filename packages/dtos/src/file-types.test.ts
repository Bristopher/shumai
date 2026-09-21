import { describe, it, expect } from 'vitest'
import {
  expandFileTypes,
  fileExtension,
  fileTypeFilterSchema,
  isFileTypeFilterActive,
} from './file-types'

describe('expandFileTypes', () => {
  it('expands groups, lowercases, strips dots and de-duplicates', () => {
    expect(expandFileTypes(['group:jpeg', '.JPG', 'RAF'])).toEqual(['jpg', 'jpeg', 'raf'])
    expect(expandFileTypes(['group:raw'])).toContain('arw')
    expect(expandFileTypes(['group:editing'])).toContain('xmp')
  })

  it('drops unknown groups and handles undefined', () => {
    expect(expandFileTypes(['group:nope'])).toEqual([])
    expect(expandFileTypes(undefined)).toEqual([])
  })
})

describe('fileTypeFilterSchema', () => {
  it('accepts extensions and groups, normalising case', () => {
    expect(fileTypeFilterSchema.parse({ include: ['RAF', 'group:raw'] })).toEqual({
      include: ['raf', 'group:raw'],
    })
  })

  it('rejects anything that is not a plain extension or a group', () => {
    expect(() => fileTypeFilterSchema.parse({ include: ["raf'; drop table assets"] })).toThrow()
    expect(() => fileTypeFilterSchema.parse({ exclude: ['a.b'] })).toThrow()
  })
})

describe('helpers', () => {
  it('reads the last extension', () => {
    expect(fileExtension('DSCF5056.RAF.xmp')).toBe('xmp')
    expect(fileExtension('notes')).toBe('')
    expect(fileExtension('.hidden')).toBe('')
  })

  it('knows when a filter is active', () => {
    expect(isFileTypeFilterActive(undefined)).toBe(false)
    expect(isFileTypeFilterActive({ include: [], exclude: [] })).toBe(false)
    expect(isFileTypeFilterActive({ exclude: ['group:editing'] })).toBe(true)
  })
})
