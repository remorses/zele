// Tests for turning Gmail web links and view tokens into API thread IDs.
// Tokens come from Arsenal Recon's write-up, gmail_compose_encoder's tests and a real
// thread; all pure, no network.

import { describe, expect, test } from 'vitest'
import {
  decodeGmailViewToken,
  encodeGmailViewToken,
  gmailDraftLink,
  gmailThreadLink,
  parseDraftIdArg,
  parseThreadIdArg,
  parseThreadIdArgs,
} from './gmail-link.js'

describe('decodeGmailViewToken', () => {
  test('thread-f tokens', () => {
    expect(
      ['FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF', 'FMfcgxvwzcMvCVqtTprDSvtNVBhnMBzq', 'FMfcgxRvprtNNfKFPzvXTwHcmpvzKwZB'].map(
        decodeGmailViewToken,
      ),
    ).toMatchInlineSnapshot(`
      [
        "thread-f:1882323577560259913",
        "thread-f:1603961193350219308",
        "thread-f:1365530521832492108",
      ]
    `)
  })

  test('thread-a token', () => {
    expect(decodeGmailViewToken('QgrcJHsTnPbZsLtzKKnZnjSgWbTsJbgWmNL')).toMatchInlineSnapshot(
      `"thread-a:r-7956246057532141946"`,
    )
  })

  test('not a token', () => {
    expect(decodeGmailViewToken('1a1f5b5220d25d49')).toBeUndefined()
    expect(decodeGmailViewToken('FMfcg')).toBeUndefined()
  })
})

describe('parseThreadIdArg', () => {
  test('current links, any label and account index', () => {
    expect(
      [
        'https://mail.google.com/mail/u/0/#inbox/FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF',
        'https://mail.google.com/mail/u/3/#all/FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF',
        'https://mail.google.com/mail/u/0/#label/Work%2FClients/FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF',
        'https://mail.google.com/mail/u/0/#search/from%3Aalice+invoice/FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF',
        'https://mail.google.com/mail/u/0/#inbox/FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF?projector=1',
        '  https://mail.google.com/mail/u/0/#sent/FMfcgxvwzcMvCVqtTprDSvtNVBhnMBzq\n',
      ].map(parseThreadIdArg),
    ).toMatchInlineSnapshot(`
      [
        "1a1f5b5220d25d49",
        "1a1f5b5220d25d49",
        "1a1f5b5220d25d49",
        "1a1f5b5220d25d49",
        "1a1f5b5220d25d49",
        "16426a350b26c62c",
      ]
    `)
  })

  test('legacy links', () => {
    expect(parseThreadIdArg('https://mail.google.com/mail/u/0/#inbox/1A1F5B5220D25D49')).toBe('1a1f5b5220d25d49')
    expect(parseThreadIdArg('https://mail.google.com/mail/#label/cafe/16426a350b26c600')).toBe('16426a350b26c600')
  })

  test('bare token', () => {
    expect(parseThreadIdArg('FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF')).toBe('1a1f5b5220d25d49')
  })

  test('IDs pass through unchanged', () => {
    expect(['1a1f5b5220d25d49', 'INBOX:12345', '[Gmail]/Sent Mail:7'].map(parseThreadIdArg)).toMatchInlineSnapshot(`
      [
        "1a1f5b5220d25d49",
        "INBOX:12345",
        "[Gmail]/Sent Mail:7",
      ]
    `)
  })

  test('thread-a tokens are rejected', () => {
    const result = parseThreadIdArg('https://mail.google.com/mail/u/0/#inbox/QgrcJHsTnPbZsLtzKKnZnjSgWbTsJbgWmNL')
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatchInlineSnapshot(
      `"Invalid thread ID: Gmail link token QgrcJHsTnPbZsLtzKKnZnjSgWbTsJbgWmNL does not contain an API thread ID. Find the thread with zele mail search and use its ID"`,
    )
  })

  test('links without a thread are rejected', () => {
    const links = [
      'https://mail.google.com/mail/u/0/#inbox',
      'https://mail.google.com/mail/u/0/#inbox?compose=new',
      'https://mail.google.com/mail/u/0/',
    ]
    for (const link of links) {
      expect(parseThreadIdArg(link)).toBeInstanceOf(Error)
    }
  })
})

