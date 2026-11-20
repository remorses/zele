// Tests for turning Gmail web links and view tokens into API thread IDs.
// Tokens come from Arsenal Recon's write-up and a real thread; all pure, no network.

import { describe, expect, test } from 'vitest'
import { decodeGmailViewToken, parseThreadIdArg, parseThreadIdArgs } from './gmail-link.js'

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
