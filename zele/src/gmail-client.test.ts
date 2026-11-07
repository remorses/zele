// Tests for GmailClient parsing behavior used by TUI previews.
// Captures entity/encoding regressions in snippet fields from Gmail metadata responses.

import { expect, test, describe, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { OAuth2Client } from 'googleapis-common'
import {
  buildGmailMimeMessage,
  buildGmailSearchParams,
  GmailClient,
  parseAuthResults,
  threadMatchesListQuery,
} from './gmail-client.js'
import { mailboxIsSent } from './imap-smtp-client.js'
import { withRetry } from './api-utils.js'
import { formatFlags } from './output.js'

const auth = new OAuth2Client()
const client = new GmailClient({ auth })
const WATCH_FIXTURE_TIMEOUT_MS = 3_000

test('watch seeds and recovers from live history, not a cached profile', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zele-watch-test-'))
  await using cleanup = new AsyncDisposableStack()
  cleanup.defer(() => fs.rmSync(home, { recursive: true, force: true }))
  const result = await promisify(execFile)('bun', ['src/test-fixtures/gmail-watch.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOME: home },
    signal: AbortSignal.timeout(WATCH_FIXTURE_TIMEOUT_MS),
  })
  expect(result.stdout).toContain('Cached profiles preserved; two fresh watches and live recovery verified')
})

function listThread(messages: Array<{
  from: string
  to: string
  labels: string[]
  subject?: string
  snippet?: string
  inReplyTo?: string
}>) {
  return {
    id: 'thread_list',
    messages: messages.map((m, i) => ({
      id: `msg_${i}`,
      snippet: m.snippet ?? 'Hello',
      labelIds: m.labels,
      payload: {
        headers: [
          { name: 'from', value: m.from },
          { name: 'to', value: m.to },
          { name: 'subject', value: m.subject ?? 'Hello' },
          { name: 'date', value: 'Tue, 10 Feb 2026 12:00:00 +0000' },
          ...(m.inReplyTo ? [{ name: 'in-reply-to', value: m.inReplyTo }] : []),
        ],
      },
    })),
  }
}

test('thread list snippet decodes HTML entities for TUI preview', () => {
  const rawThread = {
    id: 'thread_1',
    messages: [
      {
        snippet: 'It&#39;s ready &amp; waiting',
        payload: { headers: [{ name: 'subject', value: 'Status update' }, { name: 'from', value: 'News <news@example.com>' }, { name: 'date', value: 'Tue, 10 Feb 2026 12:00:00 +0000' }] },
        labelIds: ['INBOX'],
      },
    ],
  }

  const parsed = client.parseThreadListItem(rawThread as any)
  expect(parsed.snippet).toBe("It's ready & waiting")
})

test('message snippet decodes HTML entities for detail preview', () => {
  const rawMessage = {
    id: 'msg_1',
    threadId: 'thread_1',
    snippet: 'Built with Opus [4.6](https://4.6): you&#39;re in',
    payload: {
      headers: [
        { name: 'subject', value: 'Event update' },
        { name: 'from', value: 'Events <events@example.com>' },
        { name: 'to', value: 'user@example.com' },
        { name: 'date', value: 'Tue, 10 Feb 2026 12:00:00 +0000' },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from('hello').toString('base64url') },
    },
    labelIds: ['INBOX'],
  }

  const parsed = client.parseMessage(rawMessage as any)
  expect(parsed.snippet).toBe("Built with Opus [4.6](https://4.6): you're in")
})

test('thread list snippet strips zero-width and preheader garbage', () => {
  const rawThread = {
    id: 'thread_2',
    messages: [
      {
        snippet: 'A host sent you a message\u034F\u200B\u200D\uFEFF',
        payload: { headers: [{ name: 'subject', value: 'Ping' }, { name: 'from', value: 'Host <host@example.com>' }, { name: 'date', value: 'Tue, 10 Feb 2026 12:00:00 +0000' }] },
        labelIds: ['INBOX'],
      },
    ],
  }

  const parsed = client.parseThreadListItem(rawThread as any)
  expect(parsed.snippet).toBe('A host sent you a message')
})

// ---------------------------------------------------------------------------
// parseAuthResults
// ---------------------------------------------------------------------------

