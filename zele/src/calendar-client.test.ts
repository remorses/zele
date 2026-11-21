// CalendarClient against a local Google-shaped CalDAV server.
// Checks which requests event reads make: one GET for <encoded uid>.ics, then one
// calendar-query with data as fallback. The server answers every calendar-multiget
// with a 404 object, like the broken Google objects that made whole-calendar reads fail.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { CalendarClient } from './calendar-client.js'
import { NotFoundError } from './api-utils.js'

const EMAIL = 'me@example.com'
const CALENDAR_PATH = `/caldav/v2/${encodeURIComponent(EMAIL)}/events/`

let objects = new Map<string, { data: string; etag: string }>()
let requests: string[] = []
let lastReportBody = ''
let rejectWrites = false
let origin = ''
let serverUrl = ''

function eventIcs({ uid, summary, start }: { uid: string; summary: string; start: string }): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${start}`,
    'DTSTAMP:20261101T000000Z',
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

function multistatus(responses: string[]): string {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">' +
    responses.join('') +
    '</D:multistatus>'
}

const CALENDAR_RESPONSE = `<D:response>
  <D:href>${CALENDAR_PATH}</D:href>
  <D:propstat>
    <D:status>HTTP/1.1 200 OK</D:status>
    <D:prop>
      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      <D:displayname>${EMAIL}</D:displayname>
      <C:calendar-timezone>Europe/Rome</C:calendar-timezone>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
      <CS:getctag>ctag-1</CS:getctag>
    </D:prop>
  </D:propstat>
</D:response>`

function objectResponse(href: string, object: { data: string; etag: string }): string {
  return `<D:response><D:href>${href}</D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status><D:prop>` +
    `<D:getetag>${object.etag}</D:getetag><C:calendar-data><![CDATA[${object.data}]]></C:calendar-data>` +
    `</D:prop></D:propstat></D:response>`
}

function handle(method: string, path: string, body: string, res: http.ServerResponse) {
  const xml = (status: number, text: string) => {
    res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8' }).end(text)
  }
  if (method === 'PROPFIND') return xml(207, multistatus([CALENDAR_RESPONSE]))
  if (method === 'REPORT' && body.includes('calendar-query')) {
    lastReportBody = body
    return xml(207, multistatus([...objects].map(([href, object]) => objectResponse(href, object))))
  }
  if (method === 'REPORT' && body.includes('calendar-multiget')) {
    return xml(207, multistatus([`<D:response><D:href>${CALENDAR_PATH}broken.ics</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`]))
  }
  if (method === 'GET') {
    const object = objects.get(path)
    if (!object) return res.writeHead(404).end()
    return res.writeHead(200, { 'content-type': 'text/calendar', etag: object.etag }).end(object.data)
  }
  if (method === 'PUT') {
    if (rejectWrites) return res.writeHead(412).end()
    objects.set(path, { data: body, etag: `"etag-${objects.size + 1}"` })
    return res.writeHead(201).end()
  }
  res.writeHead(405).end()
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'
    const kind = method === 'REPORT' ? ` ${body.match(/calendar-(query|multiget)/)?.[0]}` : ''
    requests.push(`${method} ${path}${kind}`)
    handle(method, path, body, res)
  })
})

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  serverUrl = `${origin}/caldav/v2/`
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  objects = new Map()
  requests = []
  lastReportBody = ''
  rejectWrites = false
})

/** New client with calendar discovery already done, so `requests` starts empty. */
async function readyClient(): Promise<CalendarClient> {
  const client = new CalendarClient({ accessToken: 'token', email: EMAIL, appId: 'test', serverUrl })
  const tz = await client.getTimezone()
  expect(tz).toBe('Europe/Rome')
  requests = []
  return client
}

describe('CalendarClient event reads', () => {
  test('createEvent saves at the encoded uid URL and getEvent reads it with one GET', async () => {
    const client = await readyClient()
    const created = await client.createEvent({ summary: 'Standup', start: '2026-11-20T09:00:00Z', end: '2026-11-20T09:30:00Z' })
    if (created instanceof Error) throw created
    const uid = created.uid!
    const objectPath = `${CALENDAR_PATH}${encodeURIComponent(uid)}.ics`
    expect(created.url).toBe(`${origin}${objectPath}`)

    const event = await client.getEvent({ eventId: uid })
    if (event instanceof Error) throw event
    expect({ summary: event.summary, url: event.url, etag: event.etag }).toEqual({
      summary: 'Standup',
      url: created.url,
      etag: '"etag-1"',
    })
    expect(requests).toEqual([`PUT ${objectPath}`, `GET ${objectPath}`])

    // tsdav returns the raw Response for writes; a rejected PUT must not look like success
    rejectWrites = true
    const stale = await client.respondToEvent({ eventId: uid, status: 'accepted' })
    expect(stale).toBeInstanceOf(Error)
  })

  test('getEvent falls back to one calendar-query for foreign filenames and returns NotFoundError when missing', async () => {
    objects.set(`${CALENDAR_PATH}foreign-name.ics`, {
      data: eventIcs({ uid: 'abc@other.app', summary: 'Foreign', start: '20261120T100000Z' }),
      etag: '"foreign"',
    })
    objects.set(`${CALENDAR_PATH}garbage.ics`, { data: 'not ical', etag: '"garbage"' })
    const client = await readyClient()

    const event = await client.getEvent({ eventId: 'abc@other.app' })
    if (event instanceof Error) throw event
    expect({ summary: event.summary, url: event.url, etag: event.etag }).toEqual({
      summary: 'Foreign',
      url: `${origin}${CALENDAR_PATH}foreign-name.ics`,
      etag: '"foreign"',
    })
    expect(requests).toMatchInlineSnapshot(`
      [
        "GET /caldav/v2/me%40example.com/events/abc%40other.app.ics",
        "REPORT /caldav/v2/me%40example.com/events/ calendar-query",
      ]
    `)

    const missing = await client.getEvent({ eventId: 'gone@other.app' })
    expect(missing).toBeInstanceOf(NotFoundError)
  })

  test('listEvents fetches data in one calendar-query with a time range', async () => {
    objects.set(`${CALENDAR_PATH}b.ics`, { data: eventIcs({ uid: 'b@x', summary: 'Second', start: '20261121T100000Z' }), etag: '"b"' })
    objects.set(`${CALENDAR_PATH}a.ics`, { data: eventIcs({ uid: 'a@x', summary: 'First', start: '20261120T100000Z' }), etag: '"a"' })
    objects.set(`${CALENDAR_PATH}garbage.ics`, { data: 'not ical', etag: '"garbage"' })
    const client = await readyClient()

    const result = await client.listEvents({ timeMin: '2026-11-01T00:00:00Z', timeMax: '2026-12-01T00:00:00.000Z' })
    if (result instanceof Error) throw result
    expect(result.events.map((e) => e.summary)).toEqual(['First', 'Second'])
    expect(requests).toEqual([`REPORT ${CALENDAR_PATH} calendar-query`])
    expect(lastReportBody).toContain('<c:calendar-data/>')
    expect(lastReportBody).toContain('start="20261101T000000Z" end="20261201T000000Z"')
  })
})
