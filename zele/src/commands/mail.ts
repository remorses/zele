// Mail commands: list, search, read, send, reply, forward.
// Core email operations wrapping GmailClient with YAML output for list views.
// Cache is handled by the client — commands just call methods and use data.
// Multi-account: list/search fetch all accounts concurrently and merge by date.

import type { ZeleCli } from '../cli-types.js'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { lookup as mimeLookup } from 'mrmime'
import { getClients, getClient, listAccounts, login } from '../auth.js'
import { replySubject, threadAnchor } from '../email-utils.js'
import type { ThreadListResult } from '../gmail-client.js'
import type { GmailClient } from '../gmail-client.js'
import { AuthError, NotFoundError, UnsupportedError } from '../api-utils.js'
import { getThreadSeenMessageId, setThreadSeenMessageId } from '../db.js'
import { hasUnsubscribeMechanism, hasOneClickUnsubscribe } from '../unsubscribe.js'
import * as out from '../output.js'
import { handleCommandError } from '../output.js'
import { REPLY_FOLLOW_UP_HINT, replyWatchCommand } from './watch.js'
import { colors as pc } from 'goke'

// ---------------------------------------------------------------------------
// Label formatting — filter out system labels already represented by flags
// ---------------------------------------------------------------------------

const HIDDEN_LABELS = new Set([
  'INBOX', 'SENT', 'TRASH', 'SPAM', 'DRAFT', 'UNREAD', 'STARRED',
  'IMPORTANT', 'CHAT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
])

function formatLabels(labelIds: string[], labelMap?: Map<string, string>): string {
  const visible = labelIds
    .filter((id) => !HIDDEN_LABELS.has(id))
    .map((id) => labelMap?.get(id) ?? id)
  return visible.join(', ')
}

/** Parse a comma-separated CLI address option into recipient objects.
 *  Returns undefined for empty/missing input so callers can distinguish
 *  "not provided" (infer it) from "provided but empty". */
function parseEmailList(value?: string): Array<{ email: string }> | undefined {
  if (!value) return undefined
  const parsed = value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((email) => ({ email }))
  return parsed.length > 0 ? parsed : undefined
}

async function markThreadSeen({
  email,
  appId,
  threadId,
  messages,
}: {
  email: string
  appId: string
  threadId: string
  messages: Array<{ id: string; isDraft: boolean }>
}) {
  const last = threadAnchor(messages)
  if (!last) return
  const result = await setThreadSeenMessageId({ email, appId, threadId, messageId: last.id })
  if (result instanceof Error) {
    console.warn('Failed to record thread read:', result.message)
  }
}

async function loadSeenMessageId({
  email,
  appId,
  threadId,
  force,
}: {
  email: string
  appId: string
  threadId: string
  force?: boolean
}) {
  if (force) return undefined
  const seen = await getThreadSeenMessageId({ email, appId, threadId })
  if (seen instanceof Error) handleCommandError(seen)
  return seen
}

function resolveAttachments(filePaths?: string[]) {
  return filePaths
    ? filePaths.map((filePath) => {
        const resolved = path.resolve(filePath)
        if (!fs.existsSync(resolved)) {
          out.error(`Attachment not found: ${resolved}`)
          process.exit(1)
        }
        return {
          filename: path.basename(resolved),
          mimeType: mimeLookup(resolved) ?? 'application/octet-stream',
          content: fs.readFileSync(resolved),
        }
      })
    : undefined
}

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------

