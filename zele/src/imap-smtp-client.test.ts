import { expect, test, describe } from 'vitest'
import {
  decodeQuotedPrintable,
  ImapSmtpClient,
  imapSearchFolders,
  pageThreadsByDate,
  parseImapSearchQuery,
  tlsSocketOptions,
  imapTlsOptions,
} from './imap-smtp-client.js'
import type { FetchMessageObject } from 'imapflow'
import { buildOutgoingMime } from './email-utils.js'

describe('IMAP MIME body decoding', () => {
  const client = new ImapSmtpClient({
    account: { email: 'reader@example.com', appId: 'imap_smtp', accountType: 'imap_smtp', capabilities: [] },
    loadCredentials: async () => ({}),
  })

  test.each([
    { charset: 'utf-8', bytes: Buffer.from('时间：2026'), text: '时间：2026' },
    { charset: 'utf-8', bytes: Buffer.from('ĀĀ Ã© café'), text: 'ĀĀ Ã© café' },
    { charset: 'iso-8859-1', bytes: Buffer.from([0x63, 0x61, 0x66, 0xe9]), text: 'café' },
    { charset: 'windows-1252', bytes: Buffer.from([0x80, 0x20, 0x93, 0x68, 0x69, 0x94]), text: '€ “hi”' },
    { charset: 'gbk', bytes: Buffer.from([0xca, 0xb1, 0xbc, 0xe4]), text: '时间' },
    { charset: undefined, bytes: Buffer.from('时间'), text: '时间' },
    { charset: 'x-unknown', bytes: Buffer.from('时间'), text: '时间' },
  ])('decodes $charset bytes after transfer decoding in single and multipart messages', ({ charset, bytes, text }) => {
    for (const encoding of ['8bit', 'base64', 'quoted-printable']) {
      const payload = encoding === 'base64'
        ? Buffer.from(bytes.toString('base64'))
        : encoding === 'quoted-printable'
          ? Buffer.from([...bytes].map((byte) => `=${byte.toString(16).padStart(2, '0')}`).join('=\r\n'))
          : bytes
      const headers = `Content-Type: text/plain${charset ? `; charset="${charset}"` : ''}\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`
      const part = Buffer.concat([Buffer.from(headers), payload])
      for (const multipart of [false, true]) {
        const source = multipart
          ? Buffer.concat([Buffer.from('Content-Type: multipart/alternative; boundary="test"\r\n\r\n--test\r\n'), part, Buffer.from('\r\n--test--\r\n')])
          : part
        const result = client.parseImapMessage({
          message: { uid: 1, source } as FetchMessageObject,
          folder: 'INBOX',
        })
        expect(result.body.trimEnd(), `${charset}/${encoding}/${multipart}`).toBe(text)
        expect(result.textBody?.trimEnd()).toBe(text)
      }
    }
  })

  test('text and html attachments do not replace the draft body', async () => {
    const source = await buildOutgoingMime({
      from: 'reader@example.com',
      to: 'peer@example.com',
      subject: 'Draft',
      text: 'Actual draft body',
      attachments: [
        { filename: 'notes.txt', mimeType: 'text/plain', content: Buffer.from('TXT ATTACHMENT') },
        { filename: 'page.html', mimeType: 'text/html', content: Buffer.from('<p>HTML ATTACHMENT</p>') },
      ],
    })
    expect(source).not.toBeInstanceOf(Error)
    const result = client.parseImapMessage({ message: { uid: 1, source } as FetchMessageObject, folder: 'Drafts' })
    expect(result.body.trimEnd()).toBe('Actual draft body')
    expect(result.mimeType).toBe('text/plain')
  })

  test('combines literal and escaped bytes before decoding UTF-8', () => {
    const source = Buffer.concat([
      Buffer.from('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>'),
      Buffer.from([0xe6]),
      Buffer.from('=97=B6=E9=97=B4</p>'),
    ])
    const result = client.parseImapMessage({ message: { uid: 1, source } as FetchMessageObject, folder: 'INBOX' })
    expect(result.body).toBe('<p>时间</p>')
    expect(result.mimeType).toBe('text/html')
  })
})

describe('tlsSocketOptions', () => {
  test('no ca or insecure means default validation', () => {
    expect(tlsSocketOptions({})).toBeUndefined()
  })

  test('ca is trusted without disabling validation', () => {
    expect(tlsSocketOptions({ ca: 'PEM' })).toEqual({ ca: ['PEM'] })
  })

  test('insecure disables certificate verification', () => {
    expect(tlsSocketOptions({ ca: 'PEM', insecure: true })).toEqual({ ca: ['PEM'], rejectUnauthorized: false })
  })
})

describe('imapTlsOptions', () => {
  test('ip hosts drop imapflow servername=false so Bun accepts the connection', () => {
    expect(imapTlsOptions({}, '127.0.0.1')).toStrictEqual({ servername: undefined })
    expect(imapTlsOptions({ ca: 'PEM' }, '127.0.0.1')).toStrictEqual({ ca: ['PEM'], servername: undefined })
    expect(imapTlsOptions({ ca: 'PEM' }, '::1')).toStrictEqual({ ca: ['PEM'], servername: undefined })
  })

  test('hostnames keep normal SNI behavior', () => {
    expect(imapTlsOptions({}, 'imap.example.com')).toBeUndefined()
    expect(imapTlsOptions({ ca: 'PEM' }, 'imap.example.com')).toEqual({ ca: ['PEM'] })
  })
})

