// Mail watch command: poll for new emails using Gmail History API.
// Uses incremental historyId-based sync — each tick fetches only changes
// since the last known historyId, not the full inbox. On a quiet inbox
// this is a single API call returning nothing.
// Multi-account: watches all accounts concurrently and merges output.

import type { Goke } from 'goke'
import { z } from 'zod'
import { getClients } from '../auth.js'
import { GmailClient } from '../gmail-client.js'
import * as cache from '../gmail-cache.js'
import * as out from '../output.js'

// ---------------------------------------------------------------------------
// Folder label mapping (reuses mail list conventions)
// ---------------------------------------------------------------------------

const FOLDER_LABELS: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'SENT',
  trash: 'TRASH',
  spam: 'SPAM',
  starred: 'STARRED',
  drafts: 'DRAFT',
}

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------

export function registerWatchCommands(cli: Goke) {
  cli
    .command('mail watch', 'Watch for new emails (poll via History API)')
    .option('--interval [interval]', z.string().describe('Poll interval in seconds (default: 15)'))
    .option('--folder [folder]', z.string().describe('Folder to watch (default: inbox)'))
    .option('--query [query]', z.string().describe('Gmail search filter for displayed messages'))
    .option('--once', z.boolean().describe('Print changes once and exit (no loop)'))
    .action(async (options) => {
      const interval = options.interval ? Number(options.interval) : 15
      if (isNaN(interval) || interval < 1) {
        out.error('--interval must be a positive number of seconds')
        process.exit(1)
      }

      const folder = options.folder ?? 'inbox'
      const filterLabelId = FOLDER_LABELS[folder]
      const clients = await getClients(options.account)

      // Seed historyId for each account
      const states = await Promise.all(
        clients.map(async ({ email, client }) => {
          let historyId = await cache.getLastHistoryId(email)

          if (!historyId) {
            const profile = await client.getProfile()
            historyId = profile.historyId
            await cache.setLastHistoryId(email, historyId)
            out.hint(`${email}: watching from now (historyId ${historyId})`)
          } else {
            out.hint(`${email}: resuming from historyId ${historyId}`)
          }

          return { email, client, historyId }
        }),
      )

      // Clean exit on SIGINT
      let running = true
      process.on('SIGINT', () => {
        running = false
        out.hint('Stopped watching')
        process.exit(0)
      })

      out.hint(`Polling every ${interval}s for ${folder} changes (Ctrl+C to stop)`)

      // Poll loop
      while (running) {
        const allItems: Array<Record<string, unknown>> = []

        for (const state of states) {
          try {
            const items = await pollAccount(state, filterLabelId, options.query)
            allItems.push(...items)
          } catch (err: any) {
            // historyId expired — Google only keeps ~7 days
            if (isHistoryExpired(err)) {
              out.hint(`${state.email}: history expired, re-seeding...`)
              const profile = await state.client.getProfile()
              state.historyId = profile.historyId
              await cache.setLastHistoryId(state.email, state.historyId)
            } else {
              out.error(`${state.email}: ${err.message ?? err}`)
            }
          }
        }

        if (allItems.length > 0) {
          out.printList(allItems)
        }

        if (options.once) break

        await sleep(interval * 1000)
      }
    })
}

// ---------------------------------------------------------------------------
// Poll a single account for changes
// ---------------------------------------------------------------------------

async function pollAccount(
  state: { email: string; client: GmailClient; historyId: string },
  filterLabelId: string | undefined,
  query: string | undefined,
): Promise<Array<Record<string, unknown>>> {
  const { history, historyId: newHistoryId } = await state.client.listHistory({
    startHistoryId: state.historyId,
    labelId: filterLabelId,
    historyTypes: ['messageAdded'],
  })

  // Update stored historyId even if no changes
  if (newHistoryId !== state.historyId) {
    state.historyId = newHistoryId
    await cache.setLastHistoryId(state.email, newHistoryId)
  }

  if (history.length === 0) return []

  // Collect unique message IDs from messageAdded events
  const seenIds = new Set<string>()
  const messageIds: string[] = []

  for (const entry of history) {
    for (const added of entry.messagesAdded ?? []) {
      const id = added.message?.id
      if (id && !seenIds.has(id)) {
        // If filtering by folder label, check the message has that label
        const labels = added.message?.labelIds ?? []
        if (filterLabelId && !labels.includes(filterLabelId)) continue

        seenIds.add(id)
        messageIds.push(id)
      }
    }
  }

  if (messageIds.length === 0) return []

  // Hydrate messages with metadata
  const items: Array<Record<string, unknown>> = []

  for (const msgId of messageIds) {
    try {
      const msg = await state.client.getMessage({ messageId: msgId, format: 'metadata' })
      if ('raw' in msg) continue // skip raw format responses

      // If user specified a query, do a client-side check on subject/from
      // (the history API doesn't support query filtering natively)
      if (query && !matchesQuery(msg, query)) continue

      items.push({
        account: state.email,
        type: 'new_message',
        from: out.formatSender(msg.from),
        subject: msg.subject,
        date: out.formatDate(msg.date),
        thread_id: msg.threadId,
        message_id: msg.id,
        flags: out.formatFlags(msg),
      })
    } catch {
      // Message may have been deleted between history fetch and hydration
    }
  }

  return items
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isHistoryExpired(err: any): boolean {
  const status = err?.code ?? err?.status ?? err?.response?.status
  if (status === 404) return true
  // Google sometimes returns 400 with "Invalid historyId"
  if (status === 400) {
    const message = err?.message ?? err?.response?.data?.error?.message ?? ''
    if (message.includes('historyId')) return true
  }
  return false
}

function matchesQuery(msg: { subject: string; from: { name?: string; email: string } }, query: string): boolean {
  const q = query.toLowerCase()
  const subject = msg.subject.toLowerCase()
  const from = `${msg.from.name ?? ''} ${msg.from.email}`.toLowerCase()
  return subject.includes(q) || from.includes(q)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