describe('parseThreadIdArgs', () => {
  test('mixes links and IDs', () => {
    expect(
      parseThreadIdArgs(['https://mail.google.com/mail/u/0/#inbox/FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF', '16426a350b26c600']),
    ).toEqual(['1a1f5b5220d25d49', '16426a350b26c600'])
  })

  test('returns the first error', () => {
    expect(parseThreadIdArgs(['16426a350b26c600', 'https://mail.google.com/mail/u/0/#inbox'])).toBeInstanceOf(Error)
  })
})

describe('parseDraftIdArg', () => {
  // Vectors from https://github.com/GoodMeasuresLLC/gmail_compose_encoder
  const token = 'lLtBPXMfwdZJvWLlDhvxCqGbFRRnxnkhTqwPvxpBMCQbxPwdwWXVPRGQFfXwBlzFZRQLLvbX'

  test('compose links', () => {
    expect(
      [
        `https://mail.google.com/mail/u/0/#drafts?compose=${token}`,
        `https://mail.google.com/mail/u/1/?zx=iij9apqgzdf4#inbox?compose=${token}`,
        'https://mail.google.com/mail/u/0/#drafts?compose=CqMvqmRFntSzZfVtfBmPPsWMVrdJWrfWKgnmmQnBpjMBHZDDbfzgzMVWSNMwqsjkqbXqVSvsngB',
      ].map(parseDraftIdArg),
    ).toMatchInlineSnapshot(`
      [
        "r7186792049594056342",
        "r7186792049594056342",
        "r-2174453288762984534",
      ]
    `)
  })

  test('bare compose token', () => {
    expect(parseDraftIdArg(token)).toBe('r7186792049594056342')
  })

  test('IDs pass through unchanged', () => {
    expect(['r7186792049594056342', 'r-2174453288762984534', 'Drafts:42'].map(parseDraftIdArg)).toEqual([
      'r7186792049594056342',
      'r-2174453288762984534',
      'Drafts:42',
    ])
  })

  test('links without a draft ID are rejected', () => {
    expect(
      [
        'https://mail.google.com/mail/u/0/#drafts?compose=16426a350b26c600',
        'https://mail.google.com/mail/u/0/#inbox?compose=new',
        'https://mail.google.com/mail/u/0/#inbox/FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF',
      ].map((link) => (parseDraftIdArg(link) as Error).message),
    ).toMatchInlineSnapshot(`
      [
        "Invalid draft ID: Gmail link https://mail.google.com/mail/u/0/#drafts?compose=16426a350b26c600 names the draft's message, not the draft. Find the draft ID with zele draft list",
        "Invalid draft ID: no draft in Gmail link https://mail.google.com/mail/u/0/#inbox?compose=new. Open the draft in Gmail and copy the link again",
        "Invalid draft ID: no draft in Gmail link https://mail.google.com/mail/u/0/#inbox/FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF. Open the draft in Gmail and copy the link again",
      ]
    `)
  })
})

describe('encodeGmailViewToken', () => {
  test('round-trips thread and compose tokens', () => {
    for (const token of [
      'FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF',
      'lLtBPXMfwdZJvWLlDhvxCqGbFRRnxnkhTqwPvxpBMCQbxPwdwWXVPRGQFfXwBlzFZRQLLvbX',
      'CqMvqmRFntSzZfVtfBmPPsWMVrdJWrfWKgnmmQnBpjMBHZDDbfzgzMVWSNMwqsjkqbXqVSvsngB',
    ]) {
      expect(encodeGmailViewToken(decodeGmailViewToken(token)!)).toBe(token)
    }
  })
})

describe('Gmail links', () => {
  test('thread link', () => {
    expect(gmailThreadLink('me@example.com', '1a1f5b5220d25d49')).toMatchInlineSnapshot(`"https://mail.google.com/mail/?authuser=me%40example.com#all/1a1f5b5220d25d49"`)
  })

  test('draft link parses back to the draft ID', () => {
    const link = gmailDraftLink('me@example.com', { threadId: '1661b846250a5804', draftId: 'r7186792049594056342' })
    expect(link).toMatchInlineSnapshot(`"https://mail.google.com/mail/?authuser=me%40example.com#all?compose=lLtBPXMfwdZJvWLlDhvxCqGbFRRnxnkhTqwPvxpBMCQbxPwdwWXVPRGQFfXwBlzFZRQLLvbX"`)
    expect(parseDraftIdArg(link)).toBe('r7186792049594056342')
  })
})
