import type { AssetInfo } from '@shumai/dtos'
import { describe, expect, it } from 'vitest'
import { captureDateOf, groupFilesByDay } from './date-groups'

const file = (id: string, taken?: string): AssetInfo =>
  ({
    id,
    name: `${id}.JPG`,
    fieldValues: taken ? [{ fieldId: 'capture_date', value: taken }] : [],
  }) as unknown as AssetInfo

// Local noon, so the calendar day is the same in every test time zone.
const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h).toISOString()

describe('captureDateOf', () => {
  it('reads the capture_date field', () => {
    expect(captureDateOf(file('a', at(2026, 9, 6)))?.getDate()).toBe(6)
  })

  it('is null without a date taken or with a bad value', () => {
    expect(captureDateOf(file('a'))).toBeNull()
    expect(captureDateOf(file('b', 'not a date'))).toBeNull()
  })
})

describe('groupFilesByDay', () => {
  it('splits sorted files into contiguous days, keeping their order', () => {
    const files = [
      file('a', at(2026, 9, 6, 15)),
      file('b', at(2026, 9, 6, 9)),
      file('c', at(2026, 9, 5)),
      file('d'),
    ]
    const groups = groupFilesByDay(files, 'No date taken')
    expect(groups.map((g) => g.day)).toEqual(['2026-09-06', '2026-09-05', 'undated'])
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['a', 'b'], ['c'], ['d']])
    expect(groups[2].label).toBe('No date taken')
  })

  it('gives a day that appears in two runs a unique key', () => {
    const groups = groupFilesByDay(
      [file('a', at(2026, 9, 6)), file('b'), file('c', at(2026, 9, 6))],
      'none',
    )
    expect(groups.map((g) => g.key)).toEqual(['2026-09-06', 'undated', '2026-09-06-2'])
  })
})
