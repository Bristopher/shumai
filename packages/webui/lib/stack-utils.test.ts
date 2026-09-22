import { describe, expect, it } from 'vitest'
import { expandStackIds } from './stack-utils'

describe('expandStackIds', () => {
  it('keeps plain items as they are', () => {
    expect(expandStackIds([{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b'])
  })

  it('expands a stacked card to every file of its shot, once each', () => {
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
    expect(expandStackIds([jpg, { id: 'other' }])).toEqual(['jpg', 'raf', 'xmp', 'other'])
  })
})
