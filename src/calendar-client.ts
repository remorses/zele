// CalDAV-based calendar client for CLI use.
// Uses tsdav for CalDAV protocol and ts-ics for typed iCalendar parse/generate.
// Auth: passes a Bearer token via headers (reuses existing google-auth-library OAuth2).
// Google CalDAV endpoint: https://apidata.googleusercontent.com/caldav/v2/

import {
  fetchCalendars,
  fetchCalendarObjects,
  createCalendarObject,
  updateCalendarObject,
  deleteCalendarObject,
  type DAVCalendar,
  type DAVCalendarObject,
} from 'tsdav'
import {
  convertIcsCalendar,
  generateIcsCalendar,
  type IcsCalendar,
  type IcsEvent,
  type IcsAttendee,
  type IcsDateObject,
} from 'ts-ics'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Types (kept identical to previous API so commands layer is unchanged)
// ---------------------------------------------------------------------------

export interface CalendarListItem {
  id: string
  summary: string
  primary: boolean
  role: string
  timezone: string
  backgroundColor: string
}

export interface CalendarEvent {
  id: string
  summary: string
  start: string // RFC3339 or date
  end: string
  startDate?: string // date-only for all-day events
  endDate?: string
  allDay: boolean
  description: string
  location: string
  status: string
  htmlLink: string
  meetLink: string | null
  attendees: CalendarAttendee[]
  recurrence: string[]
  reminders: CalendarReminder[]
  colorId: string | null
  visibility: string
  transparency: string
  calendarId?: string // set when merging across calendars
  // CalDAV-specific: needed for update/delete
  url?: string
  etag?: string
  uid?: string
}

export interface CalendarAttendee {
  email: string
  name: string | null
  status: string
  self: boolean
  organizer: boolean
}

export interface CalendarReminder {
  method: string
  minutes: number
}

export interface EventListResult {
  events: CalendarEvent[]
  nextPageToken: string | null
  timezone: string
}

export interface FreeBusyBlock {
  start: string
  end: string
}

export interface FreeBusyResult {
  calendar: string
  busy: FreeBusyBlock[]
}

// ---------------------------------------------------------------------------
// ts-ics conversion helpers
// ---------------------------------------------------------------------------

/** Convert an IcsDateObject to an RFC3339 string or YYYY-MM-DD date string */
function icsDateToString(d: IcsDateObject): string {
  if (d.type === 'DATE') {
    // All-day: return YYYY-MM-DD
    return d.date.toISOString().split('T')[0]!
  }
  return d.date.toISOString()
}

/** Map ts-ics PARTSTAT to our lowercase status */
function mapPartstat(partstat?: string): string {
  if (!partstat) return 'needsAction'
  switch (partstat) {
    case 'ACCEPTED': return 'accepted'
    case 'DECLINED': return 'declined'
    case 'TENTATIVE': return 'tentative'
    case 'NEEDS-ACTION': return 'needsAction'
    default: return partstat.toLowerCase()
  }
}

/** Create an IcsDateObject from an RFC3339 string or YYYY-MM-DD */
function toIcsDate(dateStr: string, allDay = false): IcsDateObject {
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { date: new Date(dateStr + 'T00:00:00Z'), type: 'DATE' }
  }
  return { date: new Date(dateStr), type: 'DATE-TIME' }
}

/** Generate a new UID for calendar events */
function generateUID(): string {
  return `${crypto.randomUUID()}@zele`
}