export function registerMailCommands(cli: ZeleCli) {
  // =========================================================================
  // mail (TUI)
  // =========================================================================


  // =========================================================================
  // mail list
  // =========================================================================

  cli
    .command('mail list', 'List email threads')
    .option('--folder [folder]', 'Folder to list (inbox, sent, trash, spam, starred, drafts, archive, all) (default: inbox)')
    .option('--limit [limit]', 'Max threads to show (default: 20)')
    .option('--page <page>', 'Pagination token (requires --account, only works for a single account)')
    .option('--label <label>', 'Filter by label name')
    .option('--filter <filter>', 'Gmail search filter (e.g. "is:unread", "from:github", "has:attachment")')
    .action(async (options) => {
      // `options.folder` / `options.limit` are `string | undefined` now.
      // `''` (bare flag) falls back to the default via `||`.
      const folder = options.folder || 'inbox'
      const limit = options.limit ? Number(options.limit) : 20
      const clients = await getClients(options.account)

      if (options.page && clients.length > 1) {
        out.error('--page cannot be used with multiple accounts (page tokens are per-account)')
        process.exit(1)
      }

      // Fetch threads and labels from all accounts concurrently
      const results = await Promise.all(
        clients.map(async ({ email, client, accountType }) => {
          let labelIds: string[] | undefined
          if (options.label) {
            if (accountType !== 'google') {
              return new UnsupportedError({
                feature: 'Labels',
                accountType: 'IMAP/SMTP',
                hint: 'IMAP accounts use folders. Use --folder to browse different mailboxes.',
              })
            }
            const labelId = await (client as GmailClient).lookupLabel(options.label)
            if (labelId instanceof Error) return labelId
            if (labelId === null) return new NotFoundError({ resource: `label "${options.label}"` })
            labelIds = [labelId]
          }
          const result = await client.listThreads({
            folder,
            maxResults: limit,
            labelIds,
            pageToken: options.page,
            query: options.filter,
          })
          if (result instanceof Error) return result

          // Labels are Google-only — skip for IMAP accounts
          let labelMap = new Map<string, string>()
          if (accountType === 'google') {
            const labelsResult = await (client as GmailClient).listLabels()
            if (!(labelsResult instanceof Error)) {
              labelMap = new Map(labelsResult.parsed.map((l) => [l.id, l.name]))
            }
          }
          return { email, result, labelMap }
        }),
      )

      const failures: Error[] = []
      const allResults: Array<{ email: string; result: ThreadListResult; labelMap: Map<string, string> }> = []
      for (const r of results) {
        if (r instanceof Error) failures.push(r)
        else allResults.push(r)
      }
      if (allResults.length === 0) {
        handleCommandError(failures[0] ?? new Error('Failed to fetch'))
      }
      for (const r of failures) {
        if (r instanceof AuthError) out.error(`${r.message}. Try: zele login`)
        else out.error(`Failed to fetch: ${r.message}`)
      }

      // Merge label maps from all accounts
      const labelMap = new Map<string, string>()
      for (const r of allResults) for (const [id, name] of r.labelMap) labelMap.set(id, name)

      // Merge threads from all accounts, sorted by date descending, capped at limit
      const merged = allResults
        .flatMap(({ email, result }) =>
          result.threads.map((t) => ({ ...t, account: email })),
        )
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, limit)

      if (merged.length === 0) {
        out.printList([], { summary: 'No threads found' })
        return
      }

      const showAccount = clients.length > 1
      out.printList(
        merged.map((t) => {
          const to = t.to.map((s) => out.formatSender(s)).join(', ')
          const cc = t.cc.map((s) => out.formatSender(s)).join(', ')
          const labels = formatLabels(t.labelIds, labelMap)
          const canUnsubscribe = hasUnsubscribeMechanism(t.listUnsubscribe)
          const oneClick = hasOneClickUnsubscribe(t.listUnsubscribe, t.listUnsubscribePost)
          return {
            ...(showAccount ? { account: t.account } : {}),
            id: t.id,
            flags: out.formatFlags(t),
            from: out.formatSender(t.from),
            ...(to ? { to } : {}),
            ...(cc ? { cc } : {}),
            subject: t.subject,
            snippet: t.snippet,
            date: out.formatDate(t.date),
            messages: t.messageCount,
            ...(labels ? { labels } : {}),
            ...(canUnsubscribe ? { can_unsubscribe: true } : {}),
            ...(oneClick ? { one_click: true } : {}),
            ...(t.listUnsubscribe ? { unsubscribe: t.listUnsubscribe } : {}),
          }
        }),
        { summary: `${merged.length} threads (${folder})`, nextPage: allResults[0]?.result.nextPageToken },
      )
    })

  // =========================================================================
  // mail search
  // =========================================================================

  cli
    .command('mail search <query>', 'Search email threads using Gmail query syntax (from:, to:, subject:, has:attachment, etc). See https://support.google.com/mail/answer/7190')
    .option('--limit [limit]', 'Max results to show (default: 20)')
    .option('--page <page>', 'Pagination token (requires --account, only works for a single account)')
    .action(async (query, options) => {
      const limit = options.limit ? Number(options.limit) : 20
      const clients = await getClients(options.account)

      if (options.page && clients.length > 1) {
        out.error('--page cannot be used with multiple accounts (page tokens are per-account)')
        process.exit(1)
      }

      // Search all accounts concurrently (fetch labels alongside for name resolution)
      const results = await Promise.all(
        clients.map(async ({ email, client, accountType }) => {
          const result = await client.listThreads({
            query,
            maxResults: limit,
            pageToken: options.page,
          })
          if (result instanceof Error) return result

          let labelMap = new Map<string, string>()
          if (accountType === 'google') {
            const labelsResult = await (client as GmailClient).listLabels()
            if (!(labelsResult instanceof Error)) {
              labelMap = new Map(labelsResult.parsed.map((l) => [l.id, l.name]))
            }
          }
          return { email, result, labelMap }
        }),
      )

      const allResults = results.filter((r): r is Exclude<typeof r, Error> => {
          if (r instanceof AuthError) { out.error(`${r.message}. Try: zele login`); return false }
          if (r instanceof Error) { out.error(`Failed to search: ${r.message}`); return false }
          return true
        })

      // Merge label maps from all accounts
      const labelMap = new Map<string, string>()
      for (const r of allResults) for (const [id, name] of r.labelMap) labelMap.set(id, name)

      const merged = allResults
        .flatMap(({ email, result }) =>
          result.threads.map((t) => ({ ...t, account: email })),
        )
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, limit)

      if (merged.length === 0) {
        out.printList([], { summary: `No results for "${query}"` })
        return
      }

      const showAccount = clients.length > 1
      out.printList(
        merged.map((t) => {
          const to = t.to.map((s) => out.formatSender(s)).join(', ')
          const cc = t.cc.map((s) => out.formatSender(s)).join(', ')
          const labels = formatLabels(t.labelIds, labelMap)
          const canUnsubscribe = hasUnsubscribeMechanism(t.listUnsubscribe)
          const oneClick = hasOneClickUnsubscribe(t.listUnsubscribe, t.listUnsubscribePost)
          return {
            ...(showAccount ? { account: t.account } : {}),
            id: t.id,
            flags: out.formatFlags(t),
            from: out.formatSender(t.from),
            ...(to ? { to } : {}),
            ...(cc ? { cc } : {}),
            subject: t.subject,
            snippet: t.snippet,
            date: out.formatDate(t.date),
            messages: t.messageCount,
            ...(labels ? { labels } : {}),
            ...(canUnsubscribe ? { can_unsubscribe: true } : {}),
            ...(oneClick ? { one_click: true } : {}),
            ...(t.listUnsubscribe ? { unsubscribe: t.listUnsubscribe } : {}),
          }
        }),
        { summary: `${merged.length} results for "${query}"`, nextPage: allResults[0]?.result.nextPageToken },
      )
    })

  // =========================================================================
  // mail read
  // =========================================================================

  cli
    .command('mail read [...threadIds]', 'Read full email threads with per-message IDs (does not mark as read)')
    .option('--raw', 'Show raw message (first message only, single thread)')
    .option('--raw-html', 'Show raw HTML body per message (no markdown conversion)')
    .option('--verify', 'Show expanded authentication details (SPF/DKIM/DMARC) and threading headers')
    .action(async (threadIds, options) => {
      if (threadIds.length === 0) {
        out.error('No thread IDs provided')
        process.exit(1)
      }

      const { client, email, appId } = await getClient(options.account)

      if (options.raw && options.rawHtml) {
        out.error('--raw and --raw-html cannot be used together')
        process.exit(1)
      }

      if (options.raw) {
        if (threadIds.length > 1) {
          out.error('--raw only supports a single thread ID')
          process.exit(1)
        }
        const threadResult = await client.getThread({ threadId: threadIds[0]!, skipCache: true })
        if (threadResult instanceof Error) handleCommandError(threadResult)
        const thread = threadResult.parsed
        if (thread.messages.length === 0) {
          out.hint('No messages in thread')
          return
        }
        const rawMsg = await client.getRawMessage({ messageId: thread.messages[0]!.id })
        if (rawMsg instanceof Error) handleCommandError(rawMsg)
        console.log(rawMsg)
        await markThreadSeen({ email, appId, threadId: thread.id, messages: [thread.messages[0]!] })
        return
      }

      // Client API calls return errors as values, but local cache/database work
      // can still reject. Keep each read isolated so one failure cannot abort
      // a multi-thread command.
      const settled = await Promise.allSettled(
        threadIds.map((id) => client.getThread({ threadId: id, skipCache: true })),
      )

      const w = Math.min(process.stdout.columns || 72, 72)
      const rule = pc.dim('─'.repeat(w))
      const multi = threadIds.length > 1

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i]!

        if (multi) {
          const doubleRule = pc.bold('━'.repeat(w))
          console.log(doubleRule)
          console.log(pc.bold(`Thread ${i + 1}/${settled.length}`) + pc.dim(` · ${threadIds[i]}`))
          console.log(doubleRule)
          console.log()
        }

        if (result.status === 'rejected') {
          out.error(`Failed to read thread ${threadIds[i]}: ${String(result.reason)}`)
          if (multi) console.log()
          continue
        }

        if (result.value instanceof Error) {
          out.error(`Failed to read thread ${threadIds[i]}: ${result.value.message}`)
          if (multi) console.log()
          continue
        }

        const thread = result.value.parsed

        if (thread.messages.length === 0) {
          out.hint('No messages in thread')
          if (multi) console.log()
          continue
        }

        if (options.rawHtml) {
          thread.messages.forEach((msg, index) => {
            console.log(msg.body)
            if (index < thread.messages.length - 1) {
              console.log('\n<!-- ZELE_MESSAGE_SEPARATOR -->\n')
            }
          })
          await markThreadSeen({ email, appId, threadId: thread.id, messages: thread.messages })
          if (multi) console.log()
          continue
        }

        // Render thread header
        console.log(pc.bold(thread.subject))
        const participants = new Map<string, string>()
        for (const msg of thread.messages) {
          participants.set(msg.from.email, msg.from.name || msg.from.email)
          for (const r of msg.to) participants.set(r.email, r.name || r.email)
        }
        const participantStr = [...participants.values()].join(', ')
        console.log(pc.dim(`${thread.messageCount} message(s) · ${participantStr}`))
        console.log(pc.dim(`ID: ${thread.id}`))
        console.log(rule + '\n')

        // Render each message
        for (const msg of thread.messages) {
          const fromStr = out.formatSender(msg.from)
          const dateStr = out.formatDate(msg.date)

          const flagParts: string[] = []
          if (msg.unread) flagParts.push(pc.yellow('[unread]'))
          if (msg.starred) flagParts.push(pc.yellow('[starred]'))
          const flagStr = flagParts.length > 0 ? ' ' + flagParts.join(' ') : ''

          console.log(pc.bold(`From: `) + fromStr + flagStr)
          console.log(pc.dim(`  To: ${msg.to.map((t) => t.email).join(', ')}`))
          if (msg.cc && msg.cc.length > 0) {
            console.log(pc.dim(`  Cc: ${msg.cc.map((c) => c.email).join(', ')}`))
          }
          console.log(pc.dim(`Date: ${dateStr}`))
          console.log(pc.dim(`Message ID: ${msg.id}`))
          if (options.verify) {
            if (msg.messageId) console.log(pc.dim(`Message-ID: ${msg.messageId}`))
            if (msg.inReplyTo) console.log(pc.dim(`In-Reply-To: ${msg.inReplyTo}`))
            if (msg.references) console.log(pc.dim(`References: ${msg.references}`))
          }

          if (msg.auth) {
            const check = (verdict: string) => {
              return verdict === 'pass'
                ? pc.green('✓')
                : pc.red('✗')
            }
            const parts = [
              `${check(msg.auth.spf)} SPF`,
              `${check(msg.auth.dkim)} DKIM`,
              `${check(msg.auth.dmarc)} DMARC`,
            ]
            const label = msg.auth.authentic ? pc.green('authentic') : pc.red('UNVERIFIED')
            console.log(`Auth: ${parts.join('  ')}  (${label})`)
            if (options.verify) {
              console.log(pc.dim(`  Raw: ${msg.auth.raw}`))
            }
          }

          if (msg.attachments.length > 0) {
            const attList = msg.attachments.map((a) => {
              const size = a.size < 1024 ? `${a.size} B`
                : a.size < 1048576 ? `${(a.size / 1024).toFixed(1)} KB`
                : `${(a.size / 1048576).toFixed(1)} MB`
              return `${a.filename} (${size})`
            })
            console.log(pc.dim(`Attachments: ${attList.join(', ')}`))
          }

          console.log()

          const body = out.renderEmailBody(msg.body, msg.mimeType)
          console.log(body)
          console.log('\n' + rule + '\n')
        }

        await markThreadSeen({ email, appId, threadId: thread.id, messages: thread.messages })
      }
    })

  // =========================================================================
  // mail send
  // =========================================================================

  cli
    .command('mail send', 'Send an email. To wait for the answer, check existing replies, then run mail watch (printed in the output)')
    .option('--to <to>', z.string().describe('Recipient email (repeatable with comma)'))
    .option('--subject <subject>', z.string().describe('Email subject'))
    .option('--body <body>', z.string().describe('Email body text'))
    .option('--body-file <bodyFile>', z.string().describe('Read body from file (use - for stdin)'))
    .option('--cc <cc>', z.string().describe('CC recipients (comma-separated)'))
    .option('--bcc <bcc>', z.string().describe('BCC recipients (comma-separated)'))
    .option('--thread-id <threadId>', z.string().describe('Send into an existing thread (sets In-Reply-To/References)'))
    .option('--all', 'With --thread-id: CC the other thread participants')
    .option('--allow-self', 'With --thread-id: allow sending to your own address')
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .option('--attach <attach>', z.array(z.string()).describe('File to attach (repeatable: --attach a.pdf --attach b.png)'))
    .option('--force', 'With --thread-id: send even if the latest message was not read')
    .action(async (options) => {
      // With --thread-id both --to and --subject are inferred from the thread.
      if (!options.to && !options.threadId) {
        out.error('--to is required')
        process.exit(1)
      }
      if (!options.subject && !options.threadId) {
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

      if (!body) {
        out.error('--body or --body-file is required')
        process.exit(1)
      }

      const attachments = resolveAttachments(options.attach)

      const to = parseEmailList(options.to)
      const cc = parseEmailList(options.cc)
      const bcc = parseEmailList(options.bcc)

      const { client, email, appId, accountType } = await getClient(options.account)

      // --thread-id sends into an existing conversation: recipients default to
      // the thread's counterparty and the In-Reply-To/References headers (plus
      // Gmail's threadId) are derived from it, so the message actually threads.
      if (options.threadId) {
        const seenMessageId = await loadSeenMessageId({
          email,
          appId,
          threadId: options.threadId,
          force: options.force,
        })
        const result = await client.sendInThread({
          threadId: options.threadId,
          to,
          subject: options.subject,
          body,
          cc,
          bcc,
          replyAll: options.all,
          allowSelf: options.allowSelf,
          fromEmail: options.from,
          attachments,
          seenMessageId,
        })
        if (result instanceof Error) handleCommandError(result)
        if (accountType === 'google' && result.message.id) {
          const marked = await setThreadSeenMessageId({
            email,
            appId,
            threadId: options.threadId,
            messageId: result.message.id,
          })
          if (marked instanceof Error) {
            console.warn('Sent, but failed to record the new message as read:', marked.message)
          }
        }

        out.printYaml({
          ...result.message,
          to: result.to,
          cc: result.cc,
          bcc: result.bcc,
          recipient_source: result.recipientSource,
        })
        out.success(`Sent to ${result.to.join(', ')} in thread ${options.threadId}`)
        out.hint(REPLY_FOLLOW_UP_HINT)
        out.hint(`Wait for the reply: ${replyWatchCommand({ account: email, to: result.to, subject: options.subject })}`)
        return
      }

      if (!to) {
        out.error('--to must contain at least one email address')
        process.exit(1)
      }
      if (!options.subject) {
        out.error('--subject is required')
        process.exit(1)
      }

      const result = await client.sendMessage({
        to,
        subject: options.subject,
        body,
        cc,
        bcc,
        fromEmail: options.from,
        attachments,
      })
      if (result instanceof Error) handleCommandError(result)

      out.printYaml(result)
      out.success(`Sent to ${options.to}`)
      out.hint(REPLY_FOLLOW_UP_HINT)
      out.hint(`Wait for the reply: ${replyWatchCommand({ account: email, to: to.map((r) => r.email), subject: options.subject })}`)
    })

  // =========================================================================
  // mail reply
  // =========================================================================

  cli
    .command('mail reply <threadId>', 'Reply to an email thread. To wait for the answer, check existing replies, then run mail watch (printed in the output)')
    .option('--body <body>', z.string().describe('Reply body text'))
    .option('--body-file <bodyFile>', z.string().describe('Read body from file (use - for stdin)'))
    .option('--to <to>', z.string().describe('Override the inferred recipient(s), comma-separated'))
    .option('--cc <cc>', z.string().describe('Additional CC recipients'))
    .option('--bcc <bcc>', z.string().describe('BCC recipients (comma-separated)'))
    .option('--all', 'Reply all (include all original recipients)')
    .option('--allow-self', 'Allow replying to your own address (normally refused)')
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .option('--attach <attach>', z.array(z.string()).describe('File to attach (repeatable: --attach a.pdf --attach b.png)'))
    .option('--draft', 'Save as draft instead of sending')
    .option('--dry-run', 'Print the resolved recipients and headers without sending')
    .option('--force', 'Reply even if the latest message was not read')
    .action(async (threadId, options) => {
      // --dry-run answers "who would this reply go to?" before committing to send.
      if (options.dryRun) {
        const { client } = await getClient(options.account)
        const envelope = await client.resolveThreadReply({
          threadId,
          to: parseEmailList(options.to),
          cc: parseEmailList(options.cc),
          replyAll: options.all,
          allowSelf: options.allowSelf,
        })
        if (envelope instanceof Error) handleCommandError(envelope)

        out.printYaml({
          to: envelope.to.map((r) => r.email),
          cc: (envelope.cc ?? []).map((r) => r.email),
          bcc: parseEmailList(options.bcc)?.map((r) => r.email) ?? [],
          from: options.from ?? null,
          subject: replySubject(envelope.anchorSubject),
          in_reply_to: envelope.inReplyTo ?? null,
          references: envelope.references ?? null,
          recipient_source: envelope.source,
        })
        out.hint('Dry run — nothing was sent')
        return
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

      if (!body) {
        out.error('--body or --body-file is required')
        process.exit(1)
      }

      const attachments = resolveAttachments(options.attach)

      const { client, email: accountEmail, appId, accountType } = await getClient(options.account)

      const to = parseEmailList(options.to)
      const cc = parseEmailList(options.cc)
      const bcc = parseEmailList(options.bcc)

      // Explicit --to is always honored, but mailing only yourself is nearly
      // always a mistake, so say so out loud instead of silently doing it.
      if (to && to.every((r) => r.email.toLowerCase() === accountEmail.toLowerCase())) {
        out.hint(`Recipient is your own address (${accountEmail})`)
      }

      const seenMessageId = await loadSeenMessageId({
        email: accountEmail,
        appId,
        threadId,
        force: options.force,
      })

      if (options.draft) {
        const result = await client.createDraftReply({
          threadId,
          body,
          to,
          replyAll: options.all,
          cc,
          bcc,
          allowSelf: options.allowSelf,
          fromEmail: options.from,
          attachments,
          seenMessageId,
        })
        if (result instanceof Error) handleCommandError(result)

        out.printYaml({
          ...result.message,
          to: result.to,
          cc: result.cc,
          bcc: result.bcc,
          recipient_source: result.recipientSource,
        })
        out.success(`Reply draft created for ${result.to.join(', ')}`)
        return
      }

      const result = await client.sendInThread({
        threadId,
        body,
        to,
        replyAll: options.all,
        cc,
        bcc,
        allowSelf: options.allowSelf,
        fromEmail: options.from,
        attachments,
        seenMessageId,
      })
      if (result instanceof Error) handleCommandError(result)
      if (accountType === 'google' && result.message.id) {
        const marked = await setThreadSeenMessageId({
          email: accountEmail,
          appId,
          threadId,
          messageId: result.message.id,
        })
        if (marked instanceof Error) {
          console.warn('Sent, but failed to record the new message as read:', marked.message)
        }
      }

      out.printYaml({
        ...result.message,
        to: result.to,
        cc: result.cc,
        bcc: result.bcc,
        recipient_source: result.recipientSource,
      })
      out.success(`Reply sent to ${result.to.join(', ')}`)
      out.hint(REPLY_FOLLOW_UP_HINT)
      out.hint(`Wait for the reply: ${replyWatchCommand({ account: accountEmail, to: result.to })}`)
    })

  // =========================================================================
  // mail forward
  // =========================================================================

  cli
    .command('mail forward <threadId>', 'Forward an email thread')
    .option('--to <to>', z.string().describe('Forward recipient(s), comma-separated'))
    .option('--body <body>', z.string().describe('Optional message to prepend'))
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .option('--draft', 'Save as draft instead of sending')
    .action(async (threadId, options) => {
      if (!options.to) {
        out.error('--to is required')
        process.exit(1)
      }

      const recipients = options.to
        .split(',')
        .map((e) => ({ email: e.trim() }))
        .filter((e) => e.email)

      const { client } = await getClient(options.account)

      if (options.draft) {
        const result = await client.createDraftForward({
          threadId,
          to: recipients,
          body: options.body,
          fromEmail: options.from,
        })
        if (result instanceof Error) handleCommandError(result)

        out.printYaml(result)
        out.success('Forward draft created')
        return
      }

      const result = await client.forwardThread({
        threadId,
        to: recipients,
        body: options.body,
        fromEmail: options.from,
      })
      if (result instanceof Error) handleCommandError(result)

      out.printYaml(result)
      out.success(`Forwarded to ${options.to}`)
    })
}
