// Time parsing utilities for calendar commands.
// Resolves human-friendly time expressions (today, tomorrow, monday, +1h)
// into RFC3339 timestamps in the user's calendar timezone.
// All relative expressions are resolved against the calendar timezone, not system time.

// ---------------------------------------------------------------------------
// Weekday lookup
// ---------------------------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function findNextWeekday(name: string, from: Date, tz: string): Date {
  const target = WEEKDAYS.indexOf(name.toLowerCase())
  if (target === -1) throw new Error(`Unknown weekday: ${name}`)

  const current = getWeekdayInTz(from, tz)
  let daysAhead = target - current
  if (daysAhead <= 0) daysAhead += 7

  const result = new Date(from)
  result.setDate(result.getDate() + daysAhead)
  return result
}

function getWeekdayInTz(date: Date, tz: string): number {
  const str = date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[str] ?? 0
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

/** Get current date/time components in a specific timezone */
function nowInTz(tz: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

/** Build an RFC3339 timestamp for a date in the given timezone.
 *  Strategy: create a UTC Date near the target local time, then use Intl to find
 *  the actual offset at that moment in the target timezone. This correctly handles
 *  DST transitions because we compute the offset at the actual wall-clock time. */
function dateToRfc3339(year: number, month: number, day: number, hour: number, minute: number, tz: string): string {
  // Step 1: Approximate UTC time (assume offset is 0 initially)
  const approxUtc = new Date(Date.UTC(year, month - 1, day, hour, minute))

  // Step 2: Get the offset at this approximate time
  const offset1 = getTimezoneOffset(approxUtc, tz)

  // Step 3: Refine: the actual UTC instant for "year-month-day hour:minute in tz"
  // is approximately approxUtc - offset1
  const refinedUtc = new Date(approxUtc.getTime() - offset1 * 60000)

  // Step 4: Get the offset at the refined time (handles DST boundary correctly)
  const offset2 = getTimezoneOffset(refinedUtc, tz)

  const pad = (n: number) => String(n).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${formatOffset(offset2)}`
}

function getTimezoneOffset(utcDate: Date, tz: string): number {
  // Returns offset in minutes (positive = ahead of UTC, e.g. UTC+5:30 = 330)
  // Uses Intl.DateTimeFormat to get the actual local time components at the given UTC instant
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(utcDate)

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const localTime = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return (localTime - utcDate.getTime()) / 60000
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const hours = Math.floor(abs / 60)
  const mins = abs % 60
  return `${sign}${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Duration parsing (for --to "+1h", "+30m", "+2d")
// ---------------------------------------------------------------------------

const DURATION_RE = /^\+(\d+)(m|h|d|w)$/

export function parseDuration(input: string): number | null {
  const match = DURATION_RE.exec(input)
  if (!match) return null

  const value = Number(match[1])
  switch (match[2]) {
    case 'm': return value * 60 * 1000
    case 'h': return value * 60 * 60 * 1000
    case 'd': return value * 24 * 60 * 60 * 1000
    case 'w': return value * 7 * 24 * 60 * 60 * 1000
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Time expression parsing
// ---------------------------------------------------------------------------

/** Check if a string looks like a date-only value (YYYY-MM-DD) */
export function isDateOnly(input: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(input)
}

/** Parse a time expression into an RFC3339 string */
export function parseTimeExpression(input: string, tz: string): string {
  const trimmed = input.trim().toLowerCase()

  // Already RFC3339
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(input)) {
    // If it has timezone offset, use as-is
    if (/[+-]\d{2}:\d{2}$/.test(input) || input.endsWith('Z')) {
      return input
    }
    // Otherwise interpret in calendar timezone
    const [datePart, timePart] = input.split('T')
    const [year, month, day] = datePart!.split('-').map(Number)
    const [hour, minute] = timePart!.split(':').map(Number)
    return dateToRfc3339(year!, month!, day!, hour!, minute!, tz)
  }

  // Date only: YYYY-MM-DD — convert to start-of-day RFC3339 in calendar timezone
  // Callers that need date-only (all-day events) should check isDateOnly() before calling this.
  if (isDateOnly(input)) {
    const [year, month, day] = input.split('-').map(Number)
    return dateToRfc3339(year!, month!, day!, 0, 0, tz)
  }

  // Relative duration from now: +1h, +30m, +2d, +1w
  const durationMs = parseDuration(input.trim())
  if (durationMs !== null) {
    const n = nowInTz(tz)
    const nowRfc = dateToRfc3339(n.year, n.month, n.day, n.hour, n.minute, tz)
    return new Date(new Date(nowRfc).getTime() + durationMs).toISOString()
  }

  const { year, month, day } = nowInTz(tz)

  switch (trimmed) {
    case 'now': {
      const n = nowInTz(tz)
      return dateToRfc3339(n.year, n.month, n.day, n.hour, n.minute, tz)
    }
    case 'today':
      return dateToRfc3339(year, month, day, 0, 0, tz)
    case 'tomorrow': {
      const t = new Date(year, month - 1, day + 1)
      return dateToRfc3339(t.getFullYear(), t.getMonth() + 1, t.getDate(), 0, 0, tz)
    }
    case 'yesterday': {
      const y = new Date(year, month - 1, day - 1)
      return dateToRfc3339(y.getFullYear(), y.getMonth() + 1, y.getDate(), 0, 0, tz)
    }
  }

  // Weekday names: monday, next tuesday, etc.
  const nextMatch = trimmed.match(/^(?:next\s+)?(\w+)$/)
  if (nextMatch && WEEKDAYS.includes(nextMatch[1]!)) {
    const now = new Date()
    const target = findNextWeekday(nextMatch[1]!, now, tz)
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(target)
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
    return dateToRfc3339(get('year'), get('month'), get('day'), 0, 0, tz)
  }

  throw new Error(`Cannot parse time expression: "${input}"`)
}

// ---------------------------------------------------------------------------
// Time range resolution
// ---------------------------------------------------------------------------

export interface TimeRangeOptions {
  from?: string
  to?: string
  today?: boolean
  tomorrow?: boolean
  week?: boolean
  days?: number
  weekStart?: string
}

export interface ResolvedTimeRange {
  timeMin: string
  timeMax: string
}

/**
 * Resolve time range from command options.
 * Convenience flags (--today, --tomorrow, --week, --days) take priority over --from/--to.
 * Default: next 7 days from now.
 */
export function resolveTimeRange(opts: TimeRangeOptions, tz: string): ResolvedTimeRange {
  const { year, month, day } = nowInTz(tz)

  if (opts.today) {
    return {
      timeMin: dateToRfc3339(year, month, day, 0, 0, tz),
      timeMax: dateToRfc3339(year, month, day, 23, 59, tz),
    }
  }

  if (opts.tomorrow) {
    const t = new Date(year, month - 1, day + 1)
    return {
      timeMin: dateToRfc3339(t.getFullYear(), t.getMonth() + 1, t.getDate(), 0, 0, tz),
      timeMax: dateToRfc3339(t.getFullYear(), t.getMonth() + 1, t.getDate(), 23, 59, tz),
    }
  }

  if (opts.week) {
    const weekStartDay = WEEKDAYS.indexOf((opts.weekStart ?? 'monday').toLowerCase())
    const currentDay = getWeekdayInTz(new Date(), tz)
    let daysBack = currentDay - weekStartDay
    if (daysBack < 0) daysBack += 7

    const start = new Date(year, month - 1, day - daysBack)
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)

    return {
      timeMin: dateToRfc3339(start.getFullYear(), start.getMonth() + 1, start.getDate(), 0, 0, tz),
      timeMax: dateToRfc3339(end.getFullYear(), end.getMonth() + 1, end.getDate(), 23, 59, tz),
    }
  }

  if (opts.days && opts.days > 0) {
    const end = new Date(year, month - 1, day + opts.days - 1)
    return {
      timeMin: dateToRfc3339(year, month, day, 0, 0, tz),
      timeMax: dateToRfc3339(end.getFullYear(), end.getMonth() + 1, end.getDate(), 23, 59, tz),
    }
  }

  // Explicit --from / --to
  if (opts.from || opts.to) {
    const fromStr = opts.from ? parseTimeExpression(opts.from, tz) : dateToRfc3339(year, month, day, 0, 0, tz)

    let toStr: string
    if (opts.to) {
      // Check if --to is a duration relative to --from
      const durationMs = parseDuration(opts.to)
      if (durationMs !== null) {
        const fromDate = new Date(fromStr)
        toStr = new Date(fromDate.getTime() + durationMs).toISOString()
      } else if (isDateOnly(opts.to)) {
        // Date-only --to means "through end of that day" (23:59),
        // consistent with --today/--tomorrow/--week convenience flags.
        const [y, m, d] = opts.to.split('-').map(Number)
        toStr = dateToRfc3339(y!, m!, d!, 23, 59, tz)
      } else {
        toStr = parseTimeExpression(opts.to, tz)
      }
    } else {
      // Default to 7 days from --from
      const fromDate = new Date(fromStr)
      toStr = new Date(fromDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
    }

    return { timeMin: fromStr, timeMax: toStr }
  }

  // Default: next 7 days
  const end = new Date(year, month - 1, day + 7)
  return {
    timeMin: dateToRfc3339(year, month, day, 0, 0, tz),
    timeMax: dateToRfc3339(end.getFullYear(), end.getMonth() + 1, end.getDate(), 0, 0, tz),
  }
}