/** Convert a single IcsEvent to our CalendarEvent type */
function icsEventToCalendarEvent(event: IcsEvent, calObj?: DAVCalendarObject): CalendarEvent {
  const allDay = event.start.type === 'DATE'

  const startStr = icsDateToString(event.start)
  // ts-ics events have either `end` or `duration`
  const endDate = event.end
    ? icsDateToString(event.end)
    : startStr // fallback if no end

  // Attendees
  const attendees: CalendarAttendee[] = (event.attendees ?? []).map((a) => ({
    email: a.email,
    name: a.name ?? null,
    status: mapPartstat(a.partstat),
    self: false,
    organizer: false,
  }))

  // Mark organizer in attendees
  if (event.organizer) {
    for (const a of attendees) {
      if (a.email.toLowerCase() === event.organizer!.email.toLowerCase()) {
        a.organizer = true
      }
    }
  }

  // Extract Meet link from description
  let meetLink: string | null = null
  const desc = event.description ?? ''
  const meetMatch = desc.match(/https:\/\/meet\.google\.com\/[\w-]+/)
  if (meetMatch) meetLink = meetMatch[0]

  // Recurrence rules — convert back to RRULE string if present
  const recurrence: string[] = []
  if (event.recurrenceRule) {
    // ts-ics stores parsed rule; we'd need to re-serialize — store as-is for display
    const r = event.recurrenceRule
    const parts: string[] = [`FREQ=${r.frequency}`]
    if (r.interval) parts.push(`INTERVAL=${r.interval}`)
    if (r.count) parts.push(`COUNT=${r.count}`)
    if (r.until) parts.push(`UNTIL=${icsDateToString(r.until).replace(/[-:]/g, '')}`)
    if (r.byDay) parts.push(`BYDAY=${r.byDay.map((d) => (d.occurrence ?? '') + d.day).join(',')}`)
    if (r.byMonth) parts.push(`BYMONTH=${r.byMonth.join(',')}`)
    if (r.byMonthday) parts.push(`BYMONTHDAY=${r.byMonthday.join(',')}`)
    recurrence.push(`RRULE:${parts.join(';')}`)
  }

  // Reminders from alarms
  const reminders: CalendarReminder[] = (event.alarms ?? []).map((alarm) => {
    let minutes = 0
    if (alarm.trigger.type === 'relative') {
      const d = alarm.trigger.value
      minutes = (d.weeks ?? 0) * 10080 + (d.days ?? 0) * 1440 + (d.hours ?? 0) * 60 + (d.minutes ?? 0)
    }
    return { method: alarm.action ?? 'popup', minutes }
  })

  return {
    id: event.uid,
    summary: event.summary || '(no title)',
    start: startStr,
    end: endDate,
    startDate: allDay ? startStr : undefined,
    endDate: allDay ? endDate : undefined,
    allDay,
    description: desc,
    location: event.location ?? '',
    status: (event.status ?? 'CONFIRMED').toLowerCase(),
    htmlLink: '',
    meetLink,
    attendees,
    recurrence,
    reminders,
    colorId: null,
    visibility: event.class === 'PRIVATE' ? 'private' : 'default',
    transparency: event.timeTransparent === 'TRANSPARENT' ? 'transparent' : 'opaque',
    url: calObj?.url,
    etag: calObj?.etag,
    uid: event.uid,
  }
}

/** Parse all events from a raw iCal data string using ts-ics */
function parseICalData(data: string, calObj?: DAVCalendarObject): CalendarEvent[] {
  try {
    const calendar = convertIcsCalendar(undefined, data)
    return (calendar.events ?? []).map((ev) => icsEventToCalendarEvent(ev, calObj))
  } catch {
    return []
  }
}

