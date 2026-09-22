import { describe, expect, it } from 'vitest'
import { expandStackIds, isStacked, stackDeleteIds } from './stack-utils'

const jpg = {
  id: 'jpg',
  stack: {
    count: 3,
    members: [
      { id: 'jpg', name: 'DSCF5543.JPG' },
      { id: 'raf', name: 'DSCF5543.RAF' },
      { id: 'xmp', name: 'DSCF5543.RAF.xmp' },
    ],
  },
}

describe('expandStackIds', () => {
  it('keeps plain items as they are', () => {
    expect(expandStackIds([{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b'])
  })

  it('expands a stacked card to every file of its shot, once each', () => {
    expect(expandStackIds([jpg, { id: 'other' }])).toEqual(['jpg', 'raf', 'xmp', 'other'])
  })
})

describe('stackDeleteIds', () => {
  it('deletes only the ticked files of a stack, and plain items as they are', () => {
    expect(stackDeleteIds([jpg, { id: 'other' }], new Set(['raf', 'xmp']))).toEqual([
      'raf',
      'xmp',
      'other',
    ])
  })

  it('deletes nothing of a stack when every file is unticked', () => {
    expect(stackDeleteIds([jpg], new Set())).toEqual([])
  })

  it('treats a one-file stack as a plain item', () => {
    const single = { id: 'mov', stack: { count: 1, members: [{ id: 'mov', name: 'A.MOV' }] } }
    expect(isStacked(single)).toBe(false)
    expect(stackDeleteIds([single], new Set())).toEqual(['mov'])
  })
})
