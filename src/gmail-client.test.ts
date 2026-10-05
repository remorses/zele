// Tests for GmailClient parsing behavior used by TUI previews.
// Captures entity/encoding regressions in snippet fields from Gmail metadata responses.

import { expect, test, describe, vi, afterEach } from 'vitest'
import { OAuth2Client } from 'googleapis-common'
import {
  buildGmailMimeMessage,
  buildGmailSearchParams,
  GmailClient,
  parseAuthResults,
  threadMatchesListQuery,
} from './gmail-client.js'
import { mailboxIsSent } from './imap-smtp-client.js'
import { formatFlags } from './output.js'

const auth = new OAuth2Client()
const client = new GmailClient({ auth })

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

  test('plain body without attachments is not multipart/mixed', () => {
    const encoded = buildGmailMimeMessage({
      to: [{ email: 'recipient@example.test' }],
      subject: 'Hi',
      body: 'No files',
      fromEmail: 'me@example.com',
    })
    const mime = decodeGmailRaw(encoded)
    expect(mime).toContain('text/plain')
    expect(mime).not.toContain('multipart/mixed')
    expect(mime).toContain('No files')
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

describe('buildGmailSearchParams', () => {
  test('inbox unread puts in:inbox in q and does not add an INBOX labelId', () => {
    expect(buildGmailSearchParams({ folder: 'inbox', query: 'is:unread' })).toEqual({
      q: 'in:inbox is:unread',
      resolvedLabelIds: [],
    })
  })

  test('mail search with no folder does not force in:inbox', () => {
    expect(buildGmailSearchParams({ query: 'to:foo@bar.com' })).toEqual({
      q: 'to:foo@bar.com',
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


function decodeDraftMime(raw: string) {
  return decodeGmailRaw(raw).replace(
    /(Content-Type: text\/html[^]*?Content-Transfer-Encoding: base64\r?\n\r?\n)([A-Za-z0-9+/=\r\n]+)/g,
    (_, headers, body) => headers + Buffer.from(body, 'base64').toString('utf8'),
  )
}

describe('Gmail draft natural wrapping', () => {
  afterEach(() => vi.restoreAllMocks())
  const to = [{ email: 'recipient@example.test' }]
  const paragraph = 'Tamással a TODO for AI-t építjük. ' + 'This paragraph must wrap naturally. '.repeat(15)
  const body = `Hi,\n\n${paragraph}\n\nBest,\nMarcell`

  test('draft plain text becomes escaped HTML without fixed-width breaks', () => {
    const mime = decodeDraftMime(buildGmailMimeMessage({ to, subject: 'Draft', body, draft: true }))
    expect(mime).toContain('Content-Type: text/html')
    expect(mime).toContain(`<div style="white-space:pre-wrap">Hi,<br><br>${paragraph}<br><br>Best,<br>Marcell</div>`)
    expect(mime).not.toContain('text/plain')
  })

  test('escapes text, normalizes line endings, and preserves intentional blank lines', () => {
    const text = 'A & B < 10 > 2\r\n\r\nline two\rline three\n'
    const mime = decodeDraftMime(buildGmailMimeMessage({ to, subject: 'Draft', body: text, draft: true }))
    expect(mime).toContain('<div style="white-space:pre-wrap">A &amp; B &lt; 10 &gt; 2<br><br>line two<br>line three<br></div>')
  })

  test.each(['Bob <bob@example.test>', 'Vec<String>', 'use <custom-element> literally'])('escapes plain angle brackets: %s', (body) => {
    const mime = decodeDraftMime(buildGmailMimeMessage({ to, subject: 'Draft', body, draft: true }))
    expect(mime).toContain(body.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
  })

  test('preserves indentation and spaces with naturally wrapping CSS', () => {
    const mime = decodeDraftMime(buildGmailMimeMessage({ to, subject: 'Draft', body: '  indented  text', draft: true }))
    expect(mime).toContain('<div style="white-space:pre-wrap">  indented  text</div>')
  })

  test('draft transport uses base64 for Unicode and bounded MIME lines', () => {
    const raw = decodeGmailRaw(buildGmailMimeMessage({ to, subject: 'Draft', body: paragraph.repeat(20), draft: true }))
    expect(raw).toContain('Content-Transfer-Encoding: base64')
    expect(Math.max(...raw.split(/\r?\n/).map((line) => line.length))).toBeLessThan(998)
  })

  test('existing HTML is unchanged rather than escaped twice', () => {
    const html = '<p>Hello &amp; goodbye</p><p>Second paragraph</p>'
    const mime = decodeDraftMime(buildGmailMimeMessage({ to, subject: 'Draft', body: html, draft: true }))
    expect(mime).toContain(html)
    expect(mime).not.toContain('&lt;p&gt;')
  })

  test('updating a generated HTML draft does not add a second wrapper', () => {
    const mime = decodeDraftMime(buildGmailMimeMessage({ to, subject: 'Draft', body, draft: true }))
    const html = mime.slice(mime.indexOf('<div style='))
    const updated = decodeDraftMime(buildGmailMimeMessage({ to, subject: 'Updated', body: html, draft: true }))
    expect(updated.match(/<div style=/g)).toHaveLength(1)
    expect(updated).toContain(paragraph)
    expect(updated).not.toContain('&lt;div')
  })

  test('direct plain-text messages remain plain text', () => {
    const mime = decodeDraftMime(buildGmailMimeMessage({ to, subject: 'Send', body }))
    expect(mime).toContain('Content-Type: text/plain')
    expect(mime).toContain(paragraph)
    expect(mime).not.toContain('<br>')
  })

  test('HTML draft retains attachments, recipients, and reply headers', () => {
    const mime = decodeDraftMime(buildGmailMimeMessage({
      to, subject: 'Draft', body, draft: true,
      cc: [{ email: 'cc@example.test' }], bcc: [{ email: 'bcc@example.test' }],
      inReplyTo: '<anchor@example.test>', references: '<older@example.test> <anchor@example.test>',
      attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF') }],
    }))
    expect(mime).toContain('text/html')
    expect(mime).toContain('report.pdf')
    expect(mime).toContain('cc@example.test')
    expect(mime).toContain('bcc@example.test')
    expect(mime).toContain('In-Reply-To: <anchor@example.test>')
    expect(mime).toContain('References: <older@example.test> <anchor@example.test>')
  })

  test.each(['create', 'update', 'reply', 'forward'])('%s path generates HTML drafts', async (operation) => {
    const client = new GmailClient({ auth: new OAuth2Client() })
    const api = vi.fn().mockResolvedValue({ data: { id: 'draft_1' } })
    const methods = (client as any).gmail.users.drafts
    vi.spyOn(methods, 'create').mockImplementation(api)
    vi.spyOn(methods, 'update').mockImplementation(api)
    const anchor = {
      id: 'anchor_1', subject: 'Original', body: 'Previous message', mimeType: 'text/plain',
      from: { name: 'Sender Name', email: 'sender@example.test' }, to, date: '2026-10-01', labelIds: ['INBOX'],
    }
    vi.spyOn(client, 'getThread').mockResolvedValue({ parsed: { messages: [anchor] } } as any)
    vi.spyOn(client, 'resolveThreadReply').mockResolvedValue({
      to, anchorSubject: 'Original', inReplyTo: '<anchor@example.test>',
      references: '<anchor@example.test>', source: 'explicit',
    } as any)

    if (operation === 'create') await client.createDraft({ to, subject: 'Draft', body })
    if (operation === 'update') await client.updateDraft({ draftId: 'draft_1', to, subject: 'Draft', body })
    if (operation === 'reply') await client.createDraftReply({ threadId: 'thread_1', body })
    if (operation === 'forward') await client.createDraftForward({ threadId: 'thread_1', to, body })

    expect(api).toHaveBeenCalledOnce()
    const mime = decodeDraftMime(api.mock.calls[0][0].requestBody.message.raw)
    expect(mime).toContain('Content-Type: text/html')
    expect(mime).toContain(paragraph)
    expect(mime).toContain('Hi,<br><br>')
    if (operation === 'forward') expect(mime).toContain('Sender Name &lt;sender@example.test&gt;')
  })
})
