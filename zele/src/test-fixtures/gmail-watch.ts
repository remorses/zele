import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { OAuth2Client } from 'googleapis-common'
import { GmailClient } from '../gmail-client.ts'
import { closeDb, getDb, schema } from '../db.ts'

// Run only in a child with a disposable HOME. No real tokens or remote requests.
assert.ok(process.env.HOME?.includes('zele-watch-test-'))
const account = { email: 'watch@example.test', appId: 'watch-test' }
const now = new Date()
const CACHE_TTL_MS = 86_400_000
const STALE_CURSOR = '100'
const OLD_MESSAGE = 'old-message'
const NEW_MESSAGE = 'new-message'
const EXPECTED_SENDER = 'sender@example.test'
const profileRequests: string[] = []
const historyRequests: string[] = []
const state = { cursor: '200', expireNext: false }

await using cleanup = new AsyncDisposableStack()
cleanup.defer(closeDb)
const db = getDb()
db.insert(schema.account).values({
  ...account,
  accountType: 'google',
  accountStatus: 'active',
  capabilities: 'gmail',
  tokens: '{}',
  createdAt: now,
  updatedAt: now,
}).run()

function seedCachedProfile() {
  db.insert(schema.profile).values({
    ...account,
    emailAddress: account.email,
    messagesTotal: 1,
    threadsTotal: 1,
    historyId: STALE_CURSOR,
    ttlMs: CACHE_TTL_MS,
    createdAt: now,
  }).onConflictDoUpdate({
    target: [schema.profile.email, schema.profile.appId],
    set: { historyId: STALE_CURSOR, createdAt: now },
  }).run()
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url!, 'http://localhost')
  response.setHeader('content-type', 'application/json')
  if (url.pathname === '/gmail/v1/users/me/profile') {
    profileRequests.push(state.cursor)
    response.end(JSON.stringify({
      emailAddress: account.email,
      messagesTotal: 2,
      threadsTotal: 1,
      historyId: state.cursor,
    }))
    return
  }
  if (url.pathname === '/gmail/v1/users/me/history') {
    const cursor = url.searchParams.get('startHistoryId')!
    historyRequests.push(cursor)
    if (state.expireNext) {
      state.expireNext = false
      state.cursor = '400'
      response.writeHead(404)
      response.end(JSON.stringify({ error: { code: 404, message: 'History expired' } }))
      return
    }
    // An arrival after the profile snapshot, even if its Date header is old.
    const messageId = cursor === state.cursor ? NEW_MESSAGE : OLD_MESSAGE
    state.cursor = String(Number(state.cursor) + 1)
    response.end(JSON.stringify({
      historyId: state.cursor,
      history: [{ id: state.cursor, messagesAdded: [{ message: { id: messageId } }] }],
    }))
    return
  }
  if (url.pathname.startsWith('/gmail/v1/users/me/messages/')) {
    const id = url.pathname.split('/').at(-1)!
    response.end(JSON.stringify({
      id,
      threadId: 'tracked-thread',
      labelIds: ['INBOX', 'UNREAD'],
      payload: { headers: [
        { name: 'From', value: EXPECTED_SENDER },
        { name: 'Subject', value: 'Tracked question' },
        { name: 'Date', value: 'Tue, 10 Feb 2026 12:00:00 +0000' },
      ] },
    }))
    return
  }
  response.writeHead(400)
  response.end(JSON.stringify({ error: { code: 400, message: `Unexpected request: ${url}` } }))
})
cleanup.defer(() => new Promise<void>((resolve) => {
  server.close(() => resolve())
  server.closeAllConnections()
}))
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert.ok(address && typeof address !== 'string')
const origin = `http://127.0.0.1:${address.port}`
const auth = new OAuth2Client()
auth.setCredentials({ access_token: 'local-test-token' })
// Use the real SDK and HTTP transport against the loopback protocol fixture.
auth.transporter.interceptors.request.add({
  resolved(options) {
    const url = new URL(options.url!)
    assert.equal(url.hostname, 'gmail.googleapis.com')
    options.url = new URL(url.pathname + url.search, origin)
    return options
  },
})
const client = new GmailClient({ auth, account })

async function nextArrival() {
  const controller = new AbortController()
  cleanup.defer(() => controller.abort())
  const watch = client.watchInbox({ query: `from:${EXPECTED_SENDER}`, signal: controller.signal })
  cleanup.defer(async () => {
    controller.abort()
    await watch.return(undefined)
  })
  const result = await watch.next()
  controller.abort()
  await watch.return(undefined)
  assert.equal(result.done, false)
  assert.equal(result.value?.message.id, NEW_MESSAGE)
}

seedCachedProfile()
const cached = await client.getProfile()
assert.ok(!(cached instanceof Error))
assert.equal(cached.historyId, STALE_CURSOR)
assert.deepEqual(profileRequests, [])
console.log('Verify first watch ignores stale cached cursor')
await nextArrival()
assert.deepEqual(historyRequests, ['200'])

seedCachedProfile()
console.log('Verify restarting watch does not replay the same old message')
await nextArrival()
assert.deepEqual(profileRequests, ['200', '201'])
assert.deepEqual(historyRequests, ['200', '201'])

seedCachedProfile()
state.cursor = '300'
state.expireNext = true
console.log('Verify expired history recovers from another live profile')
await nextArrival()
assert.deepEqual(profileRequests, ['200', '201', '300', '400'])
assert.deepEqual(historyRequests, ['200', '201', '300', '400'])
const refreshed = await client.getProfile()
assert.ok(!(refreshed instanceof Error))
assert.equal(refreshed.historyId, '400')
assert.equal(profileRequests.length, 4)
console.log('Cached profiles preserved; two fresh watches and live recovery verified')
