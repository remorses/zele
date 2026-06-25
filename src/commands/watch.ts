// Mail watch command: poll for new emails using Gmail History API.
// Exits as soon as the first matching email arrives (exit 0), or when the
// optional --timeout expires with no match (exit 1). Agents use this to
// block until a specific email appears, e.g. waiting for a reply after
// sending an email. If the matched email wasn't the expected one, the agent
// can simply call watch again with a more specific filter.
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

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------

export function registerWatchCommands(cli: ZeleCli) {
  cli
    .command('mail watch', 'Wait for a new email matching the filter, print it and exit')
    .option('--interval [interval]', z.string().describe('Poll interval in seconds (default: 15)'))
    .option('--folder [folder]', z.string().describe('Folder to watch (default: inbox)'))
    .option('--filter [filter]', z.string().describe('Filter messages (from:, to:, cc:, subject:, is:unread, is:starred, has:attachment, -negate). See https://support.google.com/mail/answer/7190'))
    .option('--timeout [timeout]', z.string().describe('Max seconds to wait before exiting with code 1 (default: no timeout)'))
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

      const folder = options.folder ?? 'inbox'
      const clients = await getClients(options.account)

      // Clean exit on SIGINT
      process.on('SIGINT', () => {
        out.hint('Stopped watching')
        process.exit(0)
      })

      const timeoutStr = timeout ? `, timeout ${timeout}s` : ''
      out.hint(`Watching ${folder} every ${interval}s${timeoutStr} (Ctrl+C to stop)`)

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
      await Promise.allSettled(generators.map((gen) => gen.return(undefined!)))

      switch (result.type) {
        case 'match':
          out.printList([formatWatchEvent(result.event)])
          break
        case 'timeout':
          out.error('Timed out waiting for a matching email')
          process.exit(1)
          break
        case 'error': {
          const err = result.error
          if (err instanceof AuthError) {
            out.error(`${err.message}. Try: zele login`)
          } else {
            out.error(`Watch failed: ${err instanceof Error ? err.message : String(err)}`)
          }
          process.exit(1)
          break
        }
        case 'closed':
          out.error('Watch ended without matching any email')
          process.exit(1)
          break
      }
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatWatchEvent(event: WatchEvent): Record<string, unknown> {
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
