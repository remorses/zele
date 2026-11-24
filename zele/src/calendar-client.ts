// Calendar client interface used by the `zele cal` commands, and its CalDAV implementation.
// Two implementations, picked per account by its granted scopes (getCalendarClients in auth.ts):
// - CalDavCalendarClient (this file): Google CalDAV, needs the full `calendar` scope.
//   Used by the third-party clients (Thunderbird, GNOME, KDE) and custom clients.
// - GoogleCalendarApiClient (google-calendar-client.ts): Calendar REST API, needs only
//   `calendar.events` + `calendar.calendarlist.readonly`. Used by zele's own client.
//
// CalDAV implementation:
// Uses tsdav for CalDAV protocol and ts-ics for typed iCalendar parse/generate.
// Auth: passes a Bearer token via headers (reuses existing google-auth-library OAuth2).
// Google CalDAV endpoint: https://apidata.googleusercontent.com/caldav/v2/
// Cache is built into the client for stable metadata lookups (calendar list/timezone).
// Event listing is always fresh so CLI output reflects newly created/updated events.
// Raw tsdav responses are stored in the cache so the cache is resilient to changes
// in our own parsed types. Parsing happens at read time.

import {
  fetchCalendars,
  calendarQuery,
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
import * as errore from 'errore'
import * as orm from 'drizzle-orm'
import { getDb, schema } from './db.js'
import { AuthError, isAuthLikeError, ApiError, NotFoundError, ParseError, MissingDataError } from './api-utils.js'

/** Boundary helper: wrap a tsdav/CalDAV call, converting auth-like errors to AuthError values.
 *  Non-auth errors are wrapped in ApiError so they remain error values (no throwing).
 *  Original error is preserved as `cause` for debugging. */
function caldavBoundary<T>(email: string, fn: () => Promise<T>) {
  return errore.tryAsync({
    try: fn,
    catch: (err) => isAuthLikeError(err)
      ? new AuthError({ email, reason: String(err) })
      : new ApiError({ reason: String(err), cause: err }),
  })
}

/** Turn a non-ok HTTP response into an error value.
 *  tsdav write helpers (PUT, DELETE) return the raw Response without checking its status. */
function responseError({ email, res, what }: { email: string; res: Response; what: string }): AuthError | ApiError | undefined {
  if (res.ok) return undefined
  const reason = `${what} failed: ${res.status} ${res.statusText}`
  if (res.status === 401) return new AuthError({ email, reason })
  return new ApiError({ reason })
}

// ---------------------------------------------------------------------------
// Shared types and the CalendarClient interface
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
  ics?: string // raw iCalendar object, patched in place by respondToEvent
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

export interface ListEventsParams {
  calendarId?: string
  timeMin?: string
  timeMax?: string
  query?: string
  maxResults?: number
  pageToken?: string
}

export interface EventRef {
  calendarId?: string
  eventId: string
}

export interface CreateEventParams {
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
  reminders?: CalendarReminder[]
  colorId?: string
  visibility?: string
  transparency?: string
}

export interface UpdateEventParams extends EventRef {
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
}

export interface RespondParams extends EventRef {
  status: 'accepted' | 'declined' | 'tentative'
  comment?: string
}

export type CalendarWriteError = AuthError | ApiError | NotFoundError | MissingDataError | ParseError

/** What the `zele cal` commands need from a calendar backend. `calendarId` defaults to 'primary'. */
export interface CalendarClient {
  listCalendars(): Promise<CalendarListItem[] | AuthError | ApiError>
  getTimezone(calendarId?: string): Promise<string | AuthError | ApiError | NotFoundError>
  listEvents(params?: ListEventsParams): Promise<EventListResult | AuthError | ApiError | NotFoundError>
  getEvent(params: EventRef): Promise<CalendarEvent | AuthError | ApiError | NotFoundError>
  createEvent(params: CreateEventParams): Promise<CalendarEvent | CalendarWriteError>
  updateEvent(params: UpdateEventParams): Promise<CalendarEvent | CalendarWriteError>
  deleteEvent(params: EventRef): Promise<void | CalendarWriteError>
  respondToEvent(params: RespondParams): Promise<CalendarEvent | CalendarWriteError>
}

const FREEBUSY_MAX_EVENTS = 200

/** Busy blocks per calendar from its events. A calendar that fails to load shows as free. */
export async function getFreeBusy({ client, calendarIds, timeMin, timeMax }: {
  client: CalendarClient
  calendarIds: string[]
  timeMin: string
  timeMax: string
}): Promise<FreeBusyResult[]> {
  return Promise.all(
    calendarIds.map(async (calendarId) => {
      const result = await client.listEvents({ calendarId, timeMin, timeMax, maxResults: FREEBUSY_MAX_EVENTS })
      if (result instanceof Error) {
        console.warn(`freebusy: ${calendarId}: ${result.message}`)
        return { calendar: calendarId, busy: [] }
      }
      const busy = result.events
        .filter((e) => e.transparency !== 'transparent' && !e.allDay)
        .map((e) => ({ start: e.start, end: e.end }))
      return { calendar: calendarId, busy }
    }),
  )
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

/** Object URL for an event uid: `<calendar url><encoded uid>.ics`.
 *  Google serves its own events at this URL, and createEvent saves new events there. */
function eventObjectUrl(calendarUrl: string, uid: string): string {
  const base = calendarUrl.endsWith('/') ? calendarUrl : `${calendarUrl}/`
  return `${base}${encodeURIComponent(uid)}.ics`
}

/** CalDAV UTC time format for time-range filters: 20261114T100000Z */
function caldavTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`
}

/** Read a text value from a parsed DAV property (string, `{_cdata}` or `{_text}`). */
function davText(value: string | { _cdata?: string; _text?: string } | undefined): string | undefined {
  if (typeof value === 'string') return value
  return value?._cdata ?? value?._text
}

/** Find the event with this id or uid in calendar objects, skipping unparseable ones. */
function findEventInObjects(objects: DAVCalendarObject[], eventId: string): CalendarEvent | undefined {
  for (const obj of objects) {
    if (!obj.data) continue
    const events = parseICalData(obj.data, obj)
    if (events instanceof ParseError) continue
    const match = events.find((e) => e.id === eventId || e.uid === eventId)
    if (match) return match
  }
  return undefined
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
    ics: calObj?.data,
  }
}

/** Set PARTSTAT on the ATTENDEE lines for `email`, leaving the rest of the object untouched */
function setOwnPartstat(ics: string, email: string, partstat: string): string {
  const mailto = `mailto:${email.toLowerCase()}`
  return ics
    .replace(/\r?\n[ \t]/g, '') // unfold
    .split(/\r?\n/)
    .map((line) => {
      if (!/^ATTENDEE[;:]/i.test(line)) return line
      const i = line.search(/:mailto:/i)
      if (i < 0 || line.slice(i + 1).toLowerCase() !== mailto) return line
      const params = line.slice(0, i).split(';').filter((p) => !/^(PARTSTAT|RSVP)=/i.test(p))
      return [...params, `PARTSTAT=${partstat}`].join(';') + line.slice(i)
    })
    .join('\r\n')
}

/** Parse all events from a raw iCal data string using ts-ics.
 *  Boundary: convertIcsCalendar (ts-ics library) may throw on malformed iCal.
 *  Returns ParseError on failure so callers can decide how to handle it. */
function parseICalData(data: string, calObj?: DAVCalendarObject): ParseError | CalendarEvent[] {
  const calendar = errore.tryFn(() => convertIcsCalendar(undefined, data))
  if (calendar instanceof Error) return new ParseError({ what: 'iCal data', reason: calendar.message })
  return (calendar.events ?? []).map((ev) => icsEventToCalendarEvent(ev, calObj))
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

const TTL = {
  CALENDAR_LIST: 30 * 60 * 1000, // 30 minutes
} as const

function isExpired(createdAt: Date, ttlMs: number): boolean {
  return createdAt.getTime() + ttlMs < Date.now()
}

export class CalDavCalendarClient implements CalendarClient {
  private headers: Record<string, string>
  private email: string
  private appId: string
  private serverUrl: string
  private calendarCache: DAVCalendar[] | null = null
  private timezoneCache: Record<string, string> = {}

  constructor({ accessToken, email, appId, serverUrl = GOOGLE_CALDAV_URL }: {
    accessToken: string
    email: string
    appId: string
    /** CalDAV root URL ending with `/`. Tests point it at a local server. */
    serverUrl?: string
  }) {
    this.headers = { Authorization: `Bearer ${accessToken}` }
    this.email = email
    this.appId = appId
    this.serverUrl = serverUrl
  }

  /** Update the access token (e.g. after refresh) */
  updateAccessToken(token: string) {
    this.headers = { Authorization: `Bearer ${token}` }
  }

  // =========================================================================
  // Cache helpers (private)
  // =========================================================================

  private get account() {
    return { email: this.email, appId: this.appId }
  }

  private async getCachedCalendarList(): Promise<CalendarListItem[] | undefined> {
    const row = getDb().query.calendarList.findFirst({
      where: { email: this.account.email, appId: this.account.appId },
    }).sync()
    if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
    return JSON.parse(row.rawData) as CalendarListItem[]
  }

  private async cacheCalendarListData(data: CalendarListItem[]): Promise<void> {
    const now = new Date()
    getDb()
      .insert(schema.calendarList)
      .values({
        ...this.account,
        rawData: JSON.stringify(data),
        ttlMs: TTL.CALENDAR_LIST,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.calendarList.email, schema.calendarList.appId],
        set: { rawData: JSON.stringify(data), ttlMs: TTL.CALENDAR_LIST, createdAt: now },
      })
      .run()
  }

  private async invalidateCalendarLists(): Promise<void> {
    getDb()
      .delete(schema.calendarList)
      .where(
        orm.and(
          orm.eq(schema.calendarList.email, this.account.email),
          orm.eq(schema.calendarList.appId, this.account.appId),
        ),
      )
      .run()
  }

  // =========================================================================
  // Internal: fetch DAVCalendar list (cached per instance)
  // =========================================================================

  private async fetchDAVCalendars(): Promise<DAVCalendar[] | AuthError | ApiError> {
    if (this.calendarCache) return this.calendarCache

    const calendars = await caldavBoundary(this.email, () =>
      fetchCalendars({
        account: {
          serverUrl: this.serverUrl,
          rootUrl: this.serverUrl,
          accountType: 'caldav',
          homeUrl: `${this.serverUrl}${this.email}/`,
        },
        headers: this.headers,
      }),
    )
    if (calendars instanceof Error) return calendars

    this.calendarCache = calendars
    return calendars
  }

  /** Fetch event objects with their data in one calendar-query REPORT.
   *  tsdav fetchCalendarObjects lists hrefs first and then fetches them all again
   *  (multiget, or a second query with useMultiGet: false). It throws when one href
   *  404s or the calendar changes between the two requests. */
  private async queryCalendarObjects({ calendar, timeRange }: {
    calendar: DAVCalendar
    timeRange?: { start: string; end: string }
  }): Promise<DAVCalendarObject[] | AuthError | ApiError> {
    const responses = await caldavBoundary(this.email, () =>
      calendarQuery({
        url: calendar.url,
        props: { 'd:getetag': {}, 'c:calendar-data': {} },
        filters: {
          'comp-filter': {
            _attributes: { name: 'VCALENDAR' },
            'comp-filter': {
              _attributes: { name: 'VEVENT' },
              ...(timeRange && {
                'time-range': { _attributes: { start: caldavTime(timeRange.start), end: caldavTime(timeRange.end) } },
              }),
            },
          },
        },
        depth: '1',
        headers: this.headers,
      }),
    )
    if (responses instanceof Error) return responses

    return responses.flatMap((res) => {
      const data = davText(res.props?.calendarData)
      if (!res.href || !data) return []
      return [{ url: new URL(res.href, calendar.url).href, etag: davText(res.props?.getetag), data }]
    })
  }

  /** GET one calendar object by URL. Returns undefined when nothing is stored there. */
  private async fetchCalendarObject(url: string): Promise<DAVCalendarObject | undefined | AuthError | ApiError> {
    const res = await caldavBoundary(this.email, () => fetch(url, { headers: this.headers }))
    if (res instanceof Error) return res
    if (res.status === 404) return undefined
    const statusError = responseError({ email: this.email, res, what: `GET ${url}` })
    if (statusError) return statusError

    const data = await caldavBoundary(this.email, () => res.text())
    if (data instanceof Error) return data
    return { url, etag: res.headers.get('etag') ?? undefined, data }
  }

  /** Resolve a calendarId to a DAVCalendar. 'primary' maps to the user's email. */
  private async resolveCalendar(calendarId: string): Promise<DAVCalendar | AuthError | ApiError | NotFoundError> {
    const calendars = await this.fetchDAVCalendars()
    if (calendars instanceof Error) return calendars

    // 'primary' = the user's own calendar (URL contains their email)
    const targetId = calendarId === 'primary' ? this.email : calendarId

    const match = calendars.find((c) => {
      const urlLower = c.url.toLowerCase()
      return urlLower.includes(`/${encodeURIComponent(targetId).toLowerCase()}/`) ||
        urlLower.includes(`/${targetId.toLowerCase()}/`)
    })

    if (!match) {
      return new NotFoundError({ resource: `calendar "${calendarId}". Available: ${calendars.map((c) => c.displayName || c.url).join(', ')}` })
    }

    return match
  }

  // =========================================================================
  // Calendar list
  // =========================================================================

  async listCalendars(): Promise<CalendarListItem[] | AuthError | ApiError> {
    // Check cache
    const cached = await this.getCachedCalendarList()
    if (cached) return cached

    const calendars = await this.fetchDAVCalendars()
    if (calendars instanceof Error) return calendars

    const result = calendars.map((cal) => {
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

    // Write cache
    await this.cacheCalendarListData(result)

    return result
  }

  // =========================================================================
  // Timezone
  // =========================================================================

  async getTimezone(calendarId = 'primary'): Promise<string | AuthError | ApiError | NotFoundError> {
    if (this.timezoneCache[calendarId]) return this.timezoneCache[calendarId]!

    const cal = await this.resolveCalendar(calendarId)
    if (cal instanceof Error) return cal

    // extractTimezone is a pure function (regex on string) — no try/catch needed.
    // Fallback to calendar list metadata if the DAVCalendar has no timezone data.
    let tz = extractTimezone(cal.timezone)
    if (tz === 'UTC' && cal.timezone) {
      // extractTimezone returned UTC as default — check calendar list for a better match
      const calendars = await this.listCalendars()
      if (calendars instanceof Error) return calendars
      const target = calendarId === 'primary' ? this.email : calendarId
      const match = calendars.find((c) => c.id.toLowerCase() === target.toLowerCase())
      if (match?.timezone && match.timezone !== 'UTC') tz = match.timezone
    }
    this.timezoneCache[calendarId] = tz
    return tz
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
  }: ListEventsParams = {}): Promise<EventListResult | AuthError | ApiError | NotFoundError> {
    // Always fresh: event lists are user-facing live data.

    const cal = await this.resolveCalendar(calendarId)
    if (cal instanceof Error) return cal
    const tz = await this.getTimezone(calendarId)
    if (tz instanceof Error) return tz

    const calObjects = await this.queryCalendarObjects({
      calendar: cal,
      timeRange: timeMin && timeMax ? { start: timeMin, end: timeMax } : undefined,
    })
    if (calObjects instanceof Error) return calObjects

    let events: CalendarEvent[] = []
    for (const obj of calObjects) {
      if (!obj.data) continue
      const parsed = parseICalData(obj.data, obj)
      if (parsed instanceof ParseError) continue // skip unparseable calendar objects
      events.push(...parsed)
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

    const result: EventListResult = {
      events: events.slice(0, maxResults),
      nextPageToken: null,
      timezone: tz,
    }

    return result
  }

  async getEvent({ calendarId = 'primary', eventId }: EventRef): Promise<CalendarEvent | AuthError | ApiError | NotFoundError> {
    const cal = await this.resolveCalendar(calendarId)
    if (cal instanceof Error) return cal

    // Fast path: Google and zele store events at <encoded uid>.ics
    const direct = await this.fetchCalendarObject(eventObjectUrl(cal.url, eventId))
    if (direct instanceof Error) return direct
    const directMatch = direct && findEventInObjects([direct], eventId)
    if (directMatch) return directMatch

    // Other clients can use any filename, so scan the whole calendar
    const calObjects = await this.queryCalendarObjects({ calendar: cal })
    if (calObjects instanceof Error) return calObjects
    const match = findEventInObjects(calObjects, eventId)
    if (match) return match

    return new NotFoundError({ resource: `event "${eventId}"` })
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
  }: CreateEventParams): Promise<CalendarEvent | CalendarWriteError> {
    const cal = await this.resolveCalendar(calendarId)
    if (cal instanceof Error) return cal
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

    const url = eventObjectUrl(cal.url, uid)

    const createResult = await caldavBoundary(this.email, () =>
      createCalendarObject({
        calendar: cal,
        filename: `${encodeURIComponent(uid)}.ics`,
        iCalString,
        headers: this.headers,
      }),
    )
    if (createResult instanceof Error) return createResult
    const createError = responseError({ email: this.email, res: createResult, what: `PUT ${url}` })
    if (createError) return createError

    const events = parseICalData(iCalString)
    if (events instanceof ParseError) return events
    const event = events[0]
    if (!event) return new ParseError({ what: 'created event', reason: 'iCal round-trip produced no events' })
    event.url = url

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
  }: UpdateEventParams): Promise<CalendarEvent | CalendarWriteError> {
    const existing = await this.getEvent({ calendarId, eventId })
    if (existing instanceof Error) return existing
    if (!existing.url || !existing.etag) {
      return new MissingDataError({ what: 'CalDAV URL or etag', resource: `event ${eventId}` })
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

    const updateResult = await caldavBoundary(this.email, () =>
      updateCalendarObject({
        calendarObject: { url: existing.url!, data: iCalString, etag: existing.etag },
        headers: this.headers,
      }),
    )
    if (updateResult instanceof Error) return updateResult
    const updateError = responseError({ email: this.email, res: updateResult, what: `PUT ${existing.url}` })
    if (updateError) return updateError

    const events = parseICalData(iCalString)
    if (events instanceof ParseError) return events
    const event = events[0]
    if (!event) return new ParseError({ what: 'updated event', reason: 'iCal round-trip produced no events' })
    event.url = existing.url
    event.etag = existing.etag

    return event
  }

  async deleteEvent({ calendarId = 'primary', eventId }: EventRef): Promise<void | CalendarWriteError> {
    const existing = await this.getEvent({ calendarId, eventId })
    if (existing instanceof Error) return existing
    if (!existing.url) {
      return new MissingDataError({ what: 'CalDAV URL', resource: `event ${eventId}` })
    }

    const deleteResult = await caldavBoundary(this.email, () =>
      deleteCalendarObject({
        calendarObject: { url: existing.url!, etag: existing.etag },
        headers: this.headers,
      }),
    )
    if (deleteResult instanceof Error) return deleteResult
    const deleteError = responseError({ email: this.email, res: deleteResult, what: `DELETE ${existing.url}` })
    if (deleteError) return deleteError
  }

  async respondToEvent({
    calendarId = 'primary',
    eventId,
    status,
    comment,
  }: RespondParams): Promise<CalendarEvent | CalendarWriteError> {
    const existing = await this.getEvent({ calendarId, eventId })
    if (existing instanceof Error) return existing
    if (!existing.url || !existing.etag) {
      return new MissingDataError({ what: 'CalDAV URL or etag', resource: `event ${eventId}` })
    }

    // Patch only our PARTSTAT in the stored object: rebuilding it would drop the organizer,
    // and Google ignores attendee replies that change the organizer
    const isAttendee = existing.attendees.some((a) => a.email.toLowerCase() === this.email.toLowerCase())
    if (!existing.ics || !isAttendee) {
      return new MissingDataError({ what: 'invitation for this account', resource: `event ${eventId}` })
    }
    const iCalString = setOwnPartstat(existing.ics, this.email, status.toUpperCase())

    const respondResult = await caldavBoundary(this.email, () =>
      updateCalendarObject({
        calendarObject: { url: existing.url!, data: iCalString, etag: existing.etag },
        headers: this.headers,
      }),
    )
    if (respondResult instanceof Error) return respondResult
    const respondError = responseError({ email: this.email, res: respondResult, what: `PUT ${existing.url}` })
    if (respondError) return respondError

    const events = parseICalData(iCalString)
    if (events instanceof ParseError) return events
    const event = events[0]
    if (!event) return new ParseError({ what: 'response event', reason: 'iCal round-trip produced no events' })
    event.url = existing.url

    return event
  }
}
