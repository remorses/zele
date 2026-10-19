// Mail watch command: poll for new emails using Gmail History API.
// Exits as soon as the first matching email arrives (exit 0), or when the
// optional --timeout expires with no match (exit 1). Agents use this to
// wait for a reply, then read the match to validate it.
// Only emails that arrive after the command starts can match.
//
// Multi-account: watches all accounts concurrently, first match from any
// account triggers exit.
//
// Concurrency design: Promise.race over per-account generator consumers
// and an optional timeout promise. When any task resolves first the abort
// signal fires, which makes watchInbox's abortableSleep resolve immediately
// so generators exit their while loop cleanly. We then call gen.return()
// on every generator to ensure cleanup.

import type { ZeleCli } from '../cli-types.js'
import { z } from 'zod'
import { getClients } from '../auth.js'
import type { WatchEvent } from '../gmail-client.js'
import { AuthError, abortableSleep } from '../api-utils.js'
import * as out from '../output.js'

export const REPLY_FOLLOW_UP_HINT = 'Check existing replies first: watch only sees new mail. Run watch in a background shell that notifies you on exit, then mail read the match before telling the user.'

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------

export function registerWatchCommands(cli: ZeleCli) {
  cli
    .command(
      'mail watch',
      'Wait for the first new email matching the filter, print it and exit 0. Exit 1 on timeout or error. ' +
        'After sending or when the user mentions a sent email, search existing replies first: watch only sees mail that arrives after it starts. ' +
        'Agents: run it in a background shell that notifies you on exit. A match is a candidate: mail read its thread and check the message ID is new before telling the user. If it returns an old message again, monitoring is broken. ' +
        'Example: zele mail watch --account me@example.com --filter "from:bob@example.com" --timeout 259200',
    )
    .option('--interval [interval]', z.string().describe('Poll interval in seconds (default: 15)'))
    .option('--folder [folder]', z.string().describe('Folder to watch (default: inbox)'))
    .option('--filter [filter]', z.string().describe('Filter messages (from:, to:, cc:, subject:, is:unread, is:starred, has:attachment, -negate). See https://support.google.com/mail/answer/7190'))
    .option('--timeout [timeout]', z.string().describe('Max seconds to wait before exiting with code 1 (default: no timeout). Waiting days is fine, e.g. 259200 = 3 days'))
    .action(async (options) => {
      const interval = options.interval ? Number(options.interval) : 15
      if (isNaN(interval) || interval < 1) {
        out.error('--interval must be a positive number of seconds')
        process.exit(1)
      }

      const timeout = options.timeout ? Number(options.timeout) : undefined
      if (timeout !== undefined && (isNaN(timeout) || timeout < 1)) {
        out.error('--timeout must be a positive number of seconds')
        process.exit(1)
      }
      // setTimeout fires immediately above 2^31-1 ms (~24.8 days).
      if (timeout !== undefined && timeout * 1000 > 2_147_483_647) {
        out.error('--timeout must be at most 2147483 seconds (~24 days)')
        process.exit(1)
      }

      const folder = options.folder ?? 'inbox'
      const clients = await getClients(options.account)

      // Clean exit on SIGINT
      process.on('SIGINT', () => {
        out.hint('Stopped watching')
        process.exit(0)
      })

      const timeoutStr = timeout ? `, timeout ${timeout}s` : ''
      out.hint(`Watching ${folder} every ${interval}s${timeoutStr} (Ctrl+C to stop)`)

      const startedAt = Date.now()
      const elapsed = () => formatElapsed(Date.now() - startedAt)
      // Heartbeat so a caller reading partial output knows how long it waited.
      const heartbeat = setInterval(() => out.hint(`Still watching, ${elapsed()} elapsed`), 60_000)
      heartbeat.unref()

      const abort = new AbortController()

      const generators = clients.map(({ client }) =>
        client.watchInbox({
          folder,
          intervalMs: interval * 1000,
          query: options.filter,
          signal: abort.signal,
        }),
      )

      // Each watcher consumes its generator until the first event, then
      // returns it. If the generator ends without yielding (shouldn't happen
      // normally since watchInbox loops forever until aborted), returns null.
      const watchTasks = generators.map(async (gen) => {
        try {
          for await (const event of gen) {
            return { type: 'match' as const, event }
          }
          return { type: 'closed' as const }
        } catch (error) {
          return { type: 'error' as const, error }
        }
      })

      // Timeout task: resolves after the deadline, or never if no timeout set
      const timeoutTask = timeout
        ? abortableSleep(timeout * 1000, abort.signal).then(() => ({ type: 'timeout' as const }))
        : new Promise<never>(() => {}) // never resolves

      const result = await Promise.race([...watchTasks, timeoutTask])

      // Stop all generators regardless of which task won
      abort.abort()
      clearInterval(heartbeat)
      await Promise.allSettled(generators.map((gen) => gen.return(undefined!)))

      switch (result.type) {
        case 'match':
          out.printList([{ ...formatWatchEvent(result.event), elapsed: elapsed() }])
          break
        case 'timeout':
          out.error(`Timed out after ${elapsed()} waiting for a matching email`)
          process.exit(1)
          break
        case 'error': {
          const err = result.error
          if (err instanceof AuthError) {
            out.error(`${err.message}. Try: zele login`)
          } else {
            out.error(`Watch failed after ${elapsed()}: ${err instanceof Error ? err.message : String(err)}`)
          }
          process.exit(1)
          break
        }
        case 'closed':
          out.error(`Watch ended after ${elapsed()} without matching any email`)
          process.exit(1)
          break
      }
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatWatchEvent(event: WatchEvent) {
  return {
    account: event.account.email,
    type: event.type,
    from: out.formatSender(event.message.from),
    subject: event.message.subject,
    date: out.formatDate(event.message.date),
    thread_id: event.threadId,
    message_id: event.message.id,
    flags: out.formatFlags(event.message),
  }
}

/** 754000 -> "12m 34s", 3_725_000 -> "1h 2m 5s", 90_000_000 -> "1d 1h 0m 0s". */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (d > 0) return `${d}d ${h}h ${m}m ${sec}s`
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

/** Command an agent should run after sending, to wait for the answer. */
export function replyWatchCommand({
  account,
  to,
  subject,
}: {
  account: string
  to: string[]
  subject?: string
}): string {
  // The filter has no OR, so a from: term only works for a single recipient.
  const terms = to.length === 1 ? [`from:${to[0]}`] : []
  // Replies keep the subject ("Re: X" contains "X"). Skip it if quoting would break.
  const cleanSubject = subject?.replace(/^\s*(re|fwd?):\s*/i, '').trim()
  if (cleanSubject && !/["']/.test(cleanSubject)) terms.push(`subject:"${cleanSubject}"`)
  const filter = terms.length > 0 ? ` --filter '${terms.join(' ')}'` : ''
  return `zele mail watch --account ${account}${filter} --timeout 259200`
}