/** Build an iCal string from event properties using ts-ics */
function buildICalString(props: {
  uid?: string
  summary: string
  start: string
  end: string
  allDay?: boolean
  description?: string
  location?: string
  attendees?: Array<{ email: string; name?: string; partstat?: string }>
  recurrence?: string[]
  transparency?: string
  visibility?: string
  status?: string
  sequence?: number
  organizer?: { email: string; name?: string }
}): string {
  const uid = props.uid ?? generateUID()
  const now: IcsDateObject = { date: new Date(), type: 'DATE-TIME' }

  const event: IcsEvent = {
    uid,
    summary: props.summary,
    stamp: now,
    start: toIcsDate(props.start, props.allDay),
    end: toIcsDate(props.end, props.allDay),
  }

  if (props.description) event.description = props.description
  if (props.location) event.location = props.location
  if (props.status) event.status = props.status.toUpperCase() as any
  if (props.transparency) event.timeTransparent = props.transparency.toUpperCase() as any
  if (props.visibility === 'private') event.class = 'PRIVATE'
  if (props.sequence !== undefined) event.sequence = props.sequence

  if (props.organizer) {
    event.organizer = { email: props.organizer.email, name: props.organizer.name }
  }

  if (props.attendees && props.attendees.length > 0) {
    event.attendees = props.attendees.map((a): IcsAttendee => ({
      email: a.email,
      name: a.name,
      partstat: (a.partstat as any) ?? 'NEEDS-ACTION',
      rsvp: true,
    }))
  }

  const calendar: IcsCalendar = {
    version: '2.0',
    prodId: '-//zele//zele CLI//EN',
    events: [event],
  }

  return generateIcsCalendar(calendar)
}

// ---------------------------------------------------------------------------
// CalDAV timezone extraction
// ---------------------------------------------------------------------------

/** Extract IANA timezone name from CalDAV timezone data.
 *  The timezone field may contain raw VTIMEZONE iCal data like:
 *  BEGIN:VCALENDAR\n...TZID:Europe/Rome\n...END:VCALENDAR
 *  We extract the TZID value from it. */
function extractTimezone(tz?: string): string {
  if (!tz) return 'UTC'
  // If it's already an IANA timezone name (no whitespace/newlines), return as-is
  if (!tz.includes('\n') && !tz.includes('BEGIN:')) return tz
  // Extract TZID from VTIMEZONE data
  const match = tz.match(/TZID:(.+)/m)
  if (match) return match[1]!.trim()
  // Try X-WR-TIMEZONE
  const wrMatch = tz.match(/X-WR-TIMEZONE:(.+)/m)
  if (wrMatch) return wrMatch[1]!.trim()
  return 'UTC'
}

// ---------------------------------------------------------------------------
// CalendarClient
// ---------------------------------------------------------------------------

const GOOGLE_CALDAV_URL = 'https://apidata.googleusercontent.com/caldav/v2/'

export class CalendarClient {
  private headers: Record<string, string>
  private email: string
  private calendarCache: DAVCalendar[] | null = null
  private timezoneCache: Record<string, string> = {}

  constructor({ accessToken, email }: { accessToken: string; email: string }) {
    this.headers = { Authorization: `Bearer ${accessToken}` }
    this.email = email
  }

  /** Update the access token (e.g. after refresh) */
  updateAccessToken(token: string) {
    this.headers = { Authorization: `Bearer ${token}` }
  }

  // =========================================================================
  // Internal: fetch DAVCalendar list (cached per instance)
  // =========================================================================

  private async fetchDAVCalendars(): Promise<DAVCalendar[]> {
    if (this.calendarCache) return this.calendarCache

    const calendars = await fetchCalendars({
      account: {
        serverUrl: GOOGLE_CALDAV_URL,
        rootUrl: GOOGLE_CALDAV_URL,
        accountType: 'caldav',
        homeUrl: `${GOOGLE_CALDAV_URL}${this.email}/`,
      },
      headers: this.headers,
    })

    this.calendarCache = calendars
    return calendars
  }

  /** Resolve a calendarId to a DAVCalendar. 'primary' maps to the user's email. */
  private async resolveCalendar(calendarId: string): Promise<DAVCalendar> {
    const calendars = await this.fetchDAVCalendars()

    // 'primary' = the user's own calendar (URL contains their email)
    const targetId = calendarId === 'primary' ? this.email : calendarId

    const match = calendars.find((c) => {
      const urlLower = c.url.toLowerCase()
      return urlLower.includes(`/${encodeURIComponent(targetId).toLowerCase()}/`) ||
        urlLower.includes(`/${targetId.toLowerCase()}/`)
    })

    if (!match) {
      throw new Error(`Calendar not found: ${calendarId}. Available: ${calendars.map((c) => c.displayName || c.url).join(', ')}`)
    }

    return match
  }

