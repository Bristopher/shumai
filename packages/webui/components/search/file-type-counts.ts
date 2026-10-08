/**
 * Format a file count for the file-type filter in the reader's locale ("1,204" in en, "1 204" in
 * fr). Pass the locale explicitly in tests; the UI passes the active paraglide locale.
 */
export function formatFileCount(count: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale).format(count)
  } catch {
    // An unknown locale tag makes Intl throw; fall back to the runtime default.
    return new Intl.NumberFormat().format(count)
  }
}