describe('parseAuthResults', () => {
  test('parses standard Gmail Authentication-Results header', () => {
    const header = `mx.google.com;
       dkim=pass header.i=@example.com header.s=selector1;
       spf=pass (google.com: domain of user@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=user@example.com;
       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com`
    const result = parseAuthResults(header)
    expect(result).toMatchInlineSnapshot(`
      {
        "authentic": true,
        "dkim": "pass",
        "dmarc": "pass",
        "raw": "mx.google.com;
             dkim=pass header.i=@example.com header.s=selector1;
             spf=pass (google.com: domain of user@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=user@example.com;
             dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com",
        "spf": "pass",
      }
    `)
  })

  test('Cloudflare Email Routing: HELO spf=none followed by MAIL FROM spf=pass is a pass', () => {
    const header = 'mx.cloudflare.net; dkim=pass header.d=gmail.com; dmarc=pass header.from=gmail.com policy.dmarc=none; spf=none (no SPF records found for postmaster@mail-yw1.google.com) smtp.helo=mail-yw1.google.com; spf=pass smtp.mailfrom=beats.by.morse@gmail.com; arc=pass'
    const { raw: _raw, ...result } = parseAuthResults(header)
    expect(result).toMatchInlineSnapshot(`
      {
        "authentic": true,
        "dkim": "pass",
        "dmarc": "pass",
        "spf": "pass",
      }
    `)
  })

  test('detects failed authentication', () => {
    const header = `mx.google.com;
       dkim=fail (bad signature) header.i=@spoofed.com;
       spf=softfail (google.com: domain transitioning) smtp.mailfrom=other.com;
       dmarc=fail (p=REJECT) header.from=spoofed.com`
    const result = parseAuthResults(header)
    expect(result).toMatchInlineSnapshot(`
      {
        "authentic": false,
        "dkim": "fail",
        "dmarc": "fail",
        "raw": "mx.google.com;
             dkim=fail (bad signature) header.i=@spoofed.com;
             spf=softfail (google.com: domain transitioning) smtp.mailfrom=other.com;
             dmarc=fail (p=REJECT) header.from=spoofed.com",
        "spf": "softfail",
      }
    `)
  })

  test('handles missing protocols gracefully', () => {
    const header = `mx.google.com; spf=pass smtp.mailfrom=user@example.com`
    const result = parseAuthResults(header)
    expect(result).toMatchInlineSnapshot(`
      {
        "authentic": false,
        "dkim": "none",
        "dmarc": "none",
        "raw": "mx.google.com; spf=pass smtp.mailfrom=user@example.com",
        "spf": "pass",
      }
    `)
  })

  test('handles bestguesspass for DMARC', () => {
    const header = `mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=bestguesspass header.from=example.com`
    const result = parseAuthResults(header)
    expect(result).toMatchInlineSnapshot(`
      {
        "authentic": false,
        "dkim": "pass",
        "dmarc": "bestguesspass",
        "raw": "mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=bestguesspass header.from=example.com",
        "spf": "pass",
      }
    `)
  })

  test('parseMessage includes auth for received messages', () => {
    const rawMessage = {
      id: 'msg_auth_1',
      threadId: 'thread_auth_1',
      snippet: 'Test',
      payload: {
        headers: [
          { name: 'Subject', value: 'Auth test' },
          { name: 'From', value: 'sender@example.com' },
          { name: 'To', value: 'me@example.com' },
          { name: 'Date', value: 'Wed, 25 Mar 2026 10:00:00 +0000' },
          { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=pass (p=REJECT) header.from=example.com' },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from('hello').toString('base64url') },
      },
      labelIds: ['INBOX'],
    }
    const parsed = client.parseMessage(rawMessage as any)
    expect(parsed.auth).toMatchInlineSnapshot(`
      {
        "authentic": true,
        "dkim": "pass",
        "dmarc": "pass",
        "raw": "mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=pass (p=REJECT) header.from=example.com",
        "spf": "pass",
      }
    `)
  })

  test('attachment IDs are stable MIME part IDs, not Gmail per-fetch IDs', () => {
    // Gmail returns a new body.attachmentId on every messages.get.
    const fetchWithAttachmentId = (gmailAttachmentId: string) => client.parseMessage({
      id: 'msg_att_1',
      threadId: 'thread_att_1',
      payload: {
        partId: '',
        mimeType: 'multipart/mixed',
        headers: [{ name: 'Subject', value: 'Files' }, { name: 'From', value: 'a@example.com' }],
        parts: [
          { partId: '0', mimeType: 'text/plain', body: { data: Buffer.from('hi').toString('base64url') } },
          { partId: '1', mimeType: 'application/pdf', filename: 'doc.pdf', body: { attachmentId: gmailAttachmentId, size: 10 } },
        ],
      },
    } as any)
    const first = fetchWithAttachmentId('ANGjdJ-first')
    const second = fetchWithAttachmentId('ANGjdJ-second')
    expect(first.attachments).toEqual(second.attachments)
    expect(first.attachments.map((a) => `${a.attachmentId} ${a.filename}`)).toEqual(['1 doc.pdf'])
  })

  test('parseMessage prefers Gmail trusted header over upstream headers', () => {
    const rawMessage = {
      id: 'msg_multi_auth',
      threadId: 'thread_multi_auth',
      snippet: 'Multi-header',
      payload: {
        headers: [
          { name: 'Subject', value: 'Forwarded' },
          { name: 'From', value: 'sender@example.com' },
          { name: 'To', value: 'me@example.com' },
          { name: 'Date', value: 'Wed, 25 Mar 2026 10:00:00 +0000' },
          // Upstream relay header (untrusted, appears first)
          { name: 'Authentication-Results', value: 'relay.untrusted.com; dkim=fail; spf=fail; dmarc=fail' },
          // Gmail's trusted header (should be preferred)
          { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=pass (p=REJECT)' },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from('hello').toString('base64url') },
      },
      labelIds: ['INBOX'],
    }
    const parsed = client.parseMessage(rawMessage as any)
    expect(parsed.auth?.authentic).toBe(true)
    expect(parsed.auth?.spf).toBe('pass')
    expect(parsed.auth?.dkim).toBe('pass')
    expect(parsed.auth?.dmarc).toBe('pass')
  })

  test('parseMessage returns null auth for sent messages', () => {
    const rawMessage = {
      id: 'msg_sent_1',
      threadId: 'thread_sent_1',
      snippet: 'Sent',
      payload: {
        headers: [
          { name: 'Subject', value: 'Outgoing' },
          { name: 'From', value: 'me@example.com' },
          { name: 'To', value: 'other@example.com' },
          { name: 'Date', value: 'Wed, 25 Mar 2026 10:00:00 +0000' },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from('hello').toString('base64url') },
      },
      labelIds: ['SENT'],
    }
    const parsed = client.parseMessage(rawMessage as any)
    expect(parsed.auth).toBeNull()
  })
})

function decodeGmailRaw(raw: string) {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((raw.length + 3) % 4)
  return Buffer.from(padded, 'base64').toString('utf8')
}

describe('buildGmailMimeMessage', () => {
  const pdf = Buffer.from('%PDF-1.4 gmail-invoice')

  test('PDF attachment survives Gmail base64url MIME', () => {
    const encoded = buildGmailMimeMessage({
      to: [{ email: 'recipient@example.test' }],
      subject: 'Invoice',
      body: 'Hello Shawn',
      attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', content: pdf }],
      fromEmail: 'me@example.com',
    })
    const mime = decodeGmailRaw(encoded)
    expect(mime).toContain('multipart/mixed')
    expect(mime).toContain('application/pdf')
    expect(mime).toContain('invoice.pdf')
    expect(mime).toMatch(/Content-Disposition:\s*attachment/)
    const part = mime.split(/\n--/).find((p) => p.includes('invoice.pdf'))
    expect(part).toBeTruthy()
    const body = part!.split(/\r?\n\r?\n/).slice(1).join('\n').replace(/\s+/g, '')
    expect(Buffer.from(body, 'base64')).toEqual(pdf)
  })

  test('plain body gets an HTML alternative so Gmail never hard-wraps it', () => {
    const body = 'Hi Bob,\n\nAsk <alice@example.test> about Vec<String> & co.\n  indented'
    const mime = decodeGmailRaw(buildGmailMimeMessage({
      to: [{ email: 'recipient@example.test' }],
      subject: 'Hi',
      body,
      fromEmail: 'me@example.com',
    }))
    expect(mime).toContain('multipart/alternative')
    expect(mime).not.toContain('multipart/mixed')
    const part = (type: string) => mime.split(/\r?\n--/).find((p) => p.includes(`Content-Type: ${type}`))!.split(/\r?\n\r?\n/).slice(1).join('\n\n').trimEnd()
    expect(part('text/plain')).toBe(body)
    expect(part('text/html')).toMatchInlineSnapshot(`"<div style="white-space:pre-wrap">Hi Bob,<br><br>Ask &lt;alice@example.test&gt; about Vec&lt;String&gt; &amp; co.<br>  indented</div>"`)
  })

  test('HTML body is sent as HTML only', () => {
    const body = '<p>Hello &amp; <b>bye</b></p>'
    const mime = decodeGmailRaw(buildGmailMimeMessage({
      to: [{ email: 'recipient@example.test' }],
      subject: 'Hi',
      body,
    }))
    expect(mime).toContain('Content-Type: text/html')
    expect(mime).toContain(body)
    expect(mime).not.toContain('text/plain')
  })
})

describe('parseThreadListItem from field', () => {
  test('sent-only thread keeps the user as from, not the recipient', () => {
    const parsed = client.parseThreadListItem(listThread([
      {
        from: 'Tommy <me@example.com>',
        to: 'support@outrank.so',
        labels: ['SENT', 'INBOX'],
        subject: 'Backlinks-only plan: one sub for multiple sites?',
      },
    ]) as any)
    expect(parsed.from).toEqual({ name: 'Tommy', email: 'me@example.com' })
    expect(parsed.to.map((s) => s.email)).toEqual(['support@outrank.so'])
    expect(parsed.unread).toBe(false)
    expect(parsed.sent).toBe(true)
    expect(formatFlags(parsed)).toBe('sent')
  })

  test('conversation where the user sent last still uses the latest From header', () => {
    const parsed = client.parseThreadListItem(listThread([
      {
        from: 'Lauren <lauren@openrouter.ai>',
        to: 'me@example.com',
        labels: ['INBOX'],
        subject: 'Re: Video call',
      },
      {
        from: 'Tommy <me@example.com>',
        to: 'lauren@openrouter.ai',
        labels: ['SENT', 'INBOX'],
        subject: 'Re: Video call',
        inReplyTo: '<lauren-msg>',
      },
    ]) as any)
    expect(parsed.from).toEqual({ name: 'Tommy', email: 'me@example.com' })
    expect(parsed.sent).toBe(true)
    expect(formatFlags(parsed)).toBe('sent, reply')
  })

  test('inbound latest message still shows the other party as from', () => {
    const parsed = client.parseThreadListItem(listThread([
      {
        from: 'Apoorva G <apoorvag99@gmail.com>',
        to: 'me@example.com',
        labels: ['INBOX', 'UNREAD'],
        subject: 'Cancellation + refund request',
      },
    ]) as any)
    expect(parsed.from).toEqual({ name: 'Apoorva G', email: 'apoorvag99@gmail.com' })
    expect(parsed.unread).toBe(true)
    expect(parsed.sent).toBe(false)
    expect(formatFlags(parsed)).toBe('unread')
  })
})

describe('mailboxIsSent', () => {
  test('treats RFC 6154 Sent mailboxes as sent even when the path is not a fallback name', () => {
    expect(mailboxIsSent({
      requestedFolder: 'sent',
      mailboxPath: '[Gmail]/Sent Mail',
      specialUse: '\\Sent',
    })).toBe(true)
    expect(mailboxIsSent({
      requestedFolder: 'inbox',
      mailboxPath: '[Gmail]/Sent Mail',
      specialUse: '\\Sent',
    })).toBe(true)
    expect(mailboxIsSent({
      requestedFolder: 'inbox',
      mailboxPath: 'INBOX',
    })).toBe(false)
  })
})

describe('lookupLabel', () => {
  test('returns system label ids without calling Gmail', async () => {
    expect(await client.lookupLabel('INBOX')).toBe('INBOX')
    expect(await client.lookupLabel('SENT')).toBe('SENT')
  })
})

describe('label resolution with a stale labels cache', () => {
  type RawLabel = { id: string; name: string; type: string }
  const freshLabels: RawLabel[] = [
    { id: 'Label_1', name: 'Work', type: 'user' },
    { id: 'Label_2', name: 'Personal', type: 'user' },
  ]
  const staleLabels: RawLabel[] = [{ id: 'Label_9', name: 'Old', type: 'user' }]

  // Fake Gmail API + a stale 30-minute cache; account stays null so no DB is touched.
  function setup() {
    const c = new GmailClient({ auth: new OAuth2Client() })
    const list = vi.fn(async () => ({ data: { labels: freshLabels } }))
    const create = vi.fn(async ({ requestBody }: { requestBody: { name: string } }) => ({
      data: { id: 'Label_99', name: requestBody.name },
    }))
    ;(c as any).gmail = { users: { labels: { list, create } } }
    vi.spyOn(c as any, 'getCachedLabels').mockResolvedValue(staleLabels)
    return { c, list, create }
  }

  test('lookupLabel finds a label missing from the stale cache by name', async () => {
    const { c, list } = setup()
    expect(await c.lookupLabel('work')).toBe('Label_1')
    expect(list).toHaveBeenCalledTimes(1)
  })

  test('lookupLabel matches a Gmail label ID', async () => {
    const { c } = setup()
    expect(await c.lookupLabel('Label_2')).toBe('Label_2')
  })

  test('lookupLabel returns null when the label is missing live too', async () => {
    const { c } = setup()
    expect(await c.lookupLabel('Nope')).toBeNull()
  })

  test('lookupLabel does not hit the API when the cache already has the label', async () => {
    const { c, list } = setup()
    expect(await c.lookupLabel('Old')).toBe('Label_9')
    expect(list).not.toHaveBeenCalled()
  })

  test('resolveLabel never creates a label for a name that exists live', async () => {
    const { c, create } = setup()
    expect(await c.resolveLabel('Personal')).toBe('Label_2')
    expect(create).not.toHaveBeenCalled()
  })

  test('resolveLabel never creates a literal label from an unknown label ID', async () => {
    const { c, create } = setup()
    const result = await c.resolveLabel('Label_12')
    expect(result).toBeInstanceOf(Error)
    expect(create).not.toHaveBeenCalled()
  })

  test('resolveLabel still auto-creates a genuinely new name', async () => {
    const { c, create } = setup()
    expect(await c.resolveLabel('travel')).toBe('Label_99')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0].requestBody.name).toBe('Travel')
  })
})

describe('buildGmailSearchParams', () => {
  test('inbox unread puts in:inbox in q and does not add an INBOX labelId', () => {
    expect(buildGmailSearchParams({ folder: 'inbox', query: 'is:unread' })).toEqual({
      q: 'in:inbox is:unread',
      resolvedLabelIds: [],
    })
  })

  test('mail search with no folder does not force in:inbox', () => {
    expect(buildGmailSearchParams({ query: 'to:alice@example.com' })).toEqual({
      q: 'to:alice@example.com',
      resolvedLabelIds: [],
    })
  })
})

describe('threadMatchesListQuery', () => {
  const readSent = {
    unread: false,
    starred: false,
  }
  const unreadInbound = {
    unread: true,
    starred: false,
  }

  test('is:unread drops threads that are not unread after hydration', () => {
    expect(threadMatchesListQuery(readSent, 'is:unread')).toBe(false)
    expect(threadMatchesListQuery(unreadInbound, 'is:unread')).toBe(true)
  })

  test('in:inbox is:unread still requires unread', () => {
    expect(threadMatchesListQuery(readSent, 'in:inbox is:unread')).toBe(false)
    expect(threadMatchesListQuery(unreadInbound, 'in:inbox is:unread')).toBe(true)
  })

  test('queries without is:unread keep read threads', () => {
    expect(threadMatchesListQuery(readSent, 'from:github')).toBe(true)
    expect(threadMatchesListQuery(readSent)).toBe(true)
  })

  test('-is:unread keeps read threads and drops unread ones', () => {
    expect(threadMatchesListQuery(readSent, '-is:unread')).toBe(true)
    expect(threadMatchesListQuery(unreadInbound, '-is:unread')).toBe(false)
  })

  test('is:read matches the inverse of unread', () => {
    expect(threadMatchesListQuery(readSent, 'is:read')).toBe(true)
    expect(threadMatchesListQuery(unreadInbound, 'is:read')).toBe(false)
  })

  test('OR queries are not AND-filtered client-side', () => {
    expect(threadMatchesListQuery(readSent, 'is:unread OR is:starred')).toBe(true)
  })
})

describe('opt-in single-attempt send and no-cache reads', () => {
  const account = { email: 'owner@example.com', appId: 'test-app', accountType: 'google', capabilities: [] } as any

  function rateLimitError() {
    return Object.assign(new Error('Quota exceeded'), { code: 429 })
  }

  test('withRetry with maxAttempts 1 calls the function exactly once', async () => {
    const fn = vi.fn(async () => {
      throw rateLimitError()
    })
    await expect(withRetry(fn, 1)).rejects.toThrow('Quota exceeded')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('withRetry still uses the full attempt budget when allowed', async () => {
    const fn = vi.fn(async () => {
      throw rateLimitError()
    })
    await expect(withRetry(fn, 3, 1)).rejects.toThrow('Quota exceeded')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('sendMessage with singleAttempt makes exactly one send request on a retryable failure', async () => {
    const c = new GmailClient({ auth: new OAuth2Client(), account })
    const send = vi.fn(async () => {
      throw rateLimitError()
    })
    ;(c as any).gmail = { users: { messages: { send } } }

    const result = await c.sendMessage({
      to: [{ email: 'friend@example.com' }],
      subject: 'Hi',
      body: 'Hello',
      singleAttempt: true,
    })

    expect(result).toBeInstanceOf(Error)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('getThread with noCache neither reads nor writes the thread cache', async () => {
    const c = new GmailClient({ auth: new OAuth2Client(), account })
    const rawThread = listThread([{ from: 'A <a@example.com>', to: 'owner@example.com', labels: ['INBOX'] }])
    const getCached = vi.spyOn(c as any, 'getCachedThread').mockResolvedValue(undefined)
    const putCache = vi.spyOn(c as any, 'cacheThreadData').mockResolvedValue(undefined)
    ;(c as any).gmail = { users: { threads: { get: vi.fn(async () => ({ data: rawThread })) } } }

    const fresh = await c.getThread({ threadId: 'thread_list', noCache: true })
    expect(fresh).not.toBeInstanceOf(Error)
    expect(getCached).not.toHaveBeenCalled()
    expect(putCache).not.toHaveBeenCalled()

    const normal = await c.getThread({ threadId: 'thread_list' })
    expect(normal).not.toBeInstanceOf(Error)
    expect(getCached).toHaveBeenCalledTimes(1)
    expect(putCache).toHaveBeenCalledTimes(1)
  })

  test('listThreads with noCache ignores a fresh cache entry and does not write back', async () => {
    const c = new GmailClient({ auth: new OAuth2Client(), account })
    const rawThread = { ...listThread([{ from: 'A <a@example.com>', to: 'owner@example.com', labels: ['INBOX'] }]), historyId: 'h2' }
    const getCached = vi.spyOn(c as any, 'getCachedThread').mockResolvedValue(rawThread)
    const putCache = vi.spyOn(c as any, 'cacheThreadData').mockResolvedValue(undefined)
    const threadsGet = vi.fn(async () => ({ data: rawThread }))
    ;(c as any).gmail = {
      users: {
        threads: {
          list: vi.fn(async () => ({ data: { threads: [{ id: 'thread_list', historyId: 'h2' }] } })),
          get: threadsGet,
        },
      },
    }

    // Default: the cache entry matches the list historyId, so no fetch happens.
    const cachedResult = await c.listThreads({ maxResults: 5 })
    expect(cachedResult).not.toBeInstanceOf(Error)
    expect(threadsGet).not.toHaveBeenCalled()

    // noCache: the cache is bypassed, the thread is fetched live, and the
    // fetched copy is not written back.
    const freshResult = await c.listThreads({ maxResults: 5, noCache: true })
    expect(freshResult).not.toBeInstanceOf(Error)
    expect(threadsGet).toHaveBeenCalledTimes(1)
    expect(getCached).toHaveBeenCalledTimes(1) // only from the default call above
    expect(putCache).not.toHaveBeenCalled()
  })
})
