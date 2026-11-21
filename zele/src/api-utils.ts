// Shared API utilities for Gmail and Calendar clients.
// Retry logic for rate limit errors and bounded concurrency helper.
// Extracted from gmail-client.ts to be reused across API clients.
//
// Auth error handling follows the errore pattern (errors as values):
// - Clients return AuthError instead of throwing for auth failures
// - Callers narrow with instanceof, no try/catch or string matching needed
// - See https://errore.org/ for the philosophy

import * as errore from 'errore'

const MAX_CONCURRENCY = 10

/** Exclude Error subtypes from a union. Used by mapConcurrent to strip
 *  error return types from the success array — errors are returned separately. */
type ExcludeError<T> = T extends Error ? never : T

/** Extract Error subtypes from a union. Used by mapConcurrent for the error branch. */
type ExtractError<T> = T extends Error ? T : never

type Falsy = false | 0 | '' | null | undefined

/** Generic truthy type guard for Array.filter() chains.
 *  Useful to drop null/undefined placeholders while preserving inferred item types. */
export function isTruthy<T>(value: T): value is Exclude<T, Falsy> {
  return Boolean(value)
}

/** Run promises with bounded concurrency.
 *  Error-aware: if any callback returns an Error instance, remaining work is
 *  aborted and that error is returned as a value (no throwing needed).
 *  Callbacks should return Error for fatal failures (auth) and null for skip.
 *  The success array is typed without Error — errors are only in the Error branch. */
