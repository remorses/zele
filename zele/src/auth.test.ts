// Tests for picking the account that holds a thread when several are signed in.

import { describe, expect, test } from 'vitest'
import { pickThreadClient } from './auth.js'
import { ApiError, AuthError } from './api-utils.js'

function fakeClient(email: string, threadIds: string[], error?: Error) {
  return {
    email,
    client: {
      async getThread({ threadId }: { threadId: string }) {
        if (error) return error
        if (threadIds.includes(threadId)) return { parsed: { id: threadId } }
        return new ApiError({ reason: 'Requested entity was not found.' })
      },
    },
  }
}

describe('pickThreadClient', () => {
  const work = fakeClient('me@work.example', ['1a1f5b5220d25d49'])
  const home = fakeClient('me@home.example', ['16426a350b26c600'])

  test('single account is used without a lookup', async () => {
    expect((await pickThreadClient([home], '1a1f5b5220d25d49')) === home).toBe(true)
  })

  test('picks the account that has the thread', async () => {
    expect((await pickThreadClient([work, home], '1a1f5b5220d25d49')) === work).toBe(true)
    expect((await pickThreadClient([work, home], '16426a350b26c600')) === home).toBe(true)
  })

  test('not found in any account', async () => {
    const result = await pickThreadClient([work, home], 'ffffffffffffffff')
    expect((result as Error).message).toMatchInlineSnapshot(`"thread ffffffffffffffff (searched me@work.example, me@home.example) not found"`)
  })

  test('found in several accounts', async () => {
    const imapA = fakeClient('a@imap.example', ['INBOX:12'])
    const imapB = fakeClient('b@imap.example', ['INBOX:12'])
    const result = await pickThreadClient([imapA, imapB], 'INBOX:12')
    expect((result as Error).message).toMatchInlineSnapshot(`"Thread INBOX:12 exists in several accounts (a@imap.example, b@imap.example). Specify --account"`)
  })

  test('an auth failure wins over not found', async () => {
    const broken = fakeClient('me@broken.example', [], new AuthError({ email: 'me@broken.example', reason: 'token expired' }))
    const result = await pickThreadClient([work, broken], 'ffffffffffffffff')
    expect(result).toBeInstanceOf(AuthError)
  })
})