describe('parseImapSearchQuery', () => {
  test('to: becomes IMAP TO and does not leave leftover plain text', () => {
    expect(parseImapSearchQuery('to:alice@example.com')).toEqual({
      inFolder: undefined,
      searchCriteria: { to: 'alice@example.com' },
    })
  })

  test('in:sent selects Sent and is not searched as body text', () => {
    expect(parseImapSearchQuery('in:sent to:alice@example.com')).toEqual({
      inFolder: 'sent',
      searchCriteria: { to: 'alice@example.com' },
    })
    expect(parseImapSearchQuery('in:sent')).toEqual({
      inFolder: 'sent',
      searchCriteria: { all: true },
    })
  })

  test('in:sent with subject text searches subject or body in Sent', () => {
    expect(parseImapSearchQuery('in:sent Invoice for project work')).toEqual({
      inFolder: 'sent',
      searchCriteria: {
        or: [
          { subject: 'Invoice for project work' },
          { body: 'Invoice for project work' },
        ],
      },
    })
  })

  test('plain subject text searches subject or body', () => {
    expect(parseImapSearchQuery('Invoice for project work')).toEqual({
      inFolder: undefined,
      searchCriteria: {
        or: [
          { subject: 'Invoice for project work' },
          { body: 'Invoice for project work' },
        ],
      },
    })
  })

  test('in:inbox keeps a from: filter on Inbox', () => {
    expect(parseImapSearchQuery('in:inbox from:github')).toEqual({
      inFolder: 'inbox',
      searchCriteria: { from: 'github' },
    })
  })

  test('folder starred keeps flagged even with a from: filter', () => {
    expect(parseImapSearchQuery('from:github', { isStarred: true })).toEqual({
      inFolder: undefined,
      searchCriteria: { flagged: true, from: 'github' },
    })
  })

  test('in:starred is a flag, not a mailbox', () => {
    expect(parseImapSearchQuery('in:starred from:github')).toEqual({
      inFolder: undefined,
      searchCriteria: { flagged: true, from: 'github' },
    })
  })
})

describe('imapSearchFolders', () => {
  test('mail search with no folder looks in Inbox and Sent', () => {
    expect(imapSearchFolders({
      inFolder: parseImapSearchQuery('to:alice@example.com').inFolder,
    })).toEqual(['inbox', 'sent'])
  })

  test('in:sent searches only Sent', () => {
    expect(imapSearchFolders({
      inFolder: parseImapSearchQuery('in:sent to:alice@example.com').inFolder,
    })).toEqual(['sent'])
  })

  test('in:inbox searches only Inbox', () => {
    expect(imapSearchFolders({
      inFolder: parseImapSearchQuery('in:inbox from:github').inFolder,
    })).toEqual(['inbox'])
  })

  test('mail list --folder keeps that mailbox when the query has no in:', () => {
    expect(imapSearchFolders({ folder: 'inbox' })).toEqual(['inbox'])
    expect(imapSearchFolders({ folder: 'sent' })).toEqual(['sent'])
  })

  test('mail list --folder stays on that mailbox when in: names another', () => {
    expect(imapSearchFolders({
      folder: 'inbox',
      inFolder: parseImapSearchQuery('in:sent to:alice@example.com').inFolder,
    })).toEqual([])
    expect(imapSearchFolders({
      folder: 'sent',
      inFolder: parseImapSearchQuery('in:sent to:alice@example.com').inFolder,
    })).toEqual(['sent'])
  })
})

describe('pageThreadsByDate', () => {
  test('merges by envelope date, not mailbox UID order', () => {
    const page = pageThreadsByDate({
      threads: [
        { id: 'INBOX:99', date: '2026-08-01T00:00:00.000Z' },
        { id: 'Sent:1', date: '2026-09-04T00:00:00.000Z' },
        { id: 'Sent:2', date: '2026-08-31T00:00:00.000Z' },
      ],
      startIndex: 0,
      maxResults: 2,
    })
    expect(page.threads.map((t) => t.id)).toEqual(['Sent:1', 'Sent:2'])
    expect(page.nextPageToken).toBe('2')
  })

  test('later pages do not skip older hits that were already fetched', () => {
    const threads = [
      { id: 'Sent:1', date: '2026-09-04T00:00:00.000Z' },
      { id: 'INBOX:99', date: '2026-08-01T00:00:00.000Z' },
      { id: 'Sent:2', date: '2026-08-31T00:00:00.000Z' },
    ]
    const first = pageThreadsByDate({ threads, startIndex: 0, maxResults: 2 })
    const second = pageThreadsByDate({ threads, startIndex: Number(first.nextPageToken), maxResults: 2 })
    expect(second.threads.map((t) => t.id)).toEqual(['INBOX:99'])
    expect(second.nextPageToken).toBe(null)
  })
})

describe('decodeQuotedPrintable', () => {
  test('decodes UTF-8 quoted-printable into readable text', () => {
    expect(decodeQuotedPrintable('=E6=97=B6=E9=97=B4=EF=BC=9A2026').toString('utf-8')).toBe('时间：2026')
  })

  test('handles soft line breaks', () => {
    expect(decodeQuotedPrintable('hello=\r\nworld').toString()).toBe('helloworld')
  })

  test('keeps ASCII untouched', () => {
    expect(decodeQuotedPrintable('plain ascii =3D stays').toString()).toBe('plain ascii = stays')
  })

  test('lowercase hex escapes decode the same', () => {
    expect(decodeQuotedPrintable('=e6=97=b6=e9=97=b4').toString('utf-8')).toBe('时间')
  })

  test('preserves non-UTF-8 bytes for charset decoding', () => {
    expect(decodeQuotedPrintable('caf=E9')).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9]))
  })

  test('preserves malformed escapes', () => {
    expect(decodeQuotedPrintable('a=ZZ b=2 c=').toString()).toBe('a=ZZ b=2 c=')
  })
})
