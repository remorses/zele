// Turns a link copied from Gmail's address bar into a Gmail API thread or draft ID.
// Legacy links end in the hex thread ID itself (#inbox/1a1f5b5220d25d49).
// Current links end in a view token (#inbox/FMfcgzQjgz…): the base64 of
// "thread-f:<decimal thread ID>" without its "thread-" prefix, rewritten in a
// 40-letter alphabet with no vowels. Compose links (#drafts?compose=<token>) use
// the same encoding for "thread-f:<thread>+msg-a:<draft ID>". Decoding is
// offline, no API call.
// Format documented by Arsenal Recon, who read it out of Gmail's web client:
// https://arsenalrecon.com/insights/digging-deeper-into-gmail-urls-and-introducing-gmail-url-decoder

import { ValidationError } from './api-utils.js'

const TOKEN_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz'
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const TOKEN_RE = /^[BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz]{20,}$/
const HEX_ID_RE = /^[0-9a-f]{12,16}$/i

/** Whether an ID has the shape of a Gmail API thread or message ID. */
export function isGmailId(id: string): boolean {
  return HEX_ID_RE.test(id)
}

/**
 * Decode a Gmail view token to the string Gmail's web client reads from it,
 * e.g. "FMfcgzQjgzprnprxdnvfSqhzZWCXlMJF" → "thread-f:1882323577560259913".
 * Returns undefined when the token is not valid in Gmail's alphabet.
 */
export function decodeGmailViewToken(token: string): string | undefined {
  if (!TOKEN_RE.test(token)) return undefined

  let n = 0n
  for (const ch of token) {
    n = n * 40n + BigInt(TOKEN_ALPHABET.indexOf(ch))
  }

  let base64 = ''
  while (n > 0n) {
    base64 = BASE64_ALPHABET[Number(n % 64n)] + base64
    n /= 64n
  }

  const decoded = Buffer.from(base64, 'base64').toString('utf8')
  return decoded.startsWith('thread-') ? decoded : `thread-${decoded}`
}

/**
 * Normalize a thread ID argument. Gmail web links and bare view tokens become
 * hex API thread IDs; anything else (hex IDs, IMAP "FOLDER:UID" IDs) is
 * returned unchanged.
 */
export function parseThreadIdArg(input: string): string | ValidationError {
  const value = input.trim()

  if (/^https?:\/\/mail\.google\.com\//i.test(value)) {
    const url = URL.parse(value)
    // Drop any query in the fragment, e.g. #inbox?compose=… or #search/q?…
    const fragment = url?.hash.slice(1).split('?')[0] ?? ''
    const last = fragment.split('/').pop() ?? ''

    if (HEX_ID_RE.test(last)) return last.toLowerCase()

    const threadId = threadIdFromToken(last)
    if (threadId instanceof Error) return threadId
    if (threadId) return threadId

    return new ValidationError({
      field: 'thread ID',
      reason: `no thread in Gmail link ${value}. Open the conversation in Gmail and copy the link again`,
    })
  }

  const threadId = threadIdFromToken(value)
  if (threadId instanceof Error) return threadId
  return threadId ?? value
}

/**
 * Normalize a draft ID argument. A Gmail compose link (…#drafts?compose=<token>)
 * or a bare compose token becomes the API draft ID: the token decodes to
 * "thread-f:<thread>+msg-a:<draft ID>". Anything else is returned unchanged.
 */
export function parseDraftIdArg(input: string): string | ValidationError {
  const value = input.trim()

  if (/^https?:\/\/mail\.google\.com\//i.test(value)) {
    const url = URL.parse(value)
    const fragmentQuery = url?.hash.split('?')[1] ?? ''
    const compose = new URLSearchParams(fragmentQuery).get('compose') ?? url?.searchParams.get('compose') ?? ''

    const draftId = draftIdFromToken(compose)
    if (draftId) return draftId

    // Older compose links carry the draft's hex message ID, which needs an API lookup.
    const reason = HEX_ID_RE.test(compose)
      ? `Gmail link ${value} names the draft's message, not the draft. Find the draft ID with zele draft list`
      : `no draft in Gmail link ${value}. Open the draft in Gmail and copy the link again`
    return new ValidationError({ field: 'draft ID', reason })
  }

  return draftIdFromToken(value) ?? value
}

/** Normalize several thread ID arguments, stopping at the first invalid one. */
export function parseThreadIdArgs(inputs: string[]): string[] | ValidationError {
  const ids: string[] = []
  for (const input of inputs) {
    const id = parseThreadIdArg(input)
    if (id instanceof Error) return id
    ids.push(id)
  }
  return ids
}

function draftIdFromToken(token: string): string | undefined {
  return decodeGmailViewToken(token)?.match(/\+msg-a:(r-?\d+)$/)?.[1]
}

function threadIdFromToken(token: string): string | ValidationError | undefined {
  const decoded = decodeGmailViewToken(token)
  if (!decoded) return undefined

  const match = decoded.match(/^thread-f:(\d+)/)
  if (match) return BigInt(match[1]!).toString(16)

  // thread-a tokens carry a client-side ID with no offline mapping to an API
  // thread ID. Gmail uses them for messages sent to yourself.
  if (decoded.startsWith('thread-a:')) {
    return new ValidationError({
      field: 'thread ID',
      reason: `Gmail link token ${token} does not contain an API thread ID. Find the thread with zele mail search and use its ID`,
    })
  }

  return undefined
}
