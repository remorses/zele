## development

to run the cli locally use `tsx src/cli.ts`

## goke typing

do not add manual type annotations to `.action(async ...)` parameters in goke commands; rely on goke option inference.

## type guards

prefer shared generic guards over inline complex filter predicates. use `isTruthy` from `src/api-utils.ts` in `Array.filter()` chains when removing nullable placeholders to keep code readable and type narrowing predictable.

## mail tui 

the mail-tui.tsx file uses termcast. which is a raycast extension API re implementation for the terminal. it implements basically all raycast APIs but renders as a TUI. termcast command is run globally. running termcast dev will show the tui and refresh it on file changes. global termcast is linked to the kimaki termcast project. you can apply fixes there finding it with kimaki project list if needed.

to try out and test the tui you must use tuistory. it is a cli to launch, control and see long running tui processes like ours. it also has a js api like playwright to test tui applications.

you must do tuistory --help to see how to use it. this is the only way to try out the mail-tui file. after changes made to that file always try out changes using tuistory cli. or adding test that use the tuistory js api. to read tuistory js api opensrc it and read the readme file.

## database

zele uses a single SQLite database at `~/.zele/zele.db` as the source of truth for CLI state.

all persistent state is stored in this DB via Prisma models:
- `accounts`: OAuth tokens per email account
- `thread_lists` + `threads`: cached mail list/read payloads
- `labels` + `label_counts`: cached label metadata and unread counters
- `profiles`: cached account profile data
- `sync_states`: misc per-account sync metadata (for example history IDs)

## changelog

keep `CHANGELOG.md` updated when making user-facing changes. bump the version in `package.json` and `src/cli.ts` together.

## migrations

`src/db.ts` runs `src/schema.sql` on startup (idempotent migration) so new tables/indexes are applied automatically on each CLI process start.

## error handling

this project follows the [errore](https://errore.org/) pattern: errors as values, not exceptions.

read the errore best practices and skill before writing any error handling code:
- https://errore.org/
- https://github.com/remorses/errore

### rules

- **never use try/catch**. use `errore.tryAsync()` or `errore.tryFn()` to wrap external library calls that throw. these return `Error | T` unions instead of throwing.
- **use `errore.tryAsync({ try, catch })`** at the boundary layer (googleapis, tsdav) to convert throws into typed error values. see the `gmailBoundary()` and `caldavBoundary()` helpers in the client files.
- **use `errore.tryFn()`** for synchronous boundary calls (e.g. JSON.parse, iCal parsing).
- **return errors as values** from client methods. use `return new AuthError(...)` not `throw new AuthError(...)`.
- **check with instanceof** at the call site: `if (result instanceof Error) handleCommandError(result)`.
- **use `instanceof Error`** (base class) when you want to catch any domain error. use `instanceof AuthError` etc. when you need specific handling.
- **use `errore.unwrap()`** at entry points where failure is fatal (login, migration).
- **define tagged error classes** in `src/api-utils.ts` using `errore.createTaggedError()` with `$variable` interpolation.
- **use `handleCommandError()`** from `src/output.ts` in command files instead of manual `out.error()` + `process.exit(1)`.
- **never string-match error messages**. use instanceof narrowing instead. the only exception is `isAuthLikeError()` which translates external library exceptions at the boundary.

### errore.try is only for external code

`errore.tryAsync` and `errore.tryFn` must only wrap **external library calls** that throw (googleapis, tsdav, ts-ics). never wrap our own functions or methods with `errore.try`. instead, push the boundary as deep as possible — the method that calls the external library should use `gmailBoundary()`/`caldavBoundary()` internally and return errors as values. callers then check with `instanceof Error`, no wrapping needed.

```typescript
// bad: wrapping our own method with errore.tryAsync
const result = await errore.tryAsync(() => this.listHistory(...))
if (result instanceof Error) ...

// good: listHistory uses gmailBoundary internally, returns errors as values
const result = await this.listHistory(...)
if (result instanceof Error) ...
```

if you find yourself wrapping an internal method with `errore.try`, that method should be converted to return errors as values instead. the boundary belongs inside the method, not at the call site.

### boundary pattern

wrap external library calls with `errore.tryAsync` via the boundary helpers:

```typescript
// gmail-client.ts uses gmailBoundary(), calendar-client.ts uses caldavBoundary()
// both convert auth errors to AuthError and others to ApiError

const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
  withRetry(() => this.gmail.users.threads.list({ userId: 'me', ... })),
)
if (res instanceof AuthError) return res
if (res instanceof Error) return res
```

for "skip on failure" patterns inside mapConcurrent:

```typescript
const detail = await gmailBoundary(email, () => withRetry(() => api.get(...)))
if (detail instanceof AuthError) return detail // mapConcurrent short-circuits
if (detail instanceof Error) return null       // skip this item
```

### error-aware concurrency

`mapConcurrent` is error-aware: if any callback returns an `Error`, it stops spawning new work and returns that error as a value. callbacks should return typed errors for fatal failures and `null` for skip:

```typescript
const results = await mapConcurrent(items, async (item) => {
  const res = await boundary(email, () => fetchItem(item))
  if (res instanceof AuthError) return res  // aborts batch, returned to caller
  if (res instanceof Error) return null     // skip this item
  return res
})
if (results instanceof Error) return results
// results is typed without Error — only success values and nulls
```

the return type uses `ExcludeError<R>[] | ExtractError<R>` so the success branch has no error types in it.

### preserve error cause

when wrapping external errors in typed error values, always pass `cause` so the original error (stack trace, status code, response body) survives for debugging:

```typescript
new ApiError({ reason: String(err), cause: err })
```

never flatten errors to strings only — `String(err)` loses structured data that's critical for debugging production issues.

### throws are acceptable in two places

1. **async generators** — generators can't return error values to `for await` consumers. throws are the only propagation mechanism.
2. **`withRetry`** — the retry loop is the one place where try/catch is the fundamental mechanism (it catches rate limit errors from external SDKs to retry them).

everywhere else, return errors as values.

### code style: go-like flat structure

write error handling in a flat, go-like, non-nested style. check errors early and return/exit immediately. avoid deep nesting.

```typescript
// good: flat, early return
const result = await client.getEvent({ calendarId, eventId })
if (result instanceof Error) handleCommandError(result)
// continue with result...

// bad: nested
try {
  const result = await client.getEvent({ calendarId, eventId })
  if (result) {
    // deeply nested logic...
  }
} catch (err) {
  // error handling far from the call site
}
```