export async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = MAX_CONCURRENCY,
): Promise<ExcludeError<R>[] | ExtractError<R>> {
  const results: ExcludeError<R>[] = []
  let index = 0
  let fatalError: Error | null = null

  async function worker() {
    while (index < items.length && !fatalError) {
      const i = index++
      const result = await fn(items[i]!)
      if (result instanceof Error) {
        fatalError = result
        return
      }
      results[i] = result as ExcludeError<R>
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  if (fatalError) return fatalError as ExtractError<R>
  return results
}

const RETRY_MAX_ATTEMPTS = 5
const RETRY_BASE_DELAY_MS = 2000

/** Retry rate limit errors with exponential backoff (2s, 4s, 8s, 16s; 30s worst case).
 *  Idempotent calls also retry Gmail `backendError`. Non-idempotent calls (sends)
 *  must pass `idempotent: false`: a backend error may come after the mail was
 *  already sent, so only rate limits, which reject the request up front, are retried. */
export async function withRetry<T>(fn: () => Promise<T>, { idempotent = true }: { idempotent?: boolean } = {}): Promise<T> {
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const retryable = isRateLimitError(err) || (idempotent && isBackendError(err))
      if (!retryable || attempt === RETRY_MAX_ATTEMPTS) throw err
      const wait = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw new Error('unreachable')
}

// ---------------------------------------------------------------------------
// Auth errors (errore pattern: errors as values, not exceptions)
// ---------------------------------------------------------------------------

/** Returned by client methods when authentication fails (expired token, revoked access, etc.).
 *  Callers check with `instanceof AuthError` and TypeScript narrows the type. */
export class AuthError extends errore.createTaggedError({
  name: 'AuthError',
  message: 'Authentication failed for $email: $reason',
}) {}

/** Returned before a Gmail call when the stored token does not grant a scope the call needs. */
export class MissingScopeError extends errore.createTaggedError({
  name: 'MissingScopeError',
  message: '$email has not granted the $scope scope. $hint',
}) {}

export class ZeleShSignedOutError extends errore.createTaggedError({
  name: 'ZeleShSignedOutError',
  message: 'Not signed in to $apiUrl. Run: zele login zele',
}) {}

/** Returned when a requested resource doesn't exist (calendar, event, thread, draft, label). */
export class NotFoundError extends errore.createTaggedError({
  name: 'NotFoundError',
  message: '$resource not found',
}) {}

/** Returned when a thread has no messages (empty thread). */
export class EmptyThreadError extends errore.createTaggedError({
  name: 'EmptyThreadError',
  message: 'No messages in thread $threadId',
}) {}

/** Returned when data cannot be parsed (iCal, event response, raw email). */
export class ParseError extends errore.createTaggedError({
  name: 'ParseError',
  message: 'Failed to parse $what: $reason',
}) {}

/** Returned when required data is missing from an API response or cached object. */
export class MissingDataError extends errore.createTaggedError({
  name: 'MissingDataError',
  message: 'Missing $what for $resource',
}) {}

/** Returned when user input fails validation (reminder format, time expressions, etc.). */
export class ValidationError extends errore.createTaggedError({
  name: 'ValidationError',
  message: 'Invalid $field: $reason',
}) {}

/** Returned when a non-auth, non-ratelimit API call fails. */
export class ApiError extends errore.createTaggedError({
  name: 'ApiError',
  message: 'API call failed: $reason',
}) {}

/** Returned when a SQLite/Drizzle call fails. */
export class DbError extends errore.createTaggedError({
  name: 'DbError',
  message: 'Database error: $reason',
}) {}

/** Returned when a command requires a capability (e.g. gmail labels) that the account doesn't support. */
export class UnsupportedError extends errore.createTaggedError({
  name: 'UnsupportedError',
  message: '$feature is not available for $accountType accounts. $hint',
}) {}

/** Returned when a reply would be delivered only to the sending account itself.
 *  This almost always means the recipient was inferred from a message *I* sent
 *  (see resolveReplyRecipients in email-utils.ts). Callers should pass an
 *  explicit recipient (`--to`) or opt in deliberately (`--allow-self`). */
export class SelfRecipientError extends errore.createTaggedError({
  name: 'SelfRecipientError',
  message: 'Refusing to reply: resolved recipient $recipient is the sending account $account. Pass --to <email> to override, or --allow-self to send anyway.',
}) {}

/** Returned when no counterparty can be inferred from a thread (every message
 *  was sent by the account itself and no message names an external recipient). */
export class AmbiguousRecipientError extends errore.createTaggedError({
  name: 'AmbiguousRecipientError',
  message: 'Cannot infer a reply recipient for thread $threadId: no replyable external recipient was found. Pass --to <email>.',
}) {}

/** Returned when mail reply/send-in-thread runs against a thread whose latest
 *  non-draft message was not shown by `mail read`. Prevents agents from
 *  answering a stale view after a new reply arrives. */
export class UnseenLatestError extends errore.createTaggedError({
  name: 'UnseenLatestError',
  message: 'Cannot reply to thread $threadId: latest message $lastMessageId was not read. Run: zele mail read $threadId',
}) {}

/** Returned when a thread has no List-Unsubscribe header (RFC 2369) so no
 *  standardized unsubscribe mechanism is available. */
export class UnsubscribeUnavailableError extends errore.createTaggedError({
  name: 'UnsubscribeUnavailableError',
  message: 'No List-Unsubscribe header on thread $threadId',
}) {}

/** Returned when the unsubscribe attempt itself failed (HTTP error, SMTP
 *  send failure, redirect returned when RFC 8058 forbids it, etc.). */
export class UnsubscribeFailedError extends errore.createTaggedError({
  name: 'UnsubscribeFailedError',
  message: 'Unsubscribe via $mechanism failed: $reason',
}) {}

/** Detect auth-like errors from underlying libraries (tsdav string errors, googleapis structured errors).
 *  Used inside clients to decide whether to return an AuthError.
 *  NOTE: String matching here is intentional — this is the boundary layer that converts
 *  untyped external library exceptions into typed AuthError values (errore "wrapping libraries" pattern). */
export function isAuthLikeError(err: unknown): boolean {
  const e = err as any
  const status = e?.code ?? e?.status ?? e?.response?.status
  if (status === 401) return true
  if (status === 403 && !isRateLimitError(e) && !isBackendError(e)) return true
  const msg = String(err)
  return msg.includes('Invalid credentials') || msg.includes('Unauthorized') || msg.includes('invalid_grant')
}


// ---------------------------------------------------------------------------
// Rate limit detection
// ---------------------------------------------------------------------------

const RATE_LIMIT_REASONS = [
  'userRateLimitExceeded',
  'rateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
  'limitExceeded',
]

function googleErrorReasons(err: any): string[] {
  const errors = err?.errors ?? err?.response?.data?.error?.errors ?? []
  return errors.map((e: any) => e?.reason)
}

/** 429 or 403 quota errors. Google rejects these before doing any work, so retrying is safe even for sends. */
export function isRateLimitError(err: any): boolean {
  const status = err?.code ?? err?.status ?? err?.response?.status
  if (status === 429) return true
  if (status === 403) return googleErrorReasons(err).some((r) => RATE_LIMIT_REASONS.includes(r))
  return false
}

/** Google server error. The request may have been applied, so only idempotent calls should retry it. */
export function isBackendError(err: any): boolean {
  return googleErrorReasons(err).includes('backendError')
}

/** Sleep that resolves immediately when an AbortSignal fires.
 *  Used by watchInbox to make the poll interval interruptible. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
