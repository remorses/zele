// Tests for picking the account that holds a thread when several are signed in,
// and for refreshing zele.sh client tokens through a local relay.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createGoogleAuth, pickThreadClient, type AccountType } from './auth.js'
import { ApiError, AuthError } from './api-utils.js'

const THREAD_A = '1a1f5b5220d25d49'
const THREAD_B = '16426a350b26c600'
const MISSING = 'ffffffffffffffff'

const notFound = () => new ApiError({ reason: 'Requested entity was not found.', cause: { code: 404 } })

function fakeClient(email: string, threadIds: string[], { accountType = 'google', error }: { accountType?: AccountType; error?: Error } = {}) {
  const getThread = vi.fn(async ({ threadId }: { threadId: string; headersOnly?: boolean }) => {
    if (error) return error
    if (threadIds.includes(threadId)) return { parsed: { id: threadId } }
    return notFound()
  })
  return { email, accountType, client: { getThread } }
}

describe('pickThreadClient', () => {
  test('single account is used without a lookup', async () => {
    const home = fakeClient('me@home.example', [])
    expect(await pickThreadClient([home], THREAD_A)).toBe(home)
    expect(home.client.getThread).not.toHaveBeenCalled()
  })

  test('picks the Google account that has the thread, with the metadata fetch', async () => {
    const work = fakeClient('me@work.example', [THREAD_A])
    const home = fakeClient('me@home.example', [THREAD_B])
    expect(await pickThreadClient([work, home], THREAD_A)).toBe(work)
    expect(await pickThreadClient([work, home], THREAD_B)).toBe(home)
    expect(work.client.getThread).toHaveBeenCalledWith({ threadId: THREAD_A, skipCache: true, headersOnly: true })
  })

  test('a Gmail ID with one Google account needs no lookup', async () => {
    const google = fakeClient('me@work.example', [THREAD_A])
    const imap = fakeClient('me@imap.example', [], { accountType: 'imap_smtp' })
    expect(await pickThreadClient([imap, google], THREAD_A)).toBe(google)
    expect(google.client.getThread).not.toHaveBeenCalled()
    expect(imap.client.getThread).not.toHaveBeenCalled()
  })

  test('IMAP IDs repeat between mailboxes, so they still need --account', async () => {
    const a = fakeClient('a@imap.example', ['INBOX:12'], { accountType: 'imap_smtp' })
    const b = fakeClient('b@imap.example', [], { accountType: 'imap_smtp' })
    const result = await pickThreadClient([a, b], 'INBOX:12')
    expect((result as Error).message).toMatchInlineSnapshot(`"Multiple accounts matched. Specify --account: a@imap.example, b@imap.example"`)
    expect(a.client.getThread).not.toHaveBeenCalled()
    expect(b.client.getThread).not.toHaveBeenCalled()
  })

  test('not found in any account', async () => {
    const result = await pickThreadClient([fakeClient('me@work.example', []), fakeClient('me@home.example', [])], MISSING)
    expect((result as Error).message).toMatchInlineSnapshot(`"thread ffffffffffffffff (searched me@work.example, me@home.example) not found"`)
  })

  test('found in several accounts', async () => {
    const result = await pickThreadClient(
      [fakeClient('me@work.example', [THREAD_A]), fakeClient('me@home.example', [THREAD_A])],
      THREAD_A,
    )
    expect((result as Error).message).toMatchInlineSnapshot(`"Thread 1a1f5b5220d25d49 exists in several accounts (me@work.example, me@home.example). Specify --account"`)
  })

  test('a failure that may hide the thread is reported instead of not found', async () => {
    const authError = new AuthError({ email: 'me@broken.example', reason: 'token expired' })
    const serverError = new ApiError({ reason: 'Backend Error', cause: { code: 500 } })
    const work = fakeClient('me@work.example', [])
    expect(await pickThreadClient([work, fakeClient('me@broken.example', [], { error: authError })], MISSING)).toBe(authError)
    expect(await pickThreadClient([work, fakeClient('me@broken.example', [], { error: serverError })], MISSING)).toBe(serverError)
  })
})

describe('createGoogleAuth for the zele.sh client', () => {
  /** Local stand-in for zele.sh /api/v1/oauth/google/refresh. Counts hits. */
  async function startRefreshRelay() {
    const hits: string[] = []
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const { refreshToken } = JSON.parse(Buffer.concat(chunks).toString()) as { refreshToken: string }
      hits.push(refreshToken)
      res.writeHead(refreshToken === 'revoked' ? 400 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(refreshToken === 'revoked'
        ? { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }
        : { access_token: 'access-2', expires_in: 3599, token_type: 'Bearer' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    return { apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits }
  }

  const servers: http.Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  const client = { redirect: 'zele.sh', clientId: 'zele-web-test' } as const
  const expired = { access_token: 'access-1', expiry_date: Date.now() - 1000, scope: 'gmail.modify calendar', token_type: 'Bearer' }

  test('parallel token requests refresh once; saved tokens keep refresh_token and scope', async () => {
    const relay = await startRefreshRelay()
    const saved: object[] = []
    const auth = createGoogleAuth({ client, tokens: { ...expired, refresh_token: 'refresh-1' }, email: 'me@example.com', apiUrl: relay.apiUrl, onRefresh: (t) => saved.push(t) })
    const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken()])
    expect(tokens.map((t) => t.token)).toEqual(['access-2', 'access-2'])
    expect(relay.hits).toEqual(['refresh-1'])
    expect(saved.map((t) => ({ ...t, expiry_date: typeof (t as { expiry_date: unknown }).expiry_date }))).toMatchInlineSnapshot(`
      [
        {
          "access_token": "access-2",
          "expiry_date": "number",
          "refresh_token": "refresh-1",
          "scope": "gmail.modify calendar",
          "token_type": "Bearer",
        },
      ]
    `)
    expect(auth.credentials.scope).toBe('gmail.modify calendar')
  })

  test('a revoked refresh token gives AuthError with a login hint', async () => {
    const relay = await startRefreshRelay()
    const auth = createGoogleAuth({ client, tokens: { ...expired, refresh_token: 'revoked' }, email: 'me@example.com', apiUrl: relay.apiUrl })
    const result = await auth.getAccessToken().catch((err: unknown) => err)
    expect(result instanceof AuthError && result.message).toMatchInlineSnapshot(`"Authentication failed for me@example.com: Google sign-in expired or was revoked. Run: zele login"`)
  })
})
