// Tests for calendar time range resolution logic.

import { expect, test, describe } from 'vitest'
import { resolveTimeRange, parseTimeExpression, isDateOnly } from './calendar-time.js'

const tz = 'America/New_York'

describe('resolveTimeRange', () => {
  test('same-day --from and --to produces full day range', () => {
    const range = resolveTimeRange({ from: '2026-03-12', to: '2026-03-12' }, tz)
    // --from date-only → start of day (00:00)
    expect(range.timeMin).toMatch(/^2026-03-12T00:00:00/)
    // --to date-only → end of day (23:59)
    expect(range.timeMax).toMatch(/^2026-03-12T23:59:00/)
  })

  test('--to date-only resolves to end of day', () => {
    const range = resolveTimeRange({ from: '2026-03-10', to: '2026-03-14' }, tz)
    expect(range.timeMin).toMatch(/^2026-03-10T00:00:00/)
    expect(range.timeMax).toMatch(/^2026-03-14T23:59:00/)
  })

  test('--to with explicit time is preserved', () => {
    const range = resolveTimeRange({ from: '2026-03-12', to: '2026-03-12T14:00' }, tz)
    expect(range.timeMin).toMatch(/^2026-03-12T00:00:00/)
    expect(range.timeMax).toMatch(/^2026-03-12T14:00:00/)
  })

  test('--to with duration is relative to --from', () => {
    const range = resolveTimeRange({ from: '2026-03-12', to: '+2d' }, tz)
    expect(range.timeMin).toMatch(/^2026-03-12T00:00:00/)
    // 2 days after 2026-03-12T00:00
    expect(range.timeMax).toMatch(/^2026-03-14/)
  })
})
