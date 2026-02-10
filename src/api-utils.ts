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

/** Simple retry for rate limit errors (429 and 403 quota errors).
 *  Matches Zero's gmail-rate-limit.ts schedule: up to 10 attempts, 60s base delay. */
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 10, delayMs = 60000): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      if (!isRateLimitError(err) || attempt === maxAttempts) throw err
      const wait = delayMs * Math.pow(2, attempt - 1)
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

/** Detect auth-like errors from underlying libraries (tsdav string errors, googleapis structured errors).
 *  Used inside clients to decide whether to return an AuthError.
 *  NOTE: String matching here is intentional — this is the boundary layer that converts
 *  untyped external library exceptions into typed AuthError values (errore "wrapping libraries" pattern). */
export function isAuthLikeError(err: unknown): boolean {
  const e = err as any
  const status = e?.code ?? e?.status ?? e?.response?.status
  if (status === 401) return true
  if (status === 403 && !isRateLimitError(e)) return true
  const msg = String(err)
  return msg.includes('Invalid credentials') || msg.includes('Unauthorized') || msg.includes('invalid_grant')
}


// ---------------------------------------------------------------------------
// Rate limit detection
// ---------------------------------------------------------------------------

export function isRateLimitError(err: any): boolean {
  const status = err?.code ?? err?.status ?? err?.response?.status
  if (status === 429) return true
  if (status === 403) {
    const errors = err?.errors ?? err?.response?.data?.error?.errors ?? []
    return errors.some((e: any) =>
      [
        'userRateLimitExceeded',
        'rateLimitExceeded',
        'quotaExceeded',
        'dailyLimitExceeded',
        'limitExceeded',
        'backendError',
      ].includes(e.reason),
    )
  }
  return false
}
