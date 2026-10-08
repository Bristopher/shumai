import type { AssetInfo } from '@shumai/dtos'

export interface DayGroup {
  /** Local calendar day ("2026-09-06"), or "undated". */
  day: string
  /** Unique across the list (a day split into two runs gets a suffix). */
  key: string
  label: string
  items: AssetInfo[]
}

/** The file's date taken (the `capture_date` system field), or null. */
export function captureDateOf(file: Pick<AssetInfo, 'fieldValues'>): Date | null {
  const raw = file.fieldValues?.find((v) => v.fieldId === 'capture_date')?.value
  if (typeof raw !== 'string' && !(raw instanceof Date)) return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d
}

function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Split files already sorted by date taken into runs of the same local day, keeping their order
 * (so a group's items are contiguous in `files`). Files without a date form "undated" runs.
 */
export function groupFilesByDay(files: AssetInfo[], undatedLabel: string): DayGroup[] {
  const groups: DayGroup[] = []
  for (const file of files) {
    const d = captureDateOf(file)
    const day = d ? localDayKey(d) : 'undated'
    const last = groups[groups.length - 1]
    if (last && last.day === day) {
      last.items.push(file)
      continue
    }
    groups.push({
      day,
      key: groups.some((g) => g.day === day) ? `${day}-${groups.length}` : day,
      label: d
        ? d.toLocaleDateString(undefined, {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })
        : undatedLabel,
      items: [file],
    })
  }
  return groups
}
