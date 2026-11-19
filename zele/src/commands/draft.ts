// Draft commands: list, create, get, send, delete.
// Manages Gmail drafts with YAML output for list views.
// Cache invalidation is handled by the client (sendDraft invalidates threadLists).
// Multi-account: list fetches all accounts concurrently and merges by date.

import type { ZeleCli } from '../cli-types.js'
import { z } from 'zod'
import * as clack from '@clack/prompts'
import { getClients, getClient } from '../auth.js'
import type { GmailClient } from '../gmail-client.js'
import type { ImapSmtpClient } from '../imap-smtp-client.js'
import { AuthError } from '../api-utils.js'
import { downloadAttachments } from '../email-utils.js'
import { readBodyFile, resolveAttachments } from './mail.js'
import { createOutput, formatDate, renderEmailBody, type Output } from '../output.js'
import { colors as pc, isAgent } from 'goke'

export function registerDraftCommands(cli: ZeleCli) {
  // =========================================================================
  // draft list
  // =========================================================================

  cli
    .command('draft list', 'List drafts')
    .option('--limit <limit>', z.number().default(20).describe('Max results'))
    .option('--page <page>', z.string().describe('Pagination token (requires --account, only works for a single account)'))
    .option('--filter <filter>', z.string().describe('Search query'))
    .action(async (options, ctx) => {
      const out: Output = createOutput(ctx)
      const clients = await getClients(options.account)

      if (options.page && clients.length > 1) {
        out.error('--page cannot be used with multiple accounts (page tokens are per-account)')
        out.exit(1)
      }

      // Fetch from all accounts concurrently
      const results = await Promise.all(
        clients.map(async ({ email, client }) => {
          const result = await client.listDrafts({
            query: options.filter,
            maxResults: options.limit,
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

      // Merge drafts from all accounts, sorted by date descending, capped at limit
      const merged = allResults
        .flatMap(({ email, result }) =>
          result.drafts.map((d) => ({ ...d, account: email })),
        )
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, options.limit)

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
          date: formatDate(d.date),
        })),
        { summary: `${merged.length} draft(s)`, nextPage: allResults[0]?.result.nextPageToken },
      )
    })

  // =========================================================================
  // draft get
  // =========================================================================

  cli
    .command('draft get <draftId>', 'Show draft details')
    .action(async (draftId, options, ctx) => {
      const out: Output = createOutput(ctx)
      const { client } = await getClient(options.account)

      const draft = await client.getDraft({ draftId })
      if (draft instanceof Error) out.fail(draft)

      const fmtRecipients = (list: Array<{ name?: string; email: string }>) =>
        list.map((r) => r.name && r.name !== r.email ? `${r.name} <${r.email}>` : r.email).join(', ')

      out.log(pc.bold(`Draft: ${draft.message.subject}`))
      out.log(pc.dim(`Draft ID: ${draft.id}`))
      out.log(`To: ${fmtRecipients(draft.to) || '(none)'}`)
      if (draft.cc.length > 0) {
        out.log(`Cc: ${fmtRecipients(draft.cc)}`)
      }
      if (draft.bcc.length > 0) {
        out.log(`Bcc: ${fmtRecipients(draft.bcc)}`)
      }
      out.log()

      const body = renderEmailBody(draft.message.body, draft.message.mimeType)
      out.log(body)
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
    .option('--attach <attach>', z.array(z.string()).describe('File to attach (repeatable: --attach a.pdf --attach b.png)'))
    .action(async (options, ctx) => {
      const out: Output = createOutput(ctx)
      if (!options.to) {
        out.error('--to is required')
        out.exit(1)
      }
      if (!options.subject) {
        out.error('--subject is required')
        out.exit(1)
      }

      let body = options.body ?? ''
      if (options.bodyFile) body = await readBodyFile(out, ctx, options.bodyFile)

      const parseEmails = (str: string) =>
        str.split(',').map((e) => e.trim()).filter(Boolean).map((email) => ({ email }))

      const attachments = resolveAttachments(out, options.attach)

      const { client } = await getClient(options.account)

      const result = await client.createDraft({
        to: parseEmails(options.to),
        subject: options.subject,
        body,
        cc: options.cc ? parseEmails(options.cc) : undefined,
        bcc: options.bcc ? parseEmails(options.bcc) : undefined,
        threadId: options.thread,
        fromEmail: options.from,
        attachments,
      })
      if (result instanceof Error) out.fail(result)

      out.printYaml(result)
      out.success('Draft created')
    })

  // =========================================================================
  // draft update
  // =========================================================================

  cli
    .command('draft update <draftId>', 'Update an existing draft')
    .option('--to <to>', z.string().describe('New recipient email(s), comma-separated'))
    .option('--subject <subject>', z.string().describe('New subject'))
    .option('--body <body>', z.string().describe('New body text'))
    .option('--body-file <bodyFile>', z.string().describe('Read new body from file (use - for stdin)'))
    .option('--cc <cc>', z.string().describe('New CC recipients (comma-separated)'))
    .option('--bcc <bcc>', z.string().describe('New BCC recipients (comma-separated)'))
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .option('--attach <attach>', z.array(z.string()).describe('File to add to the existing attachments (repeatable: --attach a.pdf --attach b.png)'))
    .action(async (draftId, options, ctx) => {
      const out: Output = createOutput(ctx)
      const newAttachments = resolveAttachments(out, options.attach) ?? []

      const { client } = await getClient(options.account)

      // Fetch existing draft to merge unchanged fields
      const existing = await client.getDraft({ draftId })
      if (existing instanceof Error) out.fail(existing)

      let body = options.body
      if (options.bodyFile) body = await readBodyFile(out, ctx, options.bodyFile)

      const parseEmails = (str: string) =>
        str.split(',').map((e) => e.trim()).filter(Boolean).map((email) => ({ email }))

      // The draft is rebuilt from scratch, so existing attachments must be re-uploaded.
      const existingAttachments = await downloadAttachments({
        client,
        messageId: existing.message.id,
        attachments: existing.message.attachments,
      })
      if (existingAttachments instanceof Error) out.fail(existingAttachments)

      const result = await client.updateDraft({
        draftId,
        attachments: [...existingAttachments, ...newAttachments],
        to: options.to ? parseEmails(options.to) : existing.to,
        subject: options.subject ?? existing.message.subject,
        body: body ?? existing.message.body,
        cc: options.cc ? parseEmails(options.cc) : existing.cc,
        bcc: options.bcc ? parseEmails(options.bcc) : existing.bcc,
        threadId: existing.message.threadId || undefined,
        fromEmail: options.from ?? existing.message.from.email,
      })
      if (result instanceof Error) out.fail(result)

      out.printYaml(result)
      out.success('Draft updated')
    })

  // =========================================================================
  // draft send
  // =========================================================================

  cli
    .command('draft send <draftId>', 'Send a draft. To wait for the answer, check existing replies, then run mail watch')
    .action(async (draftId, options, ctx) => {
      const out: Output = createOutput(ctx)
      const { client } = await getClient(options.account)
      const result = await client.sendDraft({ draftId })
      if (result instanceof Error) out.fail(result)

      out.printYaml(result)
      out.success('Draft sent')
    })

  // =========================================================================
  // draft delete
  // =========================================================================

  cli
    .command('draft delete <draftId>', 'Delete a draft')
    .option('--force', 'Skip confirmation')
    .action(async (draftId, options, ctx) => {
      const out: Output = createOutput(ctx)
      if (!options.force) {
        if (isAgent || !process.stdin.isTTY) {
          out.error('Use --force to delete non-interactively')
          out.exit(1)
        }

        const confirmed = await clack.confirm({
          message: `Delete draft ${draftId}?`,
          initialValue: false,
        })

        if (clack.isCancel(confirmed) || !confirmed) {
          out.hint('Cancelled')
          return
        }
      }

      const { client } = await getClient(options.account)

      const deleteResult = await client.deleteDraft({ draftId })
      if (deleteResult instanceof Error) out.fail(deleteResult)

      out.printYaml({ draft_id: draftId, deleted: true })
    })
}
