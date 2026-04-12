// IMAP/SMTP email client for non-Google accounts.
// Mirrors the GmailClient method signatures and return types so commands
// can work with both client types without major rewrites.
// Each IMAP operation opens a fresh connection (connect → operate → logout)
// to avoid stale connection issues. SMTP uses nodemailer transporter.
// Threading: each IMAP message is treated as a single-message "thread"
// with threadId = "folder:uid" (e.g. "INBOX:12345").

import { ImapFlow, type FetchMessageObject, type MessageEnvelopeObject, type MailboxObject } from 'imapflow'
import type { Transporter } from 'nodemailer'
import { createMimeMessage } from 'mimetext'
import * as errore from 'errore'
import { AuthError, ApiError, UnsupportedError, EmptyThreadError, NotFoundError, mapConcurrent, withRetry } from './api-utils.js'
import { renderEmailBody } from './output.js'
import type { AccountId, ImapSmtpCredentials, ImapCredentials, SmtpCredentials } from './auth.js'
import type {
  ThreadListResult,
  ThreadListItem,
  ThreadResult,
  ThreadData,
  ParsedMessage,
  WatchEvent,
  Sender,
  AttachmentMeta,
} from './gmail-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a threadId in the format "FOLDER:UID" back to folder + uid. */
function parseThreadId(threadId: string): { folder: string; uid: number } {
  const idx = threadId.lastIndexOf(':')
  if (idx === -1) return { folder: 'INBOX', uid: Number(threadId) }
  return { folder: threadId.slice(0, idx), uid: Number(threadId.slice(idx + 1)) }
}

/** Build a threadId from folder + uid. */
function makeThreadId(folder: string, uid: number): string {
  return `${folder}:${uid}`
}

/** Static fallback map from zele folder names to IMAP folder paths.
 *  Used only when specialUse discovery fails. */
const FOLDER_FALLBACKS: Record<string, string[]> = {
  sent: ['Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent'],
  trash: ['Trash', 'Deleted Items', 'Deleted Messages', 'INBOX.Trash'],
  spam: ['Junk', 'Junk Email', 'Spam', 'INBOX.Junk'],
  drafts: ['Drafts', 'Draft', 'INBOX.Drafts'],
  archive: ['Archive', 'Archives', 'All Mail', '[Gmail]/All Mail', 'INBOX.Archive'],
}

/** RFC 6154 specialUse attributes mapped to zele folder names. */
const SPECIAL_USE_MAP: Record<string, string> = {
  sent: '\\Sent',
  trash: '\\Trash',
  bin: '\\Trash',
  spam: '\\Junk',
  drafts: '\\Drafts',
  draft: '\\Drafts',
  archive: '\\Archive',
}

/** Convert imapflow address objects to our Sender type. */
function toSender(addr?: { name?: string; address?: string }): Sender {
  if (!addr) return { email: 'unknown' }
  return { name: addr.name || undefined, email: addr.address ?? 'unknown' }
}

function toSenders(addrs?: Array<{ name?: string; address?: string }>): Sender[] {
  if (!addrs || addrs.length === 0) return []
  return addrs.map(toSender)
}

/** Basic client-side query filter for watch events.
 *  Supports: from:, to:, subject:, is:unread, is:starred, has:attachment, and plain text search. */