  // =========================================================================
  // Calendar list
  // =========================================================================

  async listCalendars(): Promise<CalendarListItem[]> {
    const calendars = await this.fetchDAVCalendars()

    return calendars.map((cal) => {
      // Extract calendar ID from URL
      // URL looks like: https://apidata.googleusercontent.com/caldav/v2/user%40gmail.com/events/
      const urlParts = cal.url.replace(/\/$/, '').split('/')
      const eventsIdx = urlParts.indexOf('events')
      const idEncoded = eventsIdx > 0 ? urlParts[eventsIdx - 1]! : urlParts[urlParts.length - 1]!
      const id = decodeURIComponent(idEncoded)

      const isPrimary = id.toLowerCase() === this.email.toLowerCase()

      return {
        id,
        summary: typeof cal.displayName === 'string'
          ? cal.displayName
          : (cal.displayName as any)?._text ?? id,
        primary: isPrimary,
        role: 'owner',
        timezone: extractTimezone(cal.timezone),
        backgroundColor: cal.calendarColor ?? '',
      }
    })
  }

  // =========================================================================
  // Timezone
  // =========================================================================

  async getTimezone(calendarId = 'primary'): Promise<string> {
    if (this.timezoneCache[calendarId]) return this.timezoneCache[calendarId]!

    try {
      const cal = await this.resolveCalendar(calendarId)
      const tz = extractTimezone(cal.timezone)
      this.timezoneCache[calendarId] = tz
      return tz
    } catch {
      const calendars = await this.listCalendars()
      const target = calendarId === 'primary' ? this.email : calendarId
      const match = calendars.find((c) => c.id.toLowerCase() === target.toLowerCase())
      const tz = match?.timezone || 'UTC'
      this.timezoneCache[calendarId] = tz
      return tz
    }
  }

  // =========================================================================
  // Events
  // =========================================================================

  async listEvents({
    calendarId = 'primary',
    timeMin,
    timeMax,
    query,
    maxResults = 20,
    pageToken,
  }: {
    calendarId?: string
    timeMin?: string
    timeMax?: string
    query?: string
    maxResults?: number
    pageToken?: string
  } = {}): Promise<EventListResult> {
    const cal = await this.resolveCalendar(calendarId)
    const tz = await this.getTimezone(calendarId)

    const fetchOpts: Parameters<typeof fetchCalendarObjects>[0] = {
      calendar: cal,
      headers: this.headers,
      urlFilter: () => true,
    }

    if (timeMin && timeMax) {
      fetchOpts.timeRange = { start: timeMin, end: timeMax }
    }

    const calObjects = await fetchCalendarObjects(fetchOpts)

    let events: CalendarEvent[] = []
    for (const obj of calObjects) {
      if (!obj.data) continue
      events.push(...parseICalData(obj.data, obj))
    }

    if (query) {
      const q = query.toLowerCase()
      events = events.filter((e) =>
        e.summary.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.location.toLowerCase().includes(q),
      )
    }

    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

    return {
      events: events.slice(0, maxResults),
      nextPageToken: null,
      timezone: tz,
    }
  }

  async getEvent({
    calendarId = 'primary',
    eventId,
  }: {
    calendarId?: string
    eventId: string
  }): Promise<CalendarEvent> {
    const cal = await this.resolveCalendar(calendarId)

    const calObjects = await fetchCalendarObjects({
      calendar: cal,
      headers: this.headers,
      urlFilter: () => true,
    })

    for (const obj of calObjects) {
      if (!obj.data) continue
      const events = parseICalData(obj.data, obj)
      const match = events.find((e) => e.id === eventId || e.uid === eventId)
      if (match) return match
    }

    throw new Error(`Event not found: ${eventId}`)
  }

