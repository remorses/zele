// Calendar commands: list, events, get, create, update, delete, respond, freebusy.
// Manages Google Calendar with YAML output.
// Cache is handled by the client — commands just call methods and use data.
// Multi-account: list/events fetch all accounts concurrently and merge by start time.

import type { ZeleCli } from '../cli-types.js'
import { z } from 'zod'
import readline from 'node:readline'
import { getCalendarClients, getCalendarClient } from '../auth.js'
import type { CalendarClient, CalendarEvent, CalendarListItem, EventListResult } from '../calendar-client.js'
import { AuthError } from '../api-utils.js'
import * as out from '../output.js'
import { handleCommandError } from '../output.js'
import { resolveTimeRange, parseTimeExpression, parseDuration, isDateOnly } from '../calendar-time.js'

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------

export function registerCalendarCommands(cli: ZeleCli) {
  // =========================================================================
  // cal list
  // =========================================================================

  cli
    .command('cal list', 'List calendars')
    .action(async (options) => {
      const clients = await getCalendarClients(options.account)

      const results = await Promise.all(
        clients.map(async ({ email, client }) => {
          const calendars = await client.listCalendars()
          if (calendars instanceof Error) return calendars
          return { email, calendars }
        }),
      )

      const allResults = results.filter((r): r is Exclude<typeof r, Error> => {
          if (r instanceof AuthError) { out.error(`${r.message}. Try: zele login`); return false }
          if (r instanceof Error) { out.error(`Failed to fetch calendars: ${r.message}`); return false }
          return true
        })

      const showAccount = clients.length > 1
      const merged = allResults.flatMap(({ email, calendars }) =>
        calendars
          .sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0))
          .map((cal) => ({
            ...(showAccount ? { account: email } : {}),
            id: cal.id,
            name: cal.summary,
            role: cal.role,
            ...(cal.primary ? { primary: true } : {}),
          })),
      )

      if (merged.length === 0) {
        out.printList([], { summary: 'No calendars found' })
        return
      }

      out.printList(merged, { summary: `${merged.length} calendars` })
    })

  // =========================================================================
  // cal events
  // =========================================================================

  cli
    .command('cal events', 'List calendar events')
    .option('--calendar <calendar>', 'Calendar ID (default: primary)')
    .option('--from <from>', 'Start time (ISO date, "today", "tomorrow", weekday name)')
    .option('--to <to>', 'End time (same formats, or +1h/+30m/+2d relative to --from)')
    .option('--today', 'Show today only')
    .option('--tomorrow', 'Show tomorrow only')
    .option('--week', 'Show this week')
    .option('--days <days>', z.number().describe('Show next N days'))
    .option('--all', 'Fetch from all calendars')
    .option('--query <query>', 'Free text search')
    .option('--max [max]', 'Max results (default: 20)')
    .option('--page <page>', 'Pagination token (requires --account, only works for a single account)')
    .action(async (options) => {
      const max = options.max ? Number(options.max) : 20
      const calendarId = options.calendar ?? 'primary'

      if (options.all && options.calendar) {
        out.error('--all and --calendar cannot be used together')
        process.exit(1)
      }

      const clients = await getCalendarClients(options.account)

      if (options.page && clients.length > 1) {
        out.error('--page cannot be used with multiple accounts (page tokens are per-account)')
        process.exit(1)
      }

      const results = await Promise.all(
        clients.map(async ({ email, client }) => {
          const tz = await client.getTimezone(calendarId)
          if (tz instanceof Error) return tz
          const { timeMin, timeMax } = resolveTimeRange({
            from: options.from,
            to: options.to,
            today: options.today,
            tomorrow: options.tomorrow,
            week: options.week,
            days: options.days,
          }, tz)

          let result: EventListResult

          if (options.all) {
            // Fetch from all calendars
            const calendars = await client.listCalendars()
            if (calendars instanceof Error) return calendars
            const allEvents: CalendarEvent[] = []

            const perCalResults = await Promise.all(
              calendars.map(async (cal) => {
                const r = await client.listEvents({
                  calendarId: cal.id,
                  timeMin,
                  timeMax,
                  query: options.query,
                  maxResults: max,
                })
                if (r instanceof Error) return r
                return r.events.map((e) => ({ ...e, calendarId: cal.id }))
              }),
            )

            for (const r of perCalResults) {
              if (r instanceof Error) { out.error(r instanceof AuthError ? `${r.message}. Try: zele login` : r.message); continue }
              allEvents.push(...r)
            }

            result = {
              events: allEvents,
              nextPageToken: null,
              timezone: tz,
            }
          } else {
            const r = await client.listEvents({
              calendarId,
              timeMin,
              timeMax,
              query: options.query,
              maxResults: max,
              pageToken: options.page,
            })
            if (r instanceof Error) return r
            result = r
          }

          return { email, result, tz }
        }),
      )

      const allResults = results.filter((r): r is Exclude<typeof r, Error> => {
          if (r instanceof AuthError) { out.error(`${r.message}. Try: zele login`); return false }
          if (r instanceof Error) { out.error(`Failed to fetch events: ${r.message}`); return false }
          return true
        })

      const showAccount = clients.length > 1

      // Merge events from all accounts, sort by start time
      const merged = allResults
        .flatMap(({ email, result }) =>
          result.events.map((e) => ({ ...e, account: email })),
        )
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
        .slice(0, max)

      if (merged.length === 0) {
        out.printList([], { summary: 'No events found' })
        return
      }

      out.printList(
        merged.map((e) => {
          const time = out.formatEventTime(e.start, e.end, e.allDay)
          return {
            ...(showAccount ? { account: e.account } : {}),
            id: e.id,
            summary: e.summary,
            start: time.start,
            end: time.end,
            ...(e.location ? { location: e.location } : {}),
            ...(e.calendarId && e.calendarId !== calendarId ? { calendar: e.calendarId } : {}),
          }
        }),
        { nextPage: allResults[0]?.result.nextPageToken, summary: `${merged.length} events` },
      )
    })

  // =========================================================================
  // cal get
  // =========================================================================

  cli
    .command('cal get <eventId>', 'Get event details')
    .option('--calendar <calendar>', 'Calendar ID (default: primary)')
    .action(async (eventId, options) => {
      const calendarId = options.calendar ?? 'primary'
      const { client } = await getCalendarClient(options.account)

      const event = await client.getEvent({ calendarId, eventId })
      if (event instanceof Error) handleCommandError(event)
      const time = out.formatEventTime(event.start, event.end, event.allDay)

      const doc: Record<string, unknown> = {
        id: event.id,
        summary: event.summary,
        start: time.start,
        end: time.end,
      }

      if (event.allDay) doc.all_day = true
      if (event.location) doc.location = event.location
      if (event.description) doc.description = event.description
      if (event.meetLink) doc.meet = event.meetLink
      if (event.attendees.length > 0) {
        doc.attendees = event.attendees.map((a) => ({
          email: a.email,
          ...(a.name ? { name: a.name } : {}),
          status: a.status,
          ...(a.organizer ? { organizer: true } : {}),
        }))
      }
      if (event.recurrence.length > 0) doc.recurrence = event.recurrence
      if (event.visibility !== 'default') doc.visibility = event.visibility
      if (event.transparency === 'transparent') doc.show_as = 'free'
      if (event.colorId) doc.color = event.colorId
      if (event.htmlLink) doc.link = event.htmlLink

      out.printYaml(doc)
    })

  // =========================================================================
  // cal create
  // =========================================================================

  cli
    .command('cal create', 'Create a calendar event')
    .option('--calendar <calendar>', 'Calendar ID (default: primary)')
    .option('--summary <summary>', z.string().describe('Event title'))
    .option('--from <from>', z.string().describe('Start time'))
    .option('--to <to>', z.string().describe('End time (or +1h, +30m, +2d relative to --from)'))
    .option('--description <description>', 'Event description')
    .option('--location <location>', 'Event location')
    .option('--attendees <attendees>', 'Comma-separated attendee emails')
    .option('--meet', 'Create Google Meet link')
    .option('--all-day', 'All-day event')
    .option('--recurrence <recurrence>', 'Recurrence rule (e.g. RRULE:FREQ=WEEKLY;BYDAY=MO)')
    .option('--reminder <reminder>', 'Reminder as method:duration (e.g. popup:15m)')
    .option('--color <color>', 'Event color ID (1-11)')
    .option('--visibility <visibility>', 'Event visibility (default, public, private)')
    .action(async (options) => {
      if (!options.summary) {
        out.error('--summary is required')
        process.exit(1)
      }
      if (!options.from) {
        out.error('--from is required')
        process.exit(1)
      }
      if (!options.to) {
        out.error('--to is required')
        process.exit(1)
      }

      const calendarId = options.calendar ?? 'primary'
      const { client } = await getCalendarClient(options.account)
      const tz = await client.getTimezone(calendarId)
      if (tz instanceof Error) handleCommandError(tz)

      const allDay = options.allDay || (isDateOnly(options.from) && isDateOnly(options.to))
      const start = allDay ? options.from : parseTimeExpression(options.from, tz)

      let end: string
      if (allDay) {
        // Calendar API uses exclusive end date: add 1 day so user can pass same date for single-day
        const endDate = new Date(options.to + 'T00:00:00')
        endDate.setDate(endDate.getDate() + 1)
        end = endDate.toISOString().split('T')[0]!
      } else {
        // Support +duration syntax (e.g. +1h, +30m)
        const durationMs = parseDuration(options.to)
        if (durationMs !== null) {
          end = new Date(new Date(start).getTime() + durationMs).toISOString()
        } else {
          end = parseTimeExpression(options.to, tz)
        }
      }

      const attendees = options.attendees
        ? options.attendees.split(',').map((e: string) => e.trim()).filter(Boolean)
        : undefined

      const reminders = options.reminder ? [parseReminder(options.reminder)] : undefined

      const eventResult = await client.createEvent({
        calendarId,
        summary: options.summary,
        start,
        end,
        allDay,
        description: options.description,
        location: options.location,
        attendees,
        withMeet: options.meet ?? false,
        recurrence: options.recurrence ? [options.recurrence] : undefined,
        reminders,
        colorId: options.color,
        visibility: options.visibility,
      })

      if (eventResult instanceof Error) handleCommandError(eventResult)
      printEventDetail(eventResult)
      out.success('Event created')
    })

  // =========================================================================
  // cal update
  // =========================================================================

  cli
    .command('cal update <eventId>', 'Update a calendar event')
    .option('--calendar <calendar>', 'Calendar ID (default: primary)')
    .option('--summary <summary>', 'Event title')
    .option('--from <from>', 'Start time')
    .option('--to <to>', 'End time')
    .option('--description <description>', 'Event description')
    .option('--location <location>', 'Event location')
    .option('--add-attendees <addAttendees>', 'Comma-separated emails to add')
    .option('--remove-attendees <removeAttendees>', 'Comma-separated emails to remove')
    .option('--meet', 'Add Google Meet link')
    .option('--color <color>', 'Event color ID (1-11, empty to clear)')
    .option('--visibility <visibility>', 'Event visibility')
    .action(async (eventId, options) => {
      const calendarId = options.calendar ?? 'primary'
      const { client } = await getCalendarClient(options.account)

      const addAttendees = options.addAttendees
        ? options.addAttendees.split(',').map((e: string) => e.trim()).filter(Boolean)
        : undefined

      const removeAttendees = options.removeAttendees
        ? options.removeAttendees.split(',').map((e: string) => e.trim()).filter(Boolean)
        : undefined

      let start: string | undefined
      let end: string | undefined
      let allDay: boolean | undefined

      if (options.from || options.to) {
        // Detect all-day: both from and to are date-only
        allDay = options.from && options.to && isDateOnly(options.from) && isDateOnly(options.to)
          ? true
          : undefined

        if (allDay) {
          start = options.from
          // Add 1 day for exclusive end date
          if (options.to) {
            const endDate = new Date(options.to + 'T00:00:00')
            endDate.setDate(endDate.getDate() + 1)
            end = endDate.toISOString().split('T')[0]!
          }
        } else {
          const tz = await client.getTimezone(calendarId)
          if (tz instanceof Error) handleCommandError(tz)
          if (options.from) start = parseTimeExpression(options.from, tz)
          if (options.to) {
            const durationMs = parseDuration(options.to)
            if (durationMs !== null && start) {
              end = new Date(new Date(start).getTime() + durationMs).toISOString()
            } else {
              end = parseTimeExpression(options.to, tz)
            }
          }
        }
      }

      const updateResult = await client.updateEvent({
        calendarId,
        eventId,
        summary: options.summary,
        start,
        end,
        allDay,
        description: options.description,
        location: options.location,
        addAttendees,
        removeAttendees,
        withMeet: options.meet,
        colorId: options.color,
        visibility: options.visibility,
      })

      if (updateResult instanceof Error) handleCommandError(updateResult)
      printEventDetail(updateResult)
      out.success('Event updated')
    })

  // =========================================================================
  // cal delete
  // =========================================================================

  cli
    .command('cal delete <eventId>', 'Delete a calendar event')
    .option('--calendar <calendar>', 'Calendar ID (default: primary)')
    .option('--force', 'Skip confirmation')
    .action(async (eventId, options) => {
      const calendarId = options.calendar ?? 'primary'
      const { client } = await getCalendarClient(options.account)

      if (!options.force && process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Delete event ${eventId}? [y/N] `, resolve)
        })
        rl.close()

        if (answer.toLowerCase() !== 'y') {
          out.hint('Cancelled')
          return
        }
      }

      const deleteResult = await client.deleteEvent({ calendarId, eventId })
      if (deleteResult instanceof Error) handleCommandError(deleteResult)

      out.printYaml({ deleted: true, id: eventId })
      out.success('Event deleted')
    })

  // =========================================================================
  // cal respond
  // =========================================================================

  cli
    .command('cal respond <eventId>', 'Respond to event invitation')
    .option('--calendar <calendar>', 'Calendar ID (default: primary)')
    .option('--status <status>', z.string().describe('Response: accepted, declined, tentative'))
    .option('--comment <comment>', 'Optional comment')
    .action(async (eventId, options) => {
      if (!options.status) {
        out.error('--status is required (accepted, declined, tentative)')
        process.exit(1)
      }

      const validStatuses = ['accepted', 'declined', 'tentative']
      if (!validStatuses.includes(options.status)) {
        out.error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`)
        process.exit(1)
      }

      const calendarId = options.calendar ?? 'primary'
      const { client } = await getCalendarClient(options.account)

      const respondResult = await client.respondToEvent({
        calendarId,
        eventId,
        status: options.status as 'accepted' | 'declined' | 'tentative',
        comment: options.comment,
      })
      if (respondResult instanceof Error) handleCommandError(respondResult)

      out.printYaml({
        id: respondResult.id,
        summary: respondResult.summary,
        status: options.status,
        ...(options.comment ? { comment: options.comment } : {}),
      })
      out.success(`Responded: ${options.status}`)
    })

  // =========================================================================
  // cal freebusy
  // =========================================================================

  cli
    .command('cal freebusy [...calendarIds]', 'Get free/busy information')
    .option('--from <from>', z.string().describe('Start time'))
    .option('--to <to>', z.string().describe('End time'))
    .action(async (calendarIds, options) => {
      if (!calendarIds || calendarIds.length === 0) {
        out.error('At least one calendar ID (email) is required')
        process.exit(1)
      }
      if (!options.from || !options.to) {
        out.error('--from and --to are required')
        process.exit(1)
      }

      const { client } = await getCalendarClient(options.account)
      const tz = await client.getTimezone()
      if (tz instanceof Error) handleCommandError(tz)

      const timeMin = parseTimeExpression(options.from, tz)
      const timeMax = parseTimeExpression(options.to, tz)

      const results = await client.getFreeBusy({
        calendarIds,
        timeMin,
        timeMax,
      })

      const items = results.map((r) => ({
        calendar: r.calendar,
        busy: r.busy.length > 0
          ? r.busy.map((b) => {
              const st = new Date(b.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
              const en = new Date(b.end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
              return `${st} - ${en}`
            })
          : ['(free)'],
      }))

      out.printList(items)
    })

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printEventDetail(event: CalendarEvent) {
  const time = out.formatEventTime(event.start, event.end, event.allDay)

  const doc: Record<string, unknown> = {
    id: event.id,
    summary: event.summary,
    start: time.start,
    end: time.end,
  }

  if (event.allDay) doc.all_day = true
  if (event.location) doc.location = event.location
  if (event.description) doc.description = event.description
  if (event.meetLink) doc.meet = event.meetLink
  if (event.attendees.length > 0) {
    doc.attendees = event.attendees.map((a) => ({
      email: a.email,
      ...(a.name ? { name: a.name } : {}),
      status: a.status,
    }))
  }
  if (event.recurrence.length > 0) doc.recurrence = event.recurrence
  if (event.htmlLink) doc.link = event.htmlLink

  out.printYaml(doc)
}

function parseReminder(input: string): { method: string; minutes: number } {
  const [method, duration] = input.split(':')
  if (!method || !duration) {
    throw new Error(`Invalid reminder format: "${input}". Use method:duration (e.g. popup:15m)`)
  }

  const validMethods = ['popup', 'email']
  if (!validMethods.includes(method)) {
    throw new Error(`Invalid reminder method: "${method}". Must be popup or email`)
  }

  const match = duration.match(/^(\d+)(m|h|d|w)?$/)
  if (!match) {
    throw new Error(`Invalid reminder duration: "${duration}". Use 30, 30m, 1h, 3d, or 1w`)
  }

  const value = Number(match[1])
  const unit = match[2] ?? 'm'

  let minutes: number
  switch (unit) {
    case 'm': minutes = value; break
    case 'h': minutes = value * 60; break
    case 'd': minutes = value * 1440; break
    case 'w': minutes = value * 10080; break
    default: minutes = value
  }

  return { method, minutes }
}
