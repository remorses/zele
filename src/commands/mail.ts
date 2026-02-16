// Mail commands: list, search, read, send, reply, forward.
// Core email operations wrapping GmailClient with YAML output for list views.
// Cache is handled by the client — commands just call methods and use data.
// Multi-account: list/search fetch all accounts concurrently and merge by date.

import type { Goke } from 'goke'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { lookup as mimeLookup } from 'mrmime'
import { getClients, getClient, listAccounts, login } from '../auth.js'
import type { ThreadListResult } from '../gmail-client.js'
import { AuthError } from '../api-utils.js'
import * as out from '../output.js'
import { handleCommandError } from '../output.js'
import pc from 'picocolors'

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------

export function registerMailCommands(cli: Goke) {
  // =========================================================================
  // mail (TUI)
  // =========================================================================


  // =========================================================================
  // mail list
  // =========================================================================

  cli
    .command('mail list', 'List email threads')
    .option('--folder [folder]', 'Folder to list (inbox, sent, trash, spam, starred, drafts, archive, all) (default: inbox)')
    .option('--max [max]', 'Max results per page (default: 20)')
    .option('--page <page>', 'Pagination token')
    .option('--label <label>', 'Filter by label name')
    .action(async (options) => {
      const folder = options.folder ?? 'inbox'
      const max = options.max ? Number(options.max) : 20
      const clients = await getClients(options.account)

      if (options.page && clients.length > 1) {
        out.error('--page cannot be used with multiple accounts (page tokens are per-account)')
        process.exit(1)
      }

      // Fetch from all accounts concurrently
      const results = await Promise.all(
        clients.map(async ({ email, client }) => {
          const result = await client.listThreads({
            folder,
            maxResults: max,
            labelIds: options.label ? [options.label] : undefined,
            pageToken: options.page,
          })
          if (result instanceof Error) return result
          return { email, result }
        }),
      )

      const allResults = results.filter((r): r is Exclude<typeof r, Error> => {
          if (r instanceof AuthError) { out.error(`${r.message}. Try: zele login`); return false }
          if (r instanceof Error) { out.error(`Failed to fetch: ${r.message}`); return false }
          return true
        })

      // Merge threads from all accounts, sorted by date descending, capped at max
      const merged = allResults
        .flatMap(({ email, result }) =>
          result.threads.map((t) => ({ ...t, account: email })),
        )
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, max)

      if (merged.length === 0) {
        out.printList([], { summary: 'No threads found' })
        return
      }

      const showAccount = clients.length > 1
      out.printList(
        merged.map((t) => ({
          ...(showAccount ? { account: t.account } : {}),
          id: t.id,
          flags: out.formatFlags(t),
          from: out.formatSender(t.from),
          subject: t.subject,
          date: out.formatDate(t.date),
          messages: t.messageCount,
        })),
        { summary: `${merged.length} threads (${folder})` },
      )
    })

  // =========================================================================
  // mail search
  // =========================================================================

  cli
    .command('mail search <query>', 'Search email threads using Gmail query syntax (from:, to:, subject:, has:attachment, etc). See https://support.google.com/mail/answer/7190')
    .option('--max [max]', 'Max results (default: 20)')
    .option('--page <page>', 'Pagination token')
    .action(async (query, options) => {
      const max = options.max ? Number(options.max) : 20
      const clients = await getClients(options.account)

      if (options.page && clients.length > 1) {
        out.error('--page cannot be used with multiple accounts (page tokens are per-account)')
        process.exit(1)
      }

      // Search all accounts concurrently
      const results = await Promise.all(
        clients.map(async ({ email, client }) => {
          const result = await client.listThreads({
            query,
            maxResults: max,
            pageToken: options.page,
          })
          if (result instanceof Error) return result
          return { email, result }
        }),
      )

      const allResults = results.filter((r): r is Exclude<typeof r, Error> => {
          if (r instanceof AuthError) { out.error(`${r.message}. Try: zele login`); return false }
          if (r instanceof Error) { out.error(`Failed to search: ${r.message}`); return false }
          return true
        })

      const merged = allResults
        .flatMap(({ email, result }) =>
          result.threads.map((t) => ({ ...t, account: email })),
        )
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, max)

      if (merged.length === 0) {
        out.printList([], { summary: `No results for "${query}"` })
        return
      }

      const showAccount = clients.length > 1
      out.printList(
        merged.map((t) => ({
          ...(showAccount ? { account: t.account } : {}),
          id: t.id,
          flags: out.formatFlags(t),
          from: out.formatSender(t.from),
          subject: t.subject,
          date: out.formatDate(t.date),
          messages: t.messageCount,
        })),
        { summary: `${merged.length} results for "${query}"` },
      )
    })

  // =========================================================================
  // mail read
  // =========================================================================

  cli
    .command('mail read <threadId>', 'Read a full email thread')
    .option('--raw', 'Show raw message (first message only)')
    .option('--raw-html', 'Show raw HTML body per message (no markdown conversion)')
    .action(async (threadId, options) => {
      const { client } = await getClient(options.account)

      if (options.raw && options.rawHtml) {
        out.error('--raw and --raw-html cannot be used together')
        process.exit(1)
      }

      if (options.raw) {
        const { parsed: thread } = await client.getThread({ threadId })
        if (thread.messages.length === 0) {
          out.hint('No messages in thread')
          return
        }
        const rawMsg = await client.getRawMessage({ messageId: thread.messages[0]!.id })
        if (rawMsg instanceof Error) handleCommandError(rawMsg)
        console.log(rawMsg)
        return
      }

      const { parsed: thread } = await client.getThread({ threadId })

      if (thread.messages.length === 0) {
        out.hint('No messages in thread')
        return
      }

      if (options.rawHtml) {
        thread.messages.forEach((msg, index) => {
          console.log(msg.body)
          if (index < thread.messages.length - 1) {
            console.log('\n<!-- ZELE_MESSAGE_SEPARATOR -->\n')
          }
        })
        return
      }

      const w = Math.min(process.stdout.columns || 72, 72)
      const rule = pc.dim('─'.repeat(w))

      // Render thread header
      console.log(pc.bold(thread.subject))
      // Collect unique participants
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

        // Flags as dim tags
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
    })

  // =========================================================================
  // mail send
  // =========================================================================

  cli
    .command('mail send', 'Send an email')
    .option('--to <to>', z.string().describe('Recipient email (repeatable with comma)'))
    .option('--subject <subject>', z.string().describe('Email subject'))
    .option('--body <body>', z.string().describe('Email body text'))
    .option('--body-file <bodyFile>', z.string().describe('Read body from file (use - for stdin)'))
    .option('--cc <cc>', z.string().describe('CC recipients (comma-separated)'))
    .option('--bcc <bcc>', z.string().describe('BCC recipients (comma-separated)'))
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .option('--attach <attach>', z.array(z.string()).describe('File to attach (repeatable: --attach a.pdf --attach b.png)'))
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

      if (!body) {
        out.error('--body or --body-file is required')
        process.exit(1)
      }

      // Resolve attachment file paths (one file per --attach flag)
      const attachments = options.attach
        ? options.attach.map((filePath) => {
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

      const parseEmails = (str: string) =>
        str.split(',').map((e) => e.trim()).filter(Boolean).map((email) => ({ email }))

      const { client } = await getClient(options.account)

      const result = await client.sendMessage({
        to: parseEmails(options.to),
        subject: options.subject,
        body,
        cc: options.cc ? parseEmails(options.cc) : undefined,
        bcc: options.bcc ? parseEmails(options.bcc) : undefined,
        fromEmail: options.from,
        attachments,
      })

      out.printYaml(result)
      out.success(`Sent to ${options.to}`)
    })

  // =========================================================================
  // mail reply
  // =========================================================================

  cli
    .command('mail reply <threadId>', 'Reply to an email thread')
    .option('--body <body>', z.string().describe('Reply body text'))
    .option('--body-file <bodyFile>', z.string().describe('Read body from file (use - for stdin)'))
    .option('--cc <cc>', z.string().describe('Additional CC recipients'))
    .option('--all', 'Reply all (include all original recipients)')
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .action(async (threadId, options) => {
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

      const { client } = await getClient(options.account)

      const cc = options.cc
        ? options.cc.split(',').map((e: string) => ({ email: e.trim() })).filter((e: { email: string }) => e.email)
        : undefined

      const result = await client.replyToThread({
        threadId,
        body,
        replyAll: options.all,
        cc,
        fromEmail: options.from,
      })
      if (result instanceof Error) handleCommandError(result)

      out.printYaml(result)
      out.success('Reply sent')
    })

  // =========================================================================
  // mail forward
  // =========================================================================

  cli
    .command('mail forward <threadId>', 'Forward an email thread')
    .option('--to <to>', z.string().describe('Forward recipient(s), comma-separated'))
    .option('--body <body>', z.string().describe('Optional message to prepend'))
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .action(async (threadId, options) => {
      if (!options.to) {
        out.error('--to is required')
        process.exit(1)
      }

      const recipients = options.to
        .split(',')
        .map((e: string) => ({ email: e.trim() }))
        .filter((e: { email: string }) => e.email)

      const { client } = await getClient(options.account)

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