  async createEvent({
    calendarId = 'primary',
    summary,
    start,
    end,
    allDay = false,
    description,
    location,
    attendees,
    withMeet = false,
    recurrence,
    reminders,
    colorId,
    visibility,
    transparency,
  }: {
    calendarId?: string
    summary: string
    start: string
    end: string
    allDay?: boolean
    description?: string
    location?: string
    attendees?: string[]
    withMeet?: boolean
    recurrence?: string[]
    reminders?: Array<{ method: string; minutes: number }>
    colorId?: string
    visibility?: string
    transparency?: string
  }): Promise<CalendarEvent> {
    const cal = await this.resolveCalendar(calendarId)
    const uid = generateUID()

    const iCalString = buildICalString({
      uid,
      summary,
      start,
      end,
      allDay,
      description,
      location,
      attendees: attendees?.map((email) => ({ email })),
      transparency,
      visibility,
      organizer: { email: this.email },
    })

    const filename = `${uid.split('@')[0]}.ics`

    await createCalendarObject({
      calendar: cal,
      filename,
      iCalString,
      headers: this.headers,
    })

    const events = parseICalData(iCalString)
    const event = events[0]
    if (!event) throw new Error('Failed to parse created event')
    event.url = `${cal.url}${filename}`

    return event
  }

  async updateEvent({
    calendarId = 'primary',
    eventId,
    summary,
    start,
    end,
    allDay,
    description,
    location,
    addAttendees,
    removeAttendees,
    withMeet,
    colorId,
    visibility,
    transparency,
  }: {
    calendarId?: string
    eventId: string
    summary?: string
    start?: string
    end?: string
    allDay?: boolean
    description?: string
    location?: string
    addAttendees?: string[]
    removeAttendees?: string[]
    withMeet?: boolean
    colorId?: string
    visibility?: string
    transparency?: string
  }): Promise<CalendarEvent> {
    const existing = await this.getEvent({ calendarId, eventId })
    if (!existing.url || !existing.etag) {
      throw new Error(`Cannot update event: missing CalDAV URL or etag for event ${eventId}`)
    }

    // Handle attendee add/remove
    let mergedAttendees = existing.attendees.map((a) => ({
      email: a.email,
      name: a.name ?? undefined,
      partstat: a.status === 'needsAction' ? 'NEEDS-ACTION' : a.status.toUpperCase(),
    }))
    if (removeAttendees) {
      const removeSet = new Set(removeAttendees.map((e) => e.toLowerCase()))
      mergedAttendees = mergedAttendees.filter((a) => !removeSet.has(a.email.toLowerCase()))
    }
    if (addAttendees) {
      const existingSet = new Set(mergedAttendees.map((a) => a.email.toLowerCase()))
      for (const email of addAttendees) {
        if (!existingSet.has(email.toLowerCase())) {
          mergedAttendees.push({ email, name: undefined, partstat: 'NEEDS-ACTION' })
        }
      }
    }

    const iCalString = buildICalString({
      uid: existing.uid ?? eventId,
      summary: summary ?? existing.summary,
      start: start ?? existing.start,
      end: end ?? existing.end,
      allDay: allDay ?? existing.allDay,
      description: description !== undefined ? description : existing.description || undefined,
      location: location !== undefined ? location : existing.location || undefined,
      attendees: mergedAttendees.length > 0 ? mergedAttendees : undefined,
      transparency: transparency ?? existing.transparency,
      visibility: visibility ?? existing.visibility,
      sequence: 1,
      organizer: { email: this.email },
    })

    await updateCalendarObject({
      calendarObject: { url: existing.url, data: iCalString, etag: existing.etag },
      headers: this.headers,
    })

    const events = parseICalData(iCalString)
    const event = events[0]
    if (!event) throw new Error('Failed to parse updated event')
    event.url = existing.url
    event.etag = existing.etag

    return event
  }