function matchesQuery(msg: ParsedMessage, query: string): boolean {
  const lower = query.toLowerCase()

  // Handle specific operators
  const fromMatch = lower.match(/from:(\S+)/)
  if (fromMatch && !msg.from.email.toLowerCase().includes(fromMatch[1]!)) return false

  const toMatch = lower.match(/to:(\S+)/)
  if (toMatch && !msg.to.some((t) => t.email.toLowerCase().includes(toMatch[1]!))) return false

  const subjectMatch = lower.match(/subject:(?:"([^"]+)"|(\S+))/)
  if (subjectMatch) {
    const term = (subjectMatch[1] ?? subjectMatch[2])!.toLowerCase()
    if (!msg.subject.toLowerCase().includes(term)) return false
  }

  if (lower.includes('is:unread') && !msg.unread) return false
  if (lower.includes('is:starred') && !msg.starred) return false
  if (lower.includes('has:attachment') && msg.attachments.length === 0) return false

  // Plain text: strip operators and check remaining text against subject/from
  const plainText = lower
    .replace(/from:\S+/g, '')
    .replace(/to:\S+/g, '')
    .replace(/subject:(?:"[^"]+"|[^\s]+)/g, '')
    .replace(/is:\S+/g, '')
    .replace(/has:\S+/g, '')
    .trim()
  if (plainText && !msg.subject.toLowerCase().includes(plainText) && !msg.from.email.toLowerCase().includes(plainText)) {
    return false
  }

  return true
}

/** Boundary helper for imapflow calls — converts auth errors to typed values. */
function imapBoundary<T>(email: string, fn: () => Promise<T>) {
  return errore.tryAsync({
    try: fn,
    catch: (err) => {
      const msg = String(err)
      if (msg.includes('Authentication') || msg.includes('AUTHENTICATIONFAILED') || msg.includes('LOGIN') || msg.includes('Invalid credentials')) {
        return new AuthError({ email, reason: msg })
      }
      return new ApiError({ reason: msg, cause: err })
    },
  })
}

// ---------------------------------------------------------------------------
// ImapSmtpClient
// ---------------------------------------------------------------------------

export class ImapSmtpClient {
  private imapCreds: ImapCredentials | undefined
  private smtpCreds: SmtpCredentials | undefined
  private account: AccountId
  private smtpTransporter: Transporter | null = null

  constructor({ credentials, account }: { credentials: ImapSmtpCredentials; account: AccountId }) {
    this.imapCreds = credentials.imap
    this.smtpCreds = credentials.smtp
    this.account = account
  }

  // =========================================================================
  // IMAP connection helpers
  // =========================================================================

  private createImapClient(): ImapFlow {
    if (!this.imapCreds) throw new Error('IMAP not configured for this account')
    return new ImapFlow({
      host: this.imapCreds.host,
      port: this.imapCreds.port,
      secure: this.imapCreds.tls,
      auth: { user: this.imapCreds.user, pass: this.imapCreds.password },
      logger: false,
    })
  }

  /**
   * Resolve a zele folder name (inbox, sent, trash, etc.) to the actual IMAP
   * mailbox path by checking RFC 6154 specialUse attributes first, then
   * falling back to common mailbox name variants.
   */
  private async resolveMailboxPath(client: ImapFlow, folder: string): Promise<string> {
    const lower = folder.toLowerCase()
    if (lower === 'inbox') return 'INBOX'
    if (lower === 'starred' || lower === 'all') return 'INBOX'

    // Check if it's a raw IMAP path that doesn't match any known folder name
    const specialUse = SPECIAL_USE_MAP[lower]
    if (!specialUse) return folder // raw IMAP path, pass through

    // Discover via specialUse (RFC 6154)
    const mailboxes = await client.list()
    const bySpecialUse = mailboxes.find((m) => m.specialUse === specialUse)
    if (bySpecialUse) return bySpecialUse.path

    // Fallback: try common folder names
    const fallbacks = FOLDER_FALLBACKS[lower]
    if (fallbacks) {
      const paths = new Set(mailboxes.map((m) => m.path))
      for (const name of fallbacks) {
        if (paths.has(name)) return name
      }
      // Case-insensitive search as last resort
      const lowerPaths = new Map(mailboxes.map((m) => [m.path.toLowerCase(), m.path]))
      for (const name of fallbacks) {
        const found = lowerPaths.get(name.toLowerCase())
        if (found) return found
      }
    }

    // Ultimate fallback: capitalize first letter
    return folder.charAt(0).toUpperCase() + folder.slice(1)
  }

  /** Run an IMAP operation with auto-connect/logout.
   *  The entire callback is wrapped in imapBoundary so any IMAP error
   *  (getMailboxLock, search, fetch, etc.) becomes an error value. */
  private async withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T | AuthError | ApiError> {
    const client = this.createImapClient()
    const connectResult = await imapBoundary(this.account.email, () => client.connect())
    if (connectResult instanceof Error) return connectResult

    const result = await imapBoundary(this.account.email, () => fn(client))
    await client.logout().catch(() => {})
    return result
  }

  private async getSmtpTransporter(): Promise<Transporter | UnsupportedError> {
    if (this.smtpTransporter) return this.smtpTransporter
    if (!this.smtpCreds) return new UnsupportedError({ feature: 'Sending email', accountType: 'IMAP-only', hint: 'Add SMTP with: zele login imap --email ... --smtp-host ...' })
    const nodemailer = await import('nodemailer')
    this.smtpTransporter = nodemailer.default.createTransport({
      host: this.smtpCreds.host,
      port: this.smtpCreds.port,
      secure: this.smtpCreds.tls,
      auth: { user: this.smtpCreds.user, pass: this.smtpCreds.password },
    })
    return this.smtpTransporter
  }

  // =========================================================================
  // Thread operations (IMAP messages as single-message "threads")
  // =========================================================================

  async listThreads({
    query,
    folder,
    maxResults = 25,
    labelIds,
    pageToken,
  }: {
    query?: string
    folder?: string
    maxResults?: number
    labelIds?: string[]
    pageToken?: string
  } = {}): Promise<ThreadListResult | AuthError | ApiError> {
    const lowerFolder = folder?.toLowerCase()
    const isStarred = lowerFolder === 'starred'

    // IMAP has no "all mail" folder on most servers — reject explicitly
    if (lowerFolder === 'all') {
      return new UnsupportedError({
        feature: '"All Mail" folder',
        accountType: 'IMAP/SMTP',
        hint: 'Use --folder inbox, sent, trash, or another specific folder.',
      }) as unknown as ThreadListResult | AuthError | ApiError
    }

    return this.withImap(async (client) => {
      const imapFolder = await this.resolveMailboxPath(client, folder ?? 'inbox')
      const lock = await client.getMailboxLock(imapFolder)
      try {
        // Build search criteria — start with base criteria from folder
        let searchCriteria: any = isStarred ? { flagged: true } : { all: true }

        if (query) {
          // Best-effort IMAP search: translate Gmail query syntax to IMAP SEARCH.
          // Supported: from:, to:, subject:, newer_than:Nd/Nm, older_than:Nd/Nm,
          //            after:YYYY/MM/DD, before:YYYY/MM/DD, is:unread, is:starred,
          //            has:attachment, and plain text.
          // Preserve base criteria (e.g. flagged from --folder starred)
          const baseCriteria = isStarred ? { flagged: true } : {}
          searchCriteria = { ...baseCriteria }
          let hasSpecificCriteria = isStarred

          const fromMatch = query.match(/from:(\S+)/i)
          if (fromMatch) { searchCriteria.from = fromMatch[1]; hasSpecificCriteria = true }

          const toMatch = query.match(/to:(\S+)/i)
          if (toMatch) { searchCriteria.to = toMatch[1]; hasSpecificCriteria = true }

          const subjectMatch = query.match(/subject:(?:"([^"]+)"|(\S+))/i)
          if (subjectMatch) { searchCriteria.subject = subjectMatch[1] ?? subjectMatch[2]; hasSpecificCriteria = true }

          // Date filters: newer_than:2d, newer_than:1m (days/months)
          const newerMatch = query.match(/newer_than:(\d+)([dm])/i)
          if (newerMatch) {
            const n = Number(newerMatch[1])
            const unit = newerMatch[2]!.toLowerCase()
            const since = new Date()
            if (unit === 'd') since.setDate(since.getDate() - n)
            else since.setMonth(since.getMonth() - n)
            searchCriteria.since = since
            hasSpecificCriteria = true
          }

          const olderMatch = query.match(/older_than:(\d+)([dm])/i)
          if (olderMatch) {
            const n = Number(olderMatch[1])
            const unit = olderMatch[2]!.toLowerCase()
            const before = new Date()
            if (unit === 'd') before.setDate(before.getDate() - n)
            else before.setMonth(before.getMonth() - n)
            searchCriteria.before = before
            hasSpecificCriteria = true
          }

          // after:YYYY/MM/DD and before:YYYY/MM/DD
          const afterMatch = query.match(/after:(\d{4}\/\d{1,2}\/\d{1,2})/i)
          if (afterMatch) { searchCriteria.since = new Date(afterMatch[1]!.replace(/\//g, '-')); hasSpecificCriteria = true }

          const beforeMatch = query.match(/before:(\d{4}\/\d{1,2}\/\d{1,2})/i)
          if (beforeMatch) { searchCriteria.before = new Date(beforeMatch[1]!.replace(/\//g, '-')); hasSpecificCriteria = true }

          // Flag filters
          if (/is:unread/i.test(query)) { searchCriteria.unseen = true; hasSpecificCriteria = true }
          if (/is:starred/i.test(query)) { searchCriteria.flagged = true; hasSpecificCriteria = true }
          if (/has:attachment/i.test(query)) { searchCriteria.header = { 'Content-Type': 'multipart/mixed' }; hasSpecificCriteria = true }

          // Plain text remainder (strip known operators)
          const plainText = query
            .replace(/from:\S+/gi, '')
            .replace(/to:\S+/gi, '')
            .replace(/subject:(?:"[^"]+"|[^\s]+)/gi, '')
            .replace(/newer_than:\S+/gi, '')
            .replace(/older_than:\S+/gi, '')
            .replace(/after:\S+/gi, '')
            .replace(/before:\S+/gi, '')
            .replace(/is:\S+/gi, '')
            .replace(/has:\S+/gi, '')
            .trim()

          if (plainText) {
            // Search in subject and body for remaining text
            if (hasSpecificCriteria) {
              searchCriteria.body = plainText
            } else {
              searchCriteria = { or: [{ subject: plainText }, { body: plainText }] }
            }
          } else if (!hasSpecificCriteria) {
            searchCriteria = { all: true }
          }
        }

        const searchResult = await client.search(searchCriteria, { uid: true })
        const uids = searchResult === false ? [] : searchResult
        if (uids.length === 0) {
          return {
            threads: [],
            rawThreads: [],
            nextPageToken: null,
            resultSizeEstimate: 0,
          }
        }

        // Sort by UID descending (newest first) and paginate
        const sorted = [...uids].sort((a, b) => b - a)
        const startIndex = pageToken ? Number(pageToken) : 0
        const page = sorted.slice(startIndex, startIndex + maxResults)
        const nextPageToken = startIndex + maxResults < sorted.length
          ? String(startIndex + maxResults)
          : null

        // Fetch envelope data for the page
        const threads: ThreadListItem[] = []
        if (page.length > 0) {
          const uidRange = page.join(',')
          for await (const msg of client.fetch(uidRange, {
            uid: true,
            envelope: true,
            flags: true,
            bodyStructure: true,
          }, { uid: true })) {
            const env = msg.envelope
            if (!env) continue
            const flags = msg.flags ?? new Set()
            const threadId = makeThreadId(imapFolder, msg.uid)

            threads.push({
              id: threadId,
              historyId: null,
              snippet: env.subject ?? '',
              subject: env.subject ?? '(no subject)',
              from: toSender(env.from?.[0]),
              to: toSenders(env.to),
              cc: toSenders(env.cc),
              date: env.date?.toISOString() ?? new Date().toISOString(),
              labelIds: [],
              unread: !flags.has('\\Seen'),
              starred: flags.has('\\Flagged'),
              messageCount: 1,
              inReplyTo: env.inReplyTo ?? null,
              hasAttachments: this.hasAttachments(msg),
              // IMAP list view uses envelope-only fetch, so raw headers aren't
              // available. List-Unsubscribe stays null in list mode; it's
              // resolved during getThread() where `source: true` is fetched.
              listUnsubscribe: null,
              listUnsubscribePost: null,
            })
          }
        }

        // Sort by date descending (envelopes may not come in order)
        threads.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

        return {
          threads,
          rawThreads: [],
          nextPageToken,
          resultSizeEstimate: sorted.length,
        }
      } finally {
        lock.release()
      }
    }) as Promise<ThreadListResult | AuthError | ApiError>
  }

  async getThread({ threadId }: { threadId: string }): Promise<ThreadResult> {
    const { folder, uid } = parseThreadId(threadId)

    const result = await this.withImap(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        // Fetch full message with body
        let message: FetchMessageObject | null = null
        for await (const msg of client.fetch(String(uid), {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          source: true,
        }, { uid: true })) {
          message = msg
        }

        if (!message) {
          return new NotFoundError({ resource: `message ${threadId}` })
        }

        const parsed = this.parseImapMessage(message, folder)

        const threadData: ThreadData = {
          id: threadId,
          historyId: null,
          messages: [parsed],
          subject: parsed.subject,
          snippet: parsed.snippet,
          from: parsed.from,
          date: parsed.date,
          labelIds: [],
          hasUnread: parsed.unread,
          messageCount: 1,
        }

        return { parsed: threadData, raw: {} } as ThreadResult
      } finally {
        lock.release()
      }
    })

    // getThread is expected to throw on failure (same as GmailClient)
    // because callers like mail read destructure the result directly.
    if (result instanceof Error) throw result
    return result as ThreadResult
  }

  async getMessage({ messageId }: { messageId: string }): Promise<ParsedMessage | AuthError | ApiError> {
    // For IMAP, messageId is the same as threadId
    const result = await this.getThread({ threadId: messageId })
    return result.parsed.messages[0]!
  }

  async getRawMessage({ messageId }: { messageId: string }): Promise<string | NotFoundError | AuthError | ApiError> {
    const { folder, uid } = parseThreadId(messageId)

    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        for await (const msg of client.fetch(String(uid), {
          uid: true,
          source: true,
        }, { uid: true })) {
          if (msg.source) {
            return msg.source.toString('utf-8')
          }
        }
        return new NotFoundError({ resource: `message ${messageId}` })
      } finally {
        lock.release()
      }
    }) as Promise<string | NotFoundError | AuthError | ApiError>
  }

  // =========================================================================
  // Send operations (SMTP)
  // =========================================================================

  async sendMessage({
    to,
    subject,
    body,
    cc,
    bcc,
    inReplyTo,
    references,
    attachments,
  }: {
    to: Array<{ name?: string; email: string }>
    subject: string
    body: string
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    threadId?: string
    inReplyTo?: string
    references?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
    fromEmail?: string
  }): Promise<{ id: string; threadId: string; labelIds: string[] } | UnsupportedError | AuthError | ApiError> {
    const transporter = await this.getSmtpTransporter()
    if (transporter instanceof Error) return transporter
    const fromEmail = this.account.email

    const mailOptions: any = {
      from: fromEmail,
      to: to.map((r) => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', '),
      subject,
      text: body,
    }

    if (cc && cc.length > 0) {
      mailOptions.cc = cc.map((r) => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', ')
    }
    if (bcc && bcc.length > 0) {
      mailOptions.bcc = bcc.map((r) => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', ')
    }
    if (inReplyTo) {
      mailOptions.inReplyTo = inReplyTo
    }
    if (references) {
      mailOptions.references = references
    }
    if (attachments && attachments.length > 0) {
      mailOptions.attachments = attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.mimeType,
      }))
    }

    const sendResult = await transporter.sendMail(mailOptions)
      .catch((e: unknown) => new ApiError({ reason: `SMTP send failed: ${String(e)}`, cause: e as Error }))
    if (sendResult instanceof Error) return sendResult as ApiError

    // APPEND a copy to the Sent folder so `mail list --folder sent` shows it.
    // SMTP alone doesn't guarantee a copy in the mailbox.
    // Build the raw MIME using nodemailer's MailComposer so attachments, HTML, etc. are preserved.
    if (this.imapCreds) {
      const nodemailer = await import('nodemailer')
      const MailComposer = (nodemailer as any).default?.MailComposer ?? (nodemailer as any).MailComposer
      const rawMime: Buffer | ApiError = MailComposer
        ? await new Promise<Buffer>((resolve, reject) => {
            const mail = new MailComposer({ ...mailOptions, messageId: sendResult.messageId })
            mail.compile().build((err: Error | null, message: Buffer) => {
              if (err) reject(err)
              else resolve(message)
            })
          }).catch((e: unknown) => new ApiError({ reason: `Failed to compile MIME for Sent copy: ${String(e)}`, cause: e as Error }))
        : (() => {
            // Fallback: build plain-text RFC 822 if MailComposer unavailable
            const rawHeaders = [
              `From: ${fromEmail}`,
              `To: ${mailOptions.to}`,
              `Subject: ${subject}`,
              `Date: ${new Date().toUTCString()}`,
              `MIME-Version: 1.0`,
              `Content-Type: text/plain; charset=utf-8`,
              ...(mailOptions.cc ? [`Cc: ${mailOptions.cc}`] : []),
              ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
              ...(references ? [`References: ${references}`] : []),
              ...(sendResult.messageId ? [`Message-ID: ${sendResult.messageId}`] : []),
            ]
            return Buffer.from(rawHeaders.join('\r\n') + '\r\n\r\n' + body)
          })()

      if (rawMime instanceof Error) {
        console.warn('Failed to build MIME for Sent copy:', rawMime.message)
      } else {
        const appendResult = await this.withImap(async (client) => {
          const sentPath = await this.resolveMailboxPath(client, 'sent')
          await client.append(sentPath, rawMime, ['\\Seen'])
        })
        if (appendResult instanceof Error) {
          console.warn('Sent message but failed to save to Sent folder:', appendResult.message)
        }
      }
    }

    return {
      id: sendResult.messageId ?? 'unknown',
      threadId: 'unknown',
      labelIds: ['SENT'],
    }
  }

  async replyToThread({
    threadId,
    body,
    replyAll = false,
    cc,
    fromEmail,
  }: {
    threadId: string
    body: string
    replyAll?: boolean
    cc?: Array<{ email: string }>
    fromEmail?: string
  }): Promise<EmptyThreadError | UnsupportedError | AuthError | ApiError | { id: string; threadId: string; labelIds: string[] }> {
    const thread = await this.getThread({ threadId })
    if (thread.parsed.messages.length === 0) {
      return new EmptyThreadError({ threadId })
    }

    const lastMsg = thread.parsed.messages[thread.parsed.messages.length - 1]!
    const replyTo = lastMsg.replyTo ?? lastMsg.from.email
    const to = [{ email: replyTo }]

    let resolvedCc: Array<{ email: string }> | undefined
    if (replyAll) {
      const myEmail = this.account.email.toLowerCase()
      const allRecipients = [
        ...lastMsg.to.map((r) => r.email),
        ...(lastMsg.cc?.map((r) => r.email) ?? []),
      ]
        .filter((e) => e.toLowerCase() !== myEmail)
        .filter((e) => e.toLowerCase() !== replyTo.toLowerCase())

      if (allRecipients.length > 0) {
        resolvedCc = allRecipients.map((e) => ({ email: e }))
      }
    }

    if (cc) {
      resolvedCc = [...(resolvedCc ?? []), ...cc]
    }

    const refs = [lastMsg.references, lastMsg.messageId].filter(Boolean).join(' ')

    return this.sendMessage({
      to,
      subject: lastMsg.subject.startsWith('Re:') ? lastMsg.subject : `Re: ${lastMsg.subject}`,
      body,
      cc: resolvedCc,
      inReplyTo: lastMsg.messageId,
      references: refs || undefined,
    })
  }

  async forwardThread({
    threadId,
    to,
    body,
    fromEmail,
  }: {
    threadId: string
    to: Array<{ email: string }>
    body?: string
    fromEmail?: string
  }): Promise<EmptyThreadError | UnsupportedError | AuthError | ApiError | { id: string; threadId: string; labelIds: string[] }> {
    const thread = await this.getThread({ threadId })
    if (thread.parsed.messages.length === 0) {
      return new EmptyThreadError({ threadId })
    }

    const lastMsg = thread.parsed.messages[thread.parsed.messages.length - 1]!
    const renderedBody = renderEmailBody(lastMsg.body, lastMsg.mimeType)

    const fromStr = lastMsg.from.name && lastMsg.from.name !== lastMsg.from.email
      ? `${lastMsg.from.name} <${lastMsg.from.email}>`
      : lastMsg.from.email

    const fullBody = [
      body ?? '',
      '',
      '---------- Forwarded message ----------',
      `From: ${fromStr}`,
      `Date: ${lastMsg.date}`,
      `Subject: ${lastMsg.subject}`,
      `To: ${lastMsg.to.map((t) => t.email).join(', ')}`,
      '',
      renderedBody,
    ].join('\n')

    return this.sendMessage({
      to,
      subject: `Fwd: ${lastMsg.subject}`,
      body: fullBody,
    })
  }

  // =========================================================================
  // Flag operations (IMAP STORE)
  // =========================================================================

  async star({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    return this.modifyFlags(threadIds, { add: ['\\Flagged'] })
  }

  async unstar({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    return this.modifyFlags(threadIds, { remove: ['\\Flagged'] })
  }

  async markAsRead({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    return this.modifyFlags(threadIds, { add: ['\\Seen'] })
  }

  async markAsUnread({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    return this.modifyFlags(threadIds, { remove: ['\\Seen'] })
  }

  async trash({ threadId }: { threadId: string }): Promise<void | AuthError | ApiError> {
    const { folder, uid } = parseThreadId(threadId)
    return this.withImap(async (client) => {
      const trashPath = await this.resolveMailboxPath(client, 'trash')
      const lock = await client.getMailboxLock(folder)
      try {
        const moved = await errore.tryAsync({
          try: () => client.messageMove(String(uid), trashPath, { uid: true }),
          catch: (err) => new ApiError({ reason: `Failed to move to Trash: ${String(err)}`, cause: err }),
        })
        if (moved instanceof Error) {
          // Fallback: set \Deleted flag
          await client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true })
        }
      } finally {
        lock.release()
      }
    }) as Promise<void | AuthError | ApiError>
  }

  async untrash({ threadId }: { threadId: string }): Promise<void | AuthError | ApiError> {
    const { folder, uid } = parseThreadId(threadId)
    // Move from whatever folder back to INBOX
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        await client.messageMove(String(uid), 'INBOX', { uid: true })
      } finally {
        lock.release()
      }
    }) as Promise<void | AuthError | ApiError>
  }

  async archive({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    for (const threadId of threadIds) {
      const { folder, uid } = parseThreadId(threadId)
      const result = await this.withImap(async (client) => {
        const archivePath = await this.resolveMailboxPath(client, 'archive')
        const lock = await client.getMailboxLock(folder)
        try {
          const moved = await errore.tryAsync({
            try: () => client.messageMove(String(uid), archivePath, { uid: true }),
            catch: (err) => new ApiError({ reason: `Failed to move to Archive: ${String(err)}`, cause: err }),
          })
          if (moved instanceof Error) {
            // No archive folder available — mark as read as a minimal archive behavior
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
          }
        } finally {
          lock.release()
        }
      })
      if (result instanceof Error) return result
    }
  }

  async markAsSpam({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    for (const threadId of threadIds) {
      const { folder, uid } = parseThreadId(threadId)
      const result = await this.withImap(async (client) => {
        const junkPath = await this.resolveMailboxPath(client, 'spam')
        const lock = await client.getMailboxLock(folder)
        try {
          const moveResult = await errore.tryAsync({
            try: () => client.messageMove(String(uid), junkPath, { uid: true }),
            catch: (err) => new ApiError({ reason: `Failed to move to Junk: ${String(err)}`, cause: err }),
          })
          if (moveResult instanceof Error) {
            // Fallback: set $Junk keyword
            await client.messageFlagsAdd(String(uid), ['$Junk'], { uid: true })
          }
        } finally {
          lock.release()
        }
      })
      if (result instanceof Error) return result
    }
  }

  async unmarkSpam({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    for (const threadId of threadIds) {
      const { folder, uid } = parseThreadId(threadId)
      const result = await this.withImap(async (client) => {
        const lock = await client.getMailboxLock(folder)
        try {
          await client.messageMove(String(uid), 'INBOX', { uid: true })
        } finally {
          lock.release()
        }
      })
      if (result instanceof Error) return result
    }
  }

  async trashAllSpam(): Promise<{ count: number } | AuthError | ApiError> {
    return this.withImap(async (client) => {
      const junkPath = await this.resolveMailboxPath(client, 'spam')
      const lock = await client.getMailboxLock(junkPath)
      try {
        const searchResult = await client.search({ all: true }, { uid: true })
        const uids = searchResult === false ? [] : searchResult
        if (uids.length === 0) return { count: 0 }
        // Move all to Trash
        const uidRange = uids.join(',')
        const trashPath = await this.resolveMailboxPath(client, 'trash')
        const moveResult = await errore.tryAsync({
          try: () => client.messageMove(uidRange, trashPath, { uid: true }),
          catch: (err) => new ApiError({ reason: `Failed to move spam to Trash: ${String(err)}`, cause: err }),
        })
        if (moveResult instanceof Error) {
          await client.messageFlagsAdd(uidRange, ['\\Deleted'], { uid: true })
        }
        return { count: uids.length }
      } finally {
        lock.release()
      }
    }) as Promise<{ count: number } | AuthError | ApiError>
  }

  // =========================================================================
  // Label operations (not supported for IMAP)
  // =========================================================================

  async listLabels(): Promise<UnsupportedError> {
    return new UnsupportedError({
      feature: 'Labels',
      accountType: 'IMAP/SMTP',
      hint: 'IMAP accounts use folders. Use --folder to browse different mailboxes.',
    })
  }

  async modifyLabels(_opts: { threadIds: string[]; addLabelIds: string[]; removeLabelIds: string[] }): Promise<UnsupportedError> {
    return new UnsupportedError({
      feature: 'Label modification',
      accountType: 'IMAP/SMTP',
      hint: 'IMAP accounts use folders, not labels.',
    })
  }

  // =========================================================================
  // Profile
  // =========================================================================

  async getProfile(): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string } | AuthError | ApiError> {
    // For IMAP, we can get basic info but not Gmail-specific stats
    return {
      emailAddress: this.account.email,
      messagesTotal: 0,
      threadsTotal: 0,
      historyId: '0',
    }
  }

  async getEmailAliases(): Promise<Array<{ email: string; name?: string; primary: boolean }> | AuthError | ApiError> {
    // IMAP doesn't have send-as aliases
    return [{ email: this.account.email, primary: true }]
  }

  // =========================================================================
  // Attachment operations
  // =========================================================================

  async getAttachment({ messageId, attachmentId }: { messageId: string; attachmentId: string }): Promise<string | NotFoundError | AuthError | ApiError> {
    const { folder, uid } = parseThreadId(messageId)

    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        // attachmentId is the MIME part number (e.g. "2", "1.2")
        for await (const msg of client.fetch(String(uid), {
          uid: true,
          bodyParts: [attachmentId],
        }, { uid: true })) {
          const parts = msg.bodyParts
          if (parts) {
            for (const [_key, value] of parts) {
              return value.toString('base64')
            }
          }
        }
        return new NotFoundError({ resource: `attachment ${attachmentId} in message ${messageId}` })
      } finally {
        lock.release()
      }
    }) as Promise<string | NotFoundError | AuthError | ApiError>
  }

  // =========================================================================
  // Watch (IMAP polling — simplified version without IDLE)
  // =========================================================================

  async *watchInbox({
    folder = 'inbox',
    intervalMs = 15_000,
    query,
    once = false,
  }: {
    folder?: string
    intervalMs?: number
    query?: string
    once?: boolean
  } = {}): AsyncGenerator<WatchEvent> {
    // Resolve folder path once (use a fresh connection)
    let imapFolder = 'INBOX'
    const resolveResult = await this.withImap(async (client) => {
      return this.resolveMailboxPath(client, folder)
    })
    if (resolveResult instanceof Error) throw resolveResult
    imapFolder = resolveResult as string

    let lastUid = 0

    // Seed with current highest UID
    const seedResult = await this.withImap(async (client) => {
      const lock = await client.getMailboxLock(imapFolder)
      try {
        const searchResult = await client.search({ all: true }, { uid: true })
        const uids = searchResult === false ? [] : searchResult
        return uids.length > 0 ? Math.max(...uids) : 0
      } finally {
        lock.release()
      }
    })
    if (seedResult instanceof Error) throw seedResult
    lastUid = seedResult as number

    while (true) {
      // Check for new messages since lastUid
      const pollResult = await this.withImap(async (client) => {
        const lock = await client.getMailboxLock(imapFolder)
        try {
          // Search for UIDs > lastUid
          const searchResult = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })
          const uids = searchResult === false ? [] : searchResult
          const newUids = uids.filter((u) => u > lastUid)

          const events: WatchEvent[] = []
          if (newUids.length > 0) {
            const uidRange = newUids.join(',')
            for await (const msg of client.fetch(uidRange, {
              uid: true,
              envelope: true,
              flags: true,
              source: true,
            }, { uid: true })) {
              const parsed = this.parseImapMessage(msg, imapFolder)
              events.push({
                account: this.account,
                type: 'new_message',
                message: parsed,
                threadId: makeThreadId(imapFolder, msg.uid),
              })
              if (msg.uid > lastUid) lastUid = msg.uid
            }
          }
          return events
        } finally {
          lock.release()
        }
      })

      if (pollResult instanceof Error) throw pollResult
      for (const event of pollResult as WatchEvent[]) {
        // Client-side query filtering (basic: from:, to:, subject:, is:unread, is:starred)
        if (query && !matchesQuery(event.message, query)) continue
        yield event
      }

      if (once) return
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  // =========================================================================
  // Draft operations (IMAP Drafts folder)
  // =========================================================================

  async listDrafts({
    query,
    maxResults = 20,
    pageToken,
  }: {
    query?: string
    maxResults?: number
    pageToken?: string
  } = {}): Promise<{ drafts: Array<{ id: string; subject: string; to: string[]; date: string }>; nextPageToken: string | null } | AuthError | ApiError> {
    return this.withImap(async (client) => {
      const draftsPath = await this.resolveMailboxPath(client, 'drafts')
      const lock = await client.getMailboxLock(draftsPath)
      try {
        const searchCriteria = query ? { or: [{ subject: query }, { body: query }] } : { all: true }
        const searchResult = await client.search(searchCriteria as any, { uid: true })
        const uids = searchResult === false ? [] : searchResult

        const sorted = [...uids].sort((a, b) => b - a)
        const startIndex = pageToken ? Number(pageToken) : 0
        const page = sorted.slice(startIndex, startIndex + maxResults)
        const nextPageToken = startIndex + maxResults < sorted.length ? String(startIndex + maxResults) : null

        const drafts: Array<{ id: string; subject: string; to: string[]; date: string }> = []
        if (page.length > 0) {
          const uidRange = page.join(',')
          for await (const msg of client.fetch(uidRange, {
            uid: true,
            envelope: true,
          }, { uid: true })) {
            const env = msg.envelope
            if (!env) continue
            drafts.push({
              id: makeThreadId(draftsPath, msg.uid),
              subject: env.subject ?? '(no subject)',
              to: (env.to ?? []).map((a) => a.address ?? '').filter(Boolean),
              date: env.date?.toISOString() ?? new Date().toISOString(),
            })
          }
        }

        return { drafts, nextPageToken }
      } finally {
        lock.release()
      }
    }) as Promise<{ drafts: Array<{ id: string; subject: string; to: string[]; date: string }>; nextPageToken: string | null } | AuthError | ApiError>
  }

  async createDraft({
    to,
    subject,
    body,
    cc,
    bcc,
    threadId,
    fromEmail,
  }: {
    to: Array<{ name?: string; email: string }>
    subject: string
    body: string
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    threadId?: string
    fromEmail?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
  }) {
    // Build MIME message and APPEND to Drafts folder
    const headers = [
      `From: ${fromEmail ?? this.account.email}`,
      `To: ${to.map((r) => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', ')}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
    ]
    if (cc && cc.length > 0) {
      headers.push(`Cc: ${cc.map((r) => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', ')}`)
    }
    if (bcc && bcc.length > 0) {
      headers.push(`Bcc: ${bcc.map((r) => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', ')}`)
    }

    const raw = headers.join('\r\n') + '\r\n\r\n' + body
    const rawBuffer = Buffer.from(raw)

    const result = await this.withImap(async (client) => {
      const draftsPath = await this.resolveMailboxPath(client, 'drafts')
      const appendResult = await client.append(draftsPath, rawBuffer, ['\\Draft', '\\Seen'])
      const uid = appendResult && typeof appendResult === 'object' && 'uid' in appendResult ? appendResult.uid : undefined
      return {
        id: uid ? makeThreadId(draftsPath, uid) : 'unknown',
        message: { id: 'unknown' },
        threadId: uid ? makeThreadId(draftsPath, uid) : 'unknown',
      }
    })
    if (result instanceof Error) throw result
    return result
  }

  async getDraft({ draftId }: { draftId: string }) {
    // Reuse getThread to fetch the full message from Drafts folder
    const result = await this.getThread({ threadId: draftId })
    const msg = result.parsed.messages[0]!
    return {
      id: draftId,
      message: msg,
      to: msg.to,
      cc: msg.cc ?? [],
      bcc: msg.bcc,
    }
  }

  async sendDraft({ draftId }: { draftId: string }) {
    // Fetch the draft message, send it via SMTP, then delete the draft
    const draft = await this.getDraft({ draftId })

    const result = await this.sendMessage({
      to: draft.to,
      subject: draft.message.subject,
      body: draft.message.body,
      cc: draft.cc.length > 0 ? draft.cc : undefined,
      bcc: draft.bcc.length > 0 ? draft.bcc : undefined,
    })
    if (result instanceof Error) return result

    // Delete the draft after sending
    await this.deleteDraft({ draftId })

    return result
  }

  async deleteDraft({ draftId }: { draftId: string }) {
    const { folder, uid } = parseThreadId(draftId)
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        await client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true })
        await client.messageDelete(String(uid), { uid: true })
      } finally {
        lock.release()
      }
    })
  }

  /**
   * Update an existing draft. IMAP has no native update — we delete the old
   * draft and APPEND a new message to the Drafts folder.
   */
  async updateDraft({
    draftId,
    to,
    subject,
    body,
    cc,
    bcc,
    fromEmail,
  }: {
    draftId: string
    to: Array<{ name?: string; email: string }>
    subject: string
    body: string
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    threadId?: string
    fromEmail?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
  }) {
    // Delete old draft first — check for errors before creating replacement
    const deleted = await this.deleteDraft({ draftId })
    if (deleted instanceof Error) return deleted

    // Create new draft with updated content
    return this.createDraft({ to, subject, body, cc, bcc, fromEmail })
  }

  /**
   * Create a draft reply to a thread. Resolves reply-to, reply-all CCs,
   * and sets In-Reply-To/References headers, then appends to Drafts.
   */
  async createDraftReply({
    threadId,
    body,
    replyAll = false,
    cc,
    fromEmail,
  }: {
    threadId: string
    body: string
    replyAll?: boolean
    cc?: Array<{ email: string }>
    fromEmail?: string
  }): Promise<EmptyThreadError | AuthError | ApiError | { id: string; message: { id: string }; threadId: string }> {
    const thread = await this.getThread({ threadId })
    if (thread.parsed.messages.length === 0) {
      return new EmptyThreadError({ threadId })
    }

    const lastMsg = thread.parsed.messages[thread.parsed.messages.length - 1]!
    const replyTo = lastMsg.replyTo ?? lastMsg.from.email
    const to = [{ email: replyTo }]

    let resolvedCc: Array<{ email: string }> | undefined
    if (replyAll) {
      const myEmail = this.account.email.toLowerCase()
      const allRecipients = [
        ...lastMsg.to.map((r) => r.email),
        ...(lastMsg.cc?.map((r) => r.email) ?? []),
      ]
        .filter((e) => e.toLowerCase() !== myEmail)
        .filter((e) => e.toLowerCase() !== replyTo.toLowerCase())

      if (allRecipients.length > 0) {
        resolvedCc = allRecipients.map((e) => ({ email: e }))
      }
    }

    if (cc) {
      resolvedCc = [...(resolvedCc ?? []), ...cc]
    }

    const refs = [lastMsg.references, lastMsg.messageId].filter(Boolean).join(' ')
    const subject = lastMsg.subject.startsWith('Re:') ? lastMsg.subject : `Re: ${lastMsg.subject}`

    // Build MIME with reply headers
    const headers = [
      `From: ${fromEmail ?? this.account.email}`,
      `To: ${to.map((r) => r.email).join(', ')}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
    ]
    if (resolvedCc && resolvedCc.length > 0) {
      headers.push(`Cc: ${resolvedCc.map((r) => r.email).join(', ')}`)
    }
    if (lastMsg.messageId) {
      headers.push(`In-Reply-To: ${lastMsg.messageId}`)
    }
    if (refs) {
      headers.push(`References: ${refs}`)
    }

    const raw = headers.join('\r\n') + '\r\n\r\n' + body
    const rawBuffer = Buffer.from(raw)

    const result = await this.withImap(async (client) => {
      const draftsPath = await this.resolveMailboxPath(client, 'drafts')
      const appendResult = await client.append(draftsPath, rawBuffer, ['\\Draft', '\\Seen'])
      const uid = appendResult && typeof appendResult === 'object' && 'uid' in appendResult ? appendResult.uid : undefined
      return {
        id: uid ? makeThreadId(draftsPath, uid) : 'unknown',
        message: { id: 'unknown' },
        threadId: uid ? makeThreadId(draftsPath, uid) : 'unknown',
      }
    })
    if (result instanceof Error) return result
    return result
  }

  /**
   * Create a draft forwarding a thread. Builds the forwarded-message body
   * and appends to Drafts folder.
   */
  async createDraftForward({
    threadId,
    to,
    body,
    fromEmail,
  }: {
    threadId: string
    to: Array<{ email: string }>
    body?: string
    fromEmail?: string
  }): Promise<EmptyThreadError | AuthError | ApiError | { id: string; message: { id: string }; threadId: string }> {
    const thread = await this.getThread({ threadId })
    if (thread.parsed.messages.length === 0) {
      return new EmptyThreadError({ threadId })
    }

    const lastMsg = thread.parsed.messages[thread.parsed.messages.length - 1]!
    const renderedBody = renderEmailBody(lastMsg.body, lastMsg.mimeType)

    const fromStr = lastMsg.from.name && lastMsg.from.name !== lastMsg.from.email
      ? `${lastMsg.from.name} <${lastMsg.from.email}>`
      : lastMsg.from.email

    const fullBody = [
      body ?? '',
      '',
      '---------- Forwarded message ----------',
      `From: ${fromStr}`,
      `Date: ${lastMsg.date}`,
      `Subject: ${lastMsg.subject}`,
      `To: ${lastMsg.to.map((t) => t.email).join(', ')}`,
      '',
      renderedBody,
    ].join('\n')

    return this.createDraft({
      to,
      subject: `Fwd: ${lastMsg.subject}`,
      body: fullBody,
      fromEmail,
    })
  }

  // =========================================================================
  // Folder listing (IMAP equivalent of labels)
  // =========================================================================

  async listFolders(): Promise<Array<{ name: string; path: string; specialUse?: string; flags: string[] }> | AuthError | ApiError> {
    return this.withImap(async (client) => {
      const mailboxes = await client.list()
      return mailboxes.map((m) => ({
        name: m.name,
        path: m.path,
        specialUse: m.specialUse ?? undefined,
        flags: Array.from(m.flags),
      }))
    }) as Promise<Array<{ name: string; path: string; specialUse?: string; flags: string[] }> | AuthError | ApiError>
  }

  // =========================================================================
  // Cache stubs (no-op for IMAP — no local thread cache)
  // =========================================================================

  async invalidateThreads(_threadIds: string[]): Promise<void> {}
  async invalidateThread(_threadId: string): Promise<void> {}

  // =========================================================================
  // Private helpers
  // =========================================================================

  /** Modify IMAP flags on messages. Groups by folder for efficiency. */
  private async modifyFlags(
    threadIds: string[],
    opts: { add?: string[]; remove?: string[] },
  ): Promise<void | AuthError | ApiError> {
    // Group by folder
    const byFolder = new Map<string, number[]>()
    for (const threadId of threadIds) {
      const { folder, uid } = parseThreadId(threadId)
      const uids = byFolder.get(folder) ?? []
      uids.push(uid)
      byFolder.set(folder, uids)
    }

    for (const [folder, uids] of byFolder) {
      const result = await this.withImap(async (client) => {
        const lock = await client.getMailboxLock(folder)
        try {
          const uidRange = uids.join(',')
          if (opts.add && opts.add.length > 0) {
            await client.messageFlagsAdd(uidRange, opts.add, { uid: true })
          }
          if (opts.remove && opts.remove.length > 0) {
            await client.messageFlagsRemove(uidRange, opts.remove, { uid: true })
          }
        } finally {
          lock.release()
        }
      })
      if (result instanceof Error) return result
    }
  }

  /** Check if a message has attachments from its bodyStructure. */
  private hasAttachments(msg: FetchMessageObject): boolean {
    const bs = msg.bodyStructure
    if (!bs) return false
    // Check for non-inline parts
    const check = (part: any): boolean => {
      if (part.disposition === 'attachment') return true
      if (part.childNodes) return part.childNodes.some(check)
      return false
    }
    return check(bs)
  }

  /** Parse an imapflow FetchMessageObject into our ParsedMessage type. */
  private parseImapMessage(msg: FetchMessageObject, folder: string): ParsedMessage {
    const env = msg.envelope ?? {} as Partial<MessageEnvelopeObject>
    const flags = msg.flags ?? new Set()
    const threadId = makeThreadId(folder, msg.uid)

    // Extract body from source if available
    let body = ''
    let mimeType = 'text/plain'
    let textBody: string | null = null
    let listUnsubscribe: string | undefined
    let listUnsubscribePost: string | undefined

    if (msg.source) {
      const source = msg.source.toString('utf-8')
      const bodyResult = this.extractBodyFromSource(source)
      body = bodyResult.body
      mimeType = bodyResult.mimeType
      textBody = bodyResult.textBody

      // Extract List-Unsubscribe / List-Unsubscribe-Post from raw MIME headers.
      // envelope-based fetches don't surface these, but getThread always fetches
      // source so it's available by the time we parse a full message.
      const headerEnd = source.indexOf('\r\n\r\n')
      const altEnd = source.indexOf('\n\n')
      const headerSplit = headerEnd !== -1 ? headerEnd : altEnd
      const headerText = headerSplit === -1 ? source : source.slice(0, headerSplit)
      listUnsubscribe = this.getHeader(headerText, 'list-unsubscribe')
      listUnsubscribePost = this.getHeader(headerText, 'list-unsubscribe-post')
    }

    // Extract attachments from bodyStructure
    const attachments: AttachmentMeta[] = []
    if (msg.bodyStructure) {
      this.collectAttachments(msg.bodyStructure, '', attachments)
    }

    return {
      id: threadId,
      threadId,
      subject: env.subject ?? '(no subject)',
      snippet: (env.subject ?? '').slice(0, 100),
      from: toSender(env.from?.[0]),
      to: toSenders(env.to),
      cc: env.cc ? toSenders(env.cc) : null,
      bcc: toSenders(env.bcc),
      replyTo: env.replyTo?.[0]?.address,
      date: env.date?.toISOString() ?? new Date().toISOString(),
      labelIds: [],
      unread: !flags.has('\\Seen'),
      starred: flags.has('\\Flagged'),
      isDraft: flags.has('\\Draft'),
      messageId: env.messageId ?? '',
      inReplyTo: env.inReplyTo,
      references: undefined,
      listUnsubscribe,
      listUnsubscribePost,
      body,
      mimeType,
      textBody,
      attachments,
      auth: null, // IMAP doesn't provide SPF/DKIM/DMARC
    }
  }

  /** Extract body text from raw RFC 2822 source. */
  private extractBodyFromSource(source: string): { body: string; mimeType: string; textBody: string | null } {
    // Find the boundary between headers and body
    const headerEnd = source.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      const altEnd = source.indexOf('\n\n')
      if (altEnd === -1) return { body: '', mimeType: 'text/plain', textBody: null }
      return this.parseBody(source.slice(altEnd + 2), source.slice(0, altEnd))
    }
    return this.parseBody(source.slice(headerEnd + 4), source.slice(0, headerEnd))
  }

  private parseBody(bodyContent: string, headers: string): { body: string; mimeType: string; textBody: string | null } {
    const contentType = this.getHeader(headers, 'content-type') ?? 'text/plain'
    const transferEncoding = this.getHeader(headers, 'content-transfer-encoding') ?? '7bit'

    // Check if multipart
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i)
    if (boundaryMatch) {
      const boundary = boundaryMatch[1]!
      return this.parseMultipart(bodyContent, boundary)
    }

    // Single-part body
    let decoded = this.decodeTransferEncoding(bodyContent, transferEncoding)
    const charsetMatch = contentType.match(/charset="?([^";\s]+)"?/i)
    if (charsetMatch) {
      // Already UTF-8 string, but note the charset for future handling
    }

    const isHtml = contentType.toLowerCase().includes('text/html')
    return {
      body: decoded,
      mimeType: isHtml ? 'text/html' : 'text/plain',
      textBody: isHtml ? null : decoded,
    }
  }

  private parseMultipart(body: string, boundary: string): { body: string; mimeType: string; textBody: string | null } {
    const parts = body.split(`--${boundary}`)
    let htmlBody: string | null = null
    let textBody: string | null = null

    for (const part of parts) {
      if (part.trim() === '--' || part.trim() === '') continue

      const partHeaderEnd = part.indexOf('\r\n\r\n')
      const altEnd = part.indexOf('\n\n')
      const splitPos = partHeaderEnd !== -1 ? partHeaderEnd : altEnd
      if (splitPos === -1) continue

      const partHeaders = part.slice(0, splitPos)
      const partBody = part.slice(splitPos + (partHeaderEnd !== -1 ? 4 : 2))
      const partContentType = this.getHeader(partHeaders, 'content-type') ?? 'text/plain'
      const partEncoding = this.getHeader(partHeaders, 'content-transfer-encoding') ?? '7bit'

      // Recursive multipart
      const nestedBoundary = partContentType.match(/boundary="?([^";\s]+)"?/i)
      if (nestedBoundary) {
        const nested = this.parseMultipart(partBody, nestedBoundary[1]!)
        if (nested.mimeType === 'text/html') htmlBody = nested.body
        if (nested.textBody) textBody = nested.textBody
        continue
      }

      const decoded = this.decodeTransferEncoding(partBody, partEncoding)

      if (partContentType.toLowerCase().includes('text/html')) {
        htmlBody = decoded
      } else if (partContentType.toLowerCase().includes('text/plain')) {
        textBody = decoded
      }
    }

    // Prefer HTML, fall back to text
    if (htmlBody) return { body: htmlBody, mimeType: 'text/html', textBody }
    if (textBody) return { body: textBody, mimeType: 'text/plain', textBody }
    return { body: '', mimeType: 'text/plain', textBody: null }
  }

  private decodeTransferEncoding(content: string, encoding: string): string {
    const enc = encoding.toLowerCase().trim()
    if (enc === 'base64') {
      return Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf-8')
    }
    if (enc === 'quoted-printable') {
      return content
        .replace(/=\r?\n/g, '') // Soft line breaks
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    }
    return content
  }

  private getHeader(headers: string, name: string): string | undefined {
    const regex = new RegExp(`^${name}:\\s*(.+?)$`, 'im')
    const match = headers.match(regex)
    if (!match) return undefined
    // Handle folded headers (continuation lines starting with whitespace)
    let value = match[1]!.trim()
    const lines = headers.split(/\r?\n/)
    let found = false
    for (const line of lines) {
      if (found && /^\s/.test(line)) {
        value += ' ' + line.trim()
      } else if (line.toLowerCase().startsWith(name.toLowerCase() + ':')) {
        found = true
      } else if (found) {
        break
      }
    }
    return value
  }

  /** Recursively collect attachment metadata from bodyStructure. */
  private collectAttachments(part: any, prefix: string, attachments: AttachmentMeta[]): void {
    if (part.disposition === 'attachment' || (part.disposition === 'inline' && part.parameters?.name)) {
      attachments.push({
        attachmentId: part.part ?? prefix,
        filename: part.dispositionParameters?.filename ?? part.parameters?.name ?? 'attachment',
        mimeType: part.type ?? 'application/octet-stream',
        size: part.size ?? 0,
      })
    }
    if (part.childNodes) {
      for (let i = 0; i < part.childNodes.length; i++) {
        this.collectAttachments(part.childNodes[i], prefix ? `${prefix}.${i + 1}` : String(i + 1), attachments)
      }
    }
  }
}
