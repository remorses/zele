// Draft commands: list, create, get, send, delete.
// Manages Gmail drafts with YAML output for list views.
// Cache invalidation is handled by the client (sendDraft invalidates threadLists).
// Multi-account: list fetches all accounts concurrently and merges by date.

import type { Goke } from 'goke'
import { z } from 'zod'
import fs from 'node:fs'
import { getClients, getClient } from '../auth.js'
import type { GmailClient } from '../gmail-client.js'
import { AuthError } from '../api-utils.js'
import * as out from '../output.js'
import { handleCommandError } from '../output.js'
import pc from 'picocolors'

export function registerDraftCommands(cli: Goke) {
  // =========================================================================
  // draft list
  // =========================================================================

  cli
    .command('draft list', 'List drafts')
    .option('--max <max>', z.number().default(20).describe('Max results'))
    .option('--page <page>', z.string().describe('Pagination token (requires --account, only works for a single account)'))
    .option('--query <query>', z.string().describe('Search query'))
    .action(async (options) => {
      const clients = await getClients(options.account)

      if (options.page && clients.length > 1) {
        out.error('--page cannot be used with multiple accounts (page tokens are per-account)')
        process.exit(1)
      }

      // Fetch from all accounts concurrently
      const results = await Promise.all(
        clients.map(async ({ email, client }) => {
          const result = await client.listDrafts({
            query: options.query,
            maxResults: options.max,
            pageToken: options.page,
          })
          if (result instanceof Error) return result
          return { email, result }
        }),
      )

      const allResults = results.filter((r): r is Exclude<typeof r, Error> => {
          if (r instanceof AuthError) { out.error(`${r.message}. Try: zele login`); return false }
          if (r instanceof Error) { out.error(`Failed to fetch drafts: ${r.message}`); return false }
          return true
        })

      // Merge drafts from all accounts, sorted by date descending, capped at max
      const merged = allResults
        .flatMap(({ email, result }) =>
          result.drafts.map((d) => ({ ...d, account: email })),
        )
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, options.max)

      if (merged.length === 0) {
        out.printList([], { summary: 'No drafts found' })
        return
      }

      const showAccount = clients.length > 1
      out.printList(
        merged.map((d) => ({
          ...(showAccount ? { account: d.account } : {}),
          draft_id: d.id,
          to: d.to.join(', ') || '(no recipient)',
          subject: d.subject,
          date: out.formatDate(d.date),
        })),
        { summary: `${merged.length} draft(s)`, nextPage: allResults[0]?.result.nextPageToken },
      )
    })

  // =========================================================================
  // draft get
  // =========================================================================

  cli
    .command('draft get <draftId>', 'Show draft details')
    .action(async (draftId, options) => {
      const { client } = await getClient(options.account)

      const draft = await client.getDraft({ draftId })
      if (draft instanceof Error) handleCommandError(draft)

      console.log(pc.bold(`Draft: ${draft.message.subject}`))
      console.log(pc.dim(`Draft ID: ${draft.id}`))
      console.log(`To: ${draft.to.join(', ') || '(none)'}`)
      if (draft.cc.length > 0) {
        console.log(`Cc: ${draft.cc.join(', ')}`)
      }
      if (draft.bcc.length > 0) {
        console.log(`Bcc: ${draft.bcc.join(', ')}`)
      }
      console.log()

      const body = out.renderEmailBody(draft.message.body, draft.message.mimeType)
      console.log(body)
    })

  // =========================================================================
  // draft create
  // =========================================================================

  cli
    .command('draft create', 'Create a new draft')
    .option('--to <to>', z.string().describe('Recipient email(s), comma-separated'))
    .option('--subject <subject>', z.string().describe('Email subject'))
    .option('--body <body>', z.string().describe('Draft body text'))
    .option('--body-file <bodyFile>', z.string().describe('Read body from file (use - for stdin)'))
    .option('--cc <cc>', z.string().describe('CC recipients (comma-separated)'))
    .option('--bcc <bcc>', z.string().describe('BCC recipients (comma-separated)'))
    .option('--thread <thread>', z.string().describe('Thread ID to associate with'))
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .action(async (options) => {
      if (!options.to) {
        out.error('--to is required')
        process.exit(1)
      }
      if (!options.subject) {
        out.error('--subject is required')
        process.exit(1)
      }

      let body = options.body ?? ''
      if (options.bodyFile) {
        if (options.bodyFile === '-') {
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) {
            chunks.push(chunk)
          }
          body = Buffer.concat(chunks).toString('utf-8')
        } else {
          body = fs.readFileSync(options.bodyFile, 'utf-8')
        }
      }

      const parseEmails = (str: string) =>
        str.split(',').map((e) => e.trim()).filter(Boolean).map((email) => ({ email }))

      const { client } = await getClient(options.account)

      const result = await client.createDraft({
        to: parseEmails(options.to),
        subject: options.subject,
        body,
        cc: options.cc ? parseEmails(options.cc) : undefined,
        bcc: options.bcc ? parseEmails(options.bcc) : undefined,
        threadId: options.thread,
        fromEmail: options.from,
      })

      out.printYaml(result)
      out.success('Draft created')
    })

  // =========================================================================
  // draft send
  // =========================================================================

  cli
    .command('draft send <draftId>', 'Send a draft')
    .action(async (draftId, options) => {
      const { client } = await getClient(options.account)
      const result = await client.sendDraft({ draftId })

      out.printYaml(result)
      out.success('Draft sent')
    })

  // =========================================================================
  // draft delete
  // =========================================================================

  cli
    .command('draft delete <draftId>', 'Delete a draft')
    .option('--force', 'Skip confirmation')
    .action(async (draftId, options) => {
      if (!options.force && process.stdin.isTTY) {
        const readline = await import('node:readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Delete draft ${draftId}? [y/N] `, resolve)
        })
        rl.close()

        if (answer.toLowerCase() !== 'y') {
          out.hint('Cancelled')
          return
        }
      }

      const { client } = await getClient(options.account)

      await client.deleteDraft({ draftId })

      out.printYaml({ draft_id: draftId, deleted: true })
    })
}
