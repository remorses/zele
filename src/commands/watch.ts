// Mail watch command: poll for new emails using Gmail History API.
// Thin CLI wrapper around GmailClient.watchInbox() async generator.
// Multi-account: watches all accounts concurrently and merges output.

import type { ZeleCli } from '../cli-types.js'
import { z } from 'zod'
import { getClients } from '../auth.js'
import type { WatchEvent } from '../gmail-client.js'
import { AuthError } from '../api-utils.js'
import * as out from '../output.js'

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------

export function registerWatchCommands(cli: ZeleCli) {
  cli
    .command('mail watch', 'Watch for new emails (poll via History API)')
    .option('--interval [interval]', z.string().describe('Poll interval in seconds (default: 15)'))
    .option('--folder [folder]', z.string().describe('Folder to watch (default: inbox)'))
    .option('--filter [filter]', z.string().describe('Filter messages client-side (from:, to:, cc:, subject:, is:unread, is:starred, has:attachment, -negate). See https://support.google.com/mail/answer/7190'))
    .option('--once', z.boolean().describe('Print changes once and exit (no loop)'))
    .action(async (options) => {
      const interval = options.interval ? Number(options.interval) : 15
      if (isNaN(interval) || interval < 1) {
        out.error('--interval must be a positive number of seconds')
        process.exit(1)
      }

      const folder = options.folder ?? 'inbox'
      const clients = await getClients(options.account)

      // Clean exit on SIGINT
      process.on('SIGINT', () => {
        out.hint('Stopped watching')
        process.exit(0)
      })

      out.hint(`Polling every ${interval}s for ${folder} changes (Ctrl+C to stop)`)

      // Watch all accounts concurrently, print events as they arrive
      const generators = clients.map(({ client }) =>
        client.watchInbox({
          folder,
          intervalMs: interval * 1000,
          query: options.filter,
          once: options.once,
        }),
      )

      // Consume all generators concurrently, surface errors to the user
      const settled = await Promise.allSettled(
        generators.map(async (gen) => {
          for await (const event of gen) {
            out.printList([formatWatchEvent(event)])
          }
        }),
      )

      for (const result of settled) {
        if (result.status === 'rejected') {
          const err = result.reason
          if (err instanceof AuthError) {
            out.error(`${err.message}. Try: zele login`)
          } else {
            out.error(`Watch failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
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
