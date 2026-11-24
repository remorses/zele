// CalendarClient on the Google Calendar REST API (@googleapis/calendar).
// Needs only `calendar.events` (read and write events, RSVP to invitations) and
// `calendar.calendarlist.readonly` (list calendars and their time zones), instead of
// the full `calendar` scope that Google CalDAV requires. Used by zele's own OAuth
// client, see getCalendarClients in auth.ts and docs/google-oauth-verification.md.
// Takes the OAuth2Client, so tokens refresh inside long-running commands.

import crypto from 'node:crypto'
import * as errore from 'errore'
import { calendar as calendarApi, type calendar_v3 } from '@googleapis/calendar'
import type { OAuth2Client } from 'google-auth-library'
import { AuthError, ApiError, NotFoundError, MissingDataError, isAuthLikeError, withRetry } from './api-utils.js'
import type {
  CalendarClient,
  CalendarEvent,
  CalendarListItem,
  CreateEventParams,
  EventListResult,
  EventRef,
  ListEventsParams,
  RespondParams,
  UpdateEventParams,
} from './calendar-client.js'

const HTTP_NOT_FOUND = 404
const HTTP_GONE = 410
const DEFAULT_MAX_RESULTS = 20
const PRIMARY = 'primary'

/** Wrap a googleapis call: auth failures become AuthError, 404 and 410 NotFoundError, the rest ApiError. */
function calendarBoundary<T>({ email, resource, fn }: { email: string; resource: string; fn: () => Promise<T> }) {
  return errore.tryAsync({
    try: fn,
    catch: (err) => {
      // AuthError comes from the zele.sh refreshHandler in auth.ts, already with a login hint.
      if (err instanceof AuthError) return err
      const status = (err as { code?: unknown; status?: unknown })?.code ?? (err as { status?: unknown })?.status
      if (status === HTTP_NOT_FOUND || status === HTTP_GONE) return new NotFoundError({ resource })
      if (isAuthLikeError(err)) return new AuthError({ email, reason: String(err) })
      return new ApiError({ reason: String(err), cause: err })
    },
  })
}

/** Event time for the API: `{ date }` for all-day events, `{ dateTime }` otherwise. */
function eventTime({ value, allDay }: { value: string; allDay: boolean }): calendar_v3.Schema$EventDateTime {
  return allDay ? { date: value.slice(0, 10) } : { dateTime: value }
}

function meetRequest(): calendar_v3.Schema$ConferenceData {
  return { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
}

function toCalendarEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  const allDay = Boolean(e.start?.date)
  const start = e.start?.dateTime ?? e.start?.date ?? ''
  const end = e.end?.dateTime ?? e.end?.date ?? start
  const meetEntry = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')
  return {
    id: e.id ?? '',
    summary: e.summary || '(no title)',
    start,
    end,
    startDate: allDay ? start : undefined,
    endDate: allDay ? end : undefined,
    allDay,
    description: e.description ?? '',
    location: e.location ?? '',
    status: e.status ?? 'confirmed',
    htmlLink: e.htmlLink ?? '',
    meetLink: e.hangoutLink ?? meetEntry?.uri ?? null,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email ?? '',
      name: a.displayName ?? null,
      status: a.responseStatus ?? 'needsAction',
      self: a.self ?? false,
      organizer: a.organizer ?? false,
    })),
    recurrence: e.recurrence ?? [],
    reminders: (e.reminders?.overrides ?? []).map((r) => ({ method: r.method ?? 'popup', minutes: r.minutes ?? 0 })),
    colorId: e.colorId ?? null,
    visibility: e.visibility ?? 'default',
    transparency: e.transparency ?? 'opaque',
  }
}

export class GoogleCalendarApiClient implements CalendarClient {
  private api: calendar_v3.Calendar
  private email: string
  private timezones = new Map<string, string>()

  constructor({ auth, email }: { auth: OAuth2Client; email: string }) {
    this.api = calendarApi({ version: 'v3', auth })
    this.email = email
  }

  async listCalendars() {
    const items: calendar_v3.Schema$CalendarListEntry[] = []
    let pageToken: string | undefined
    do {
      const res = await calendarBoundary({
        email: this.email,
        resource: 'calendar list',
        fn: () => withRetry(() => this.api.calendarList.list({ pageToken })),
      })
      if (res instanceof NotFoundError) return new ApiError({ reason: res.message, cause: res })
      if (res instanceof Error) return res
      items.push(...(res.data.items ?? []))
      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken)

    return items.map((c): CalendarListItem => ({
      id: c.id ?? '',
      summary: c.summaryOverride ?? c.summary ?? c.id ?? '',
      primary: c.primary ?? false,
      role: c.accessRole ?? '',
      timezone: c.timeZone ?? 'UTC',
      backgroundColor: c.backgroundColor ?? '',
    }))
  }

  async getTimezone(calendarId = PRIMARY) {
    const cached = this.timezones.get(calendarId)
    if (cached) return cached

    const res = await calendarBoundary({
      email: this.email,
      resource: `calendar "${calendarId}"`,
      fn: () => withRetry(() => this.api.calendarList.get({ calendarId })),
    })
    if (res instanceof Error) return res
    const tz = res.data.timeZone ?? 'UTC'
    this.timezones.set(calendarId, tz)
    return tz
  }

