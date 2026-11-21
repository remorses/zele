// Tests for picking the account that holds a thread when several are signed in.

import { describe, expect, test, vi } from 'vitest'
import { pickThreadClient, type AccountType } from './auth.js'
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
    expect(work.client.getThread).toHaveBeenCalledWith({ threadId: THREAD_A, headersOnly: true })
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
