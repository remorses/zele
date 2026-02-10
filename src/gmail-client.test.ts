// Tests for GmailClient parsing behavior used by TUI previews.
// Captures entity/encoding regressions in snippet fields from Gmail metadata responses.

import { expect, test } from 'vitest'
import { GmailClient } from './gmail-client.js'

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

  const parsed = GmailClient.parseRawThreadListItem(rawThread as any)
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

  const parsed = GmailClient.parseRawMessage(rawMessage as any)
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

  const parsed = GmailClient.parseRawThreadListItem(rawThread as any)
  expect(parsed.snippet).toBe('A host sent you a message')
})
