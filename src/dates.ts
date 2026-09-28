// Shared date formatting. Commits are rendered as ISO-8601 calendar dates
// (`YYYY-MM-DD`) in the viewer's local timezone, so they match the wall clock.

interface DateParts {
  y: number;
  m: number;
  d: number;
  hh: string;
  mm: string;
}

function parts(unixSeconds: number): DateParts {
  const d = new Date(unixSeconds * 1000);
  return {
    y: d.getFullYear(),
    m: d.getMonth() + 1,
    d: d.getDate(),
    hh: String(d.getHours()).padStart(2, '0'),
    mm: String(d.getMinutes()).padStart(2, '0'),
  };
}

/** `YYYY-MM-DD` (local calendar day). */
export function isoDate(unixSeconds: number): string {
  const { y, m, d } = parts(unixSeconds);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** `YYYY-MM-DD HH:MM` (local), for tooltips. */
export function isoDateTime(unixSeconds: number): string {
  return `${isoDate(unixSeconds)} ${parts(unixSeconds).hh}:${parts(unixSeconds).mm}`;
}