  async listEvents({
    calendarId = PRIMARY,
    timeMin,
    timeMax,
    query,
    maxResults = DEFAULT_MAX_RESULTS,
    pageToken,
  }: ListEventsParams = {}) {
    const res = await calendarBoundary({
      email: this.email,
      resource: `calendar "${calendarId}"`,
      fn: () =>
        withRetry(() =>
          this.api.events.list({
            calendarId,
            timeMin,
            timeMax,
            q: query,
            maxResults,
            pageToken,
            singleEvents: true,
            orderBy: 'startTime',
          }),
        ),
    })
    if (res instanceof Error) return res

    const result: EventListResult = {
      events: (res.data.items ?? []).map(toCalendarEvent),
      nextPageToken: res.data.nextPageToken ?? null,
      timezone: res.data.timeZone ?? 'UTC',
    }
    return result
  }

  async getEvent({ calendarId = PRIMARY, eventId }: EventRef) {
    const res = await this.fetchEvent({ calendarId, eventId })
    if (res instanceof Error) return res
    return toCalendarEvent(res)
  }

  async createEvent({
    calendarId = PRIMARY,
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
  }: CreateEventParams) {
    const requestBody: calendar_v3.Schema$Event = {
      summary,
      description,
      location,
      start: eventTime({ value: start, allDay }),
      end: eventTime({ value: end, allDay }),
      attendees: attendees?.map((email) => ({ email })),
      recurrence,
      reminders: reminders ? { useDefault: false, overrides: reminders } : undefined,
      colorId,
      visibility,
      transparency,
      conferenceData: withMeet ? meetRequest() : undefined,
    }
    const res = await calendarBoundary({
      email: this.email,
      resource: `calendar "${calendarId}"`,
      fn: () =>
        withRetry(
          () =>
            this.api.events.insert({
              calendarId,
              requestBody,
              conferenceDataVersion: withMeet ? 1 : 0,
              sendUpdates: attendees?.length ? 'all' : 'none',
            }),
          { idempotent: false },
        ),
    })
    if (res instanceof Error) return res
    return toCalendarEvent(res.data)
  }

  async updateEvent({
    calendarId = PRIMARY,
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
  }: UpdateEventParams) {
    const existing = await this.fetchEvent({ calendarId, eventId })
    if (existing instanceof Error) return existing

    const isAllDay = allDay ?? Boolean(existing.start?.date)
    const removeSet = new Set((removeAttendees ?? []).map((e) => e.toLowerCase()))
    const kept = (existing.attendees ?? []).filter((a) => !removeSet.has((a.email ?? '').toLowerCase()))
    const keptSet = new Set(kept.map((a) => (a.email ?? '').toLowerCase()))
    const added = (addAttendees ?? []).filter((e) => !keptSet.has(e.toLowerCase())).map((email) => ({ email }))
    const attendeesChanged = Boolean(addAttendees?.length || removeAttendees?.length)

    const requestBody: calendar_v3.Schema$Event = {
      summary,
      description,
      location,
      start: start ? eventTime({ value: start, allDay: isAllDay }) : undefined,
      end: end ? eventTime({ value: end, allDay: isAllDay }) : undefined,
      attendees: attendeesChanged ? [...kept, ...added] : undefined,
      colorId,
      visibility,
      transparency,
      conferenceData: withMeet && !existing.hangoutLink ? meetRequest() : undefined,
    }
    const res = await calendarBoundary({
      email: this.email,
      resource: `event "${eventId}"`,
      fn: () =>
        withRetry(() =>
          this.api.events.patch({
            calendarId,
            eventId,
            requestBody,
            conferenceDataVersion: withMeet ? 1 : 0,
            sendUpdates: attendeesChanged || existing.attendees?.length ? 'all' : 'none',
          }),
        ),
    })
    if (res instanceof Error) return res
    return toCalendarEvent(res.data)
  }

  async deleteEvent({ calendarId = PRIMARY, eventId }: EventRef) {
    const res = await calendarBoundary({
      email: this.email,
      resource: `event "${eventId}"`,
      // sendUpdates 'all' so guests get the cancellation, like create/update and CalDAV scheduling
      fn: () => withRetry(() => this.api.events.delete({ calendarId, eventId, sendUpdates: 'all' })),
    })
    if (res instanceof Error) return res
  }

  async respondToEvent({ calendarId = PRIMARY, eventId, status, comment }: RespondParams) {
    const existing = await this.fetchEvent({ calendarId, eventId })
    if (existing instanceof Error) return existing

    const isSelf = (a: calendar_v3.Schema$EventAttendee) => a.self || a.email?.toLowerCase() === this.email.toLowerCase()
    const attendees = existing.attendees ?? []
    if (!attendees.some(isSelf)) {
      return new MissingDataError({ what: 'invitation for this account', resource: `event ${eventId}` })
    }

    const res = await calendarBoundary({
      email: this.email,
      resource: `event "${eventId}"`,
      fn: () =>
        withRetry(() =>
          this.api.events.patch({
            calendarId,
            eventId,
            requestBody: {
              attendees: attendees.map((a) => (isSelf(a) ? { ...a, responseStatus: status, comment: comment ?? a.comment } : a)),
            },
          }),
        ),
    })
    if (res instanceof Error) return res
    return toCalendarEvent(res.data)
  }

  private async fetchEvent({ calendarId, eventId }: { calendarId: string; eventId: string }) {
    const res = await calendarBoundary({
      email: this.email,
      resource: `event "${eventId}"`,
      fn: () => withRetry(() => this.api.events.get({ calendarId, eventId })),
    })
    if (res instanceof Error) return res
    // Deleted events stay readable with status "cancelled"
    if (res.data.status === 'cancelled') return new NotFoundError({ resource: `event "${eventId}"` })
    return res.data
  }
}