  async deleteEvent({
    calendarId = 'primary',
    eventId,
  }: {
    calendarId?: string
    eventId: string
  }): Promise<void> {
    const existing = await this.getEvent({ calendarId, eventId })
    if (!existing.url) {
      throw new Error(`Cannot delete event: missing CalDAV URL for event ${eventId}`)
    }

    await deleteCalendarObject({
      calendarObject: { url: existing.url, etag: existing.etag },
      headers: this.headers,
    })
  }

  async respondToEvent({
    calendarId = 'primary',
    eventId,
    status,
    comment,
  }: {
    calendarId?: string
    eventId: string
    status: 'accepted' | 'declined' | 'tentative'
    comment?: string
  }): Promise<CalendarEvent> {
    const existing = await this.getEvent({ calendarId, eventId })
    if (!existing.url || !existing.etag) {
      throw new Error(`Cannot respond to event: missing CalDAV URL or etag for event ${eventId}`)
    }

    // Update our PARTSTAT in attendees
    const attendees = existing.attendees.map((a) => ({
      email: a.email,
      name: a.name ?? undefined,
      partstat: a.email.toLowerCase() === this.email.toLowerCase()
        ? status.toUpperCase()
        : (a.status === 'needsAction' ? 'NEEDS-ACTION' : a.status.toUpperCase()),
    }))

    const organizer = existing.attendees.find((a) => a.organizer)

    const iCalString = buildICalString({
      uid: existing.uid ?? eventId,
      summary: existing.summary,
      start: existing.start,
      end: existing.end,
      allDay: existing.allDay,
      description: existing.description || undefined,
      location: existing.location || undefined,
      attendees,
      organizer: organizer
        ? { email: organizer.email, name: organizer.name ?? undefined }
        : { email: this.email },
    })

    await updateCalendarObject({
      calendarObject: { url: existing.url, data: iCalString, etag: existing.etag },
      headers: this.headers,
    })

    const events = parseICalData(iCalString)
    const event = events[0]
    if (!event) throw new Error('Failed to parse response event')
    event.url = existing.url

    return event
  }

  async getFreeBusy({
    calendarIds,
    timeMin,
    timeMax,
  }: {
    calendarIds: string[]
    timeMin: string
    timeMax: string
  }): Promise<FreeBusyResult[]> {
    const results: FreeBusyResult[] = []

    for (const calId of calendarIds) {
      try {
        const { events } = await this.listEvents({
          calendarId: calId,
          timeMin,
          timeMax,
          maxResults: 200,
        })

        const busy: FreeBusyBlock[] = events
          .filter((e) => e.transparency !== 'transparent' && !e.allDay)
          .map((e) => ({ start: e.start, end: e.end }))

        results.push({ calendar: calId, busy })
      } catch {
        results.push({ calendar: calId, busy: [] })
      }
    }

    return results
  }

  // =========================================================================
  // Focus Time / OOO helpers
  // =========================================================================

  async createFocusTime({
    calendarId = 'primary',
    start,
    end,
    summary = 'Focus Time',
    recurrence,
  }: {
    calendarId?: string
    start: string
    end: string
    summary?: string
    recurrence?: string[]
  }): Promise<CalendarEvent> {
    return this.createEvent({
      calendarId,
      summary,
      start,
      end,
      transparency: 'opaque',
      recurrence,
    })
  }

  async createOutOfOffice({
    calendarId = 'primary',
    start,
    end,
    summary = 'Out of office',
    message = 'I am out of office and will respond when I return.',
    allDay = false,
  }: {
    calendarId?: string
    start: string
    end: string
    summary?: string
    message?: string
    allDay?: boolean
  }): Promise<CalendarEvent> {
    return this.createEvent({
      calendarId,
      summary,
      start,
      end,
      allDay,
      description: message,
      transparency: 'opaque',
    })
  }
}
