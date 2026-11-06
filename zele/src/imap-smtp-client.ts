// IMAP/SMTP email client for non-Google accounts, including Outlook XOAUTH2.
// Mirrors the GmailClient method signatures and return types so commands
// can work with both client types without major rewrites.
// Each IMAP operation opens a fresh connection (connect → operate → logout)
// to avoid stale connection issues. SMTP uses nodemailer transporter.
// Threading: each IMAP message is treated as a single-message "thread"
// with threadId = "folder:uid" (e.g. "INBOX:12345").

import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { ImapFlow, type FetchMessageObject, type MessageEnvelopeObject, type MailboxObject } from 'imapflow'
import type { Transporter } from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import { createMimeMessage } from 'mimetext'
import * as errore from 'errore'
import { AuthError, ApiError, UnsupportedError, EmptyThreadError, NotFoundError, SelfRecipientError, AmbiguousRecipientError, UnseenLatestError, mapConcurrent, withRetry, abortableSleep } from './api-utils.js'
import { buildOutgoingMime, downloadAttachments, resolveReplyRecipients, replySubject, threadAnchor, checkThreadLatestSeen, type SentInThread, type ThreadReplyEnvelope } from './email-utils.js'
import { renderEmailBody } from './output.js'
import type { AccountId, ImapSmtpCredentials } from './auth.js'
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

// Keep MIME bytes intact until transfer decoding is complete and the charset is known.
export function decodeQuotedPrintable(content: string): Buffer {
  const softBreakStripped = content.replace(/=\r?\n/g, '')
  const bytes: number[] = []

  for (let i = 0; i < softBreakStripped.length; i++) {
    const ch = softBreakStripped[i]!
    if (ch === '=') {
      const hex = softBreakStripped.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
        continue
      }
    }
    bytes.push(softBreakStripped.charCodeAt(i))
  }
  return Buffer.from(bytes)
}

export function decodeBodyCharset(body: Buffer, charset: string | undefined): string {
  const decoder = errore.tryFn({
    try: () => new TextDecoder(charset ?? 'utf-8'),
    catch: (cause) => new ApiError({ reason: `Unsupported MIME charset: ${charset}`, cause }),
  })
  if (decoder instanceof Error) {
    console.warn(`${decoder.message}; decoding as UTF-8`)
    return body.toString('utf-8')
  }
  return decoder.decode(body)
}

/** TLS options from stored CA / insecure flags. */
export function tlsSocketOptions(creds: { ca?: string; insecure?: boolean }): { ca?: string[]; rejectUnauthorized?: boolean } | undefined {
  if (!creds.ca && !creds.insecure) return undefined
  const options: { ca?: string[]; rejectUnauthorized?: boolean } = {}
  if (creds.ca) options.ca = [creds.ca]
  if (creds.insecure) options.rejectUnauthorized = false
  return options
}

/** imapflow sets servername:false for IP hosts; Bun tls.connect rejects that, so override with undefined. */
export function imapTlsOptions(creds: { ca?: string; insecure?: boolean }, host: string): { ca?: string[]; rejectUnauthorized?: boolean; servername?: string } | undefined {
  const tls = tlsSocketOptions(creds)
  if (!isIP(host)) return tls
  return { ...tls, servername: undefined }
}

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

function formatEnvelopeDate(date: Date | string | undefined): string {
  if (!date) return new Date().toISOString()
  return (typeof date === 'string' ? new Date(date) : date).toISOString()
}

function isSentFolder(folder: string): boolean {
  const normalized = folder.toLowerCase()
  return (FOLDER_FALLBACKS.sent ?? []).some((candidate) => candidate.toLowerCase() === normalized)
}

export function mailboxIsSent({
  requestedFolder,
  mailboxPath,
  specialUse,
}: {
  requestedFolder?: string
  mailboxPath: string
  specialUse?: string | false
}): boolean {
  if (requestedFolder?.toLowerCase() === 'sent') return true
  if (specialUse === '\\Sent') return true
  return isSentFolder(mailboxPath)
}

const IMAP_IN_FOLDERS = new Set([
  'inbox',
  'sent',
  'trash',
  'spam',
  'drafts',
  'draft',
  'archive',
])

export type ImapSearchCriteria = {
  all?: true
  flagged?: true
  unseen?: true
  from?: string
  to?: string
  subject?: string
  body?: string
  since?: Date
  before?: Date
  header?: { 'Content-Type': string }
  or?: ImapSearchCriteria[]
}

/** IMAP SEARCH is per mailbox. `in:` must be stripped or it becomes BODY text. */
export function parseImapSearchQuery(
  query: string,
  { isStarred = false }: { isStarred?: boolean } = {},
): { inFolder: string | undefined; searchCriteria: ImapSearchCriteria } {
  const inMatch = query.match(/\bin:(\S+)/i)
  const inRaw = inMatch?.[1]?.toLowerCase()
  const inFolder = inRaw && IMAP_IN_FOLDERS.has(inRaw) ? inRaw : undefined
  const starred = isStarred || inRaw === 'starred'

  const baseCriteria: ImapSearchCriteria = starred ? { flagged: true } : {}
  let searchCriteria: ImapSearchCriteria = { ...baseCriteria }
  let hasSpecificCriteria = starred

  const fromMatch = query.match(/from:(\S+)/i)
  if (fromMatch) {
    searchCriteria.from = fromMatch[1]
    hasSpecificCriteria = true
  }

  const toMatch = query.match(/to:(\S+)/i)
  if (toMatch) {
    searchCriteria.to = toMatch[1]
    hasSpecificCriteria = true
  }

  const subjectMatch = query.match(/subject:(?:"([^"]+)"|(\S+))/i)
  if (subjectMatch) {
    searchCriteria.subject = subjectMatch[1] ?? subjectMatch[2]
    hasSpecificCriteria = true
  }

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

  const afterMatch = query.match(/after:(\d{4}\/\d{1,2}\/\d{1,2})/i)
  if (afterMatch) {
    searchCriteria.since = new Date(afterMatch[1]!.replace(/\//g, '-'))
    hasSpecificCriteria = true
  }

  const beforeMatch = query.match(/before:(\d{4}\/\d{1,2}\/\d{1,2})/i)
  if (beforeMatch) {
    searchCriteria.before = new Date(beforeMatch[1]!.replace(/\//g, '-'))
    hasSpecificCriteria = true
  }

  if (/is:unread/i.test(query)) {
    searchCriteria.unseen = true
    hasSpecificCriteria = true
  }
  if (/is:starred/i.test(query)) {
    searchCriteria.flagged = true
    hasSpecificCriteria = true
  }
  if (/has:attachment/i.test(query)) {
    searchCriteria.header = { 'Content-Type': 'multipart/mixed' }
    hasSpecificCriteria = true
  }

  const plainText = query
    .replace(/\bin:\S+/gi, '')
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
    if (hasSpecificCriteria) {
      searchCriteria.body = plainText
    } else {
      searchCriteria = { or: [{ subject: plainText }, { body: plainText }] }
    }
  } else if (!hasSpecificCriteria) {
    searchCriteria = { all: true }
  }

  return { inFolder, searchCriteria }
}

function normalizeImapFolder(name: string) {
  const lower = name.toLowerCase()
  if (lower === 'draft') return 'drafts'
  if (lower === 'bin') return 'trash'
  return lower
}

/** `mail search` has no folder, so hit Inbox and Sent. `--folder` wins over `in:`. */
export function imapSearchFolders({
  folder,
  inFolder,
}: {
  folder?: string
  inFolder?: string
}): string[] {
  if (folder && inFolder) {
    if (normalizeImapFolder(folder) !== normalizeImapFolder(inFolder)) return []
    return [folder]
  }
  if (folder) return [folder]
  if (inFolder) return [inFolder]
  return ['inbox', 'sent']
}

export function pageThreadsByDate<T extends { date: string }>({
  threads,
  startIndex,
  maxResults,
}: {
  threads: T[]
  startIndex: number
  maxResults: number
}): { threads: T[]; nextPageToken: string | null } {
  const sorted = [...threads].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  return {
    threads: sorted.slice(startIndex, startIndex + maxResults),
    nextPageToken: startIndex + maxResults < sorted.length
      ? String(startIndex + maxResults)
      : null,
  }
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

function isImapAuthFailure(err: Error): boolean {
  const e = err as { authenticationFailed?: boolean; serverResponseCode?: string; response?: string }
  if (e.authenticationFailed === true) return true
  if (e.serverResponseCode === 'AUTHENTICATIONFAILED') return true
  if (typeof e.response === 'string' && e.response.includes('AUTHENTICATIONFAILED')) return true
  const msg = String(err)
  return msg.includes('Authentication') || msg.includes('AUTHENTICATIONFAILED') || msg.includes('LOGIN') || msg.includes('Invalid credentials')
}

/** Boundary helper for imapflow calls — converts auth errors to typed values. */
function imapBoundary<T>(email: string, fn: () => Promise<T>) {
  return errore.tryAsync({
    try: fn,
    catch: (err) => {
      const msg = String(err)
      if (isImapAuthFailure(err)) {
        const e = err as { response?: string }
        return new AuthError({ email, reason: e.response ?? msg })
      }
      return new ApiError({ reason: msg, cause: err })
    },
  })
}

// ---------------------------------------------------------------------------
// ImapSmtpClient
// ---------------------------------------------------------------------------

export class ImapSmtpClient {
  private account: AccountId
  private loadCredentials: () => Promise<ImapSmtpCredentials | AuthError>
  private smtpTransporter: Transporter<SMTPTransport.SentMessageInfo> | null = null
  private smtpAccessToken: string | undefined

  constructor({
    account,
    loadCredentials,
  }: {
    account: AccountId
    loadCredentials: () => Promise<ImapSmtpCredentials | AuthError>
  }) {
    this.account = account
    this.loadCredentials = loadCredentials
  }

  // =========================================================================
  // IMAP connection helpers
  // =========================================================================

  private async createImapClient(): Promise<ImapFlow | AuthError> {
    const creds = await this.loadCredentials()
    if (creds instanceof Error) return creds
    if (!creds.imap) return new AuthError({ email: this.account.email, reason: 'IMAP not configured for this account' })
    const auth = creds.oauth
      ? { user: creds.imap.user, accessToken: creds.oauth.accessToken }
      : { user: creds.imap.user, pass: creds.imap.password }
    const tls = imapTlsOptions(creds.imap, creds.imap.host)
    return new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port,
      secure: creds.imap.tls,
      auth,
      logger: false,
      tls,
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
    const client = await this.createImapClient()
    if (client instanceof UnsupportedError) {
      return new AuthError({ email: this.account.email, reason: client.message })
    }
    if (client instanceof Error) return client
    const connectResult = await imapBoundary(this.account.email, () => client.connect())
    if (connectResult instanceof Error) return connectResult

    const result = await imapBoundary(this.account.email, () => fn(client))
    await client.logout().catch(() => {})
    return result
  }

  private async getSmtpTransporter(): Promise<Transporter<SMTPTransport.SentMessageInfo> | UnsupportedError | AuthError> {
    const creds = await this.loadCredentials()
    if (creds instanceof Error) return creds
    if (!creds.smtp) return new UnsupportedError({ feature: 'Sending email', accountType: 'IMAP-only', hint: 'Add SMTP with: zele login imap --email ... --smtp-host ...' })
    if (this.smtpTransporter && this.smtpAccessToken === creds.oauth?.accessToken) return this.smtpTransporter
    const nodemailer = await import('nodemailer')
    this.smtpAccessToken = creds.oauth?.accessToken
    const smtpTls = tlsSocketOptions(creds.smtp)
    this.smtpTransporter = nodemailer.default.createTransport({
      host: creds.smtp.host,
      port: creds.smtp.port,
      secure: creds.smtp.tls,
      requireTLS: !creds.smtp.tls,
      tls: smtpTls,
      auth: creds.oauth
        ? { type: 'OAuth2', user: creds.smtp.user, accessToken: creds.oauth.accessToken, expires: creds.oauth.expiry }
        : { user: creds.smtp.user, pass: creds.smtp.password },
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

    const parsedQuery = query
      ? parseImapSearchQuery(query, { isStarred })
      : { inFolder: undefined, searchCriteria: isStarred ? { flagged: true } : { all: true } }
    const folders = imapSearchFolders({ folder, inFolder: parsedQuery.inFolder })
    if (folders.length === 0) {
      return { threads: [], rawThreads: [], nextPageToken: null }
    }
    const startIndex = pageToken ? Number(pageToken) : 0
    const pageByDate = folders.length !== 1

    return this.withImap(async (client) => {
      const threads: ThreadListItem[] = []
      let moreUids = false
      for (const requested of folders) {
        const resolved = await imapBoundary(this.account.email, async () => {
          const path = await this.resolveMailboxPath(client, requested)
          return { path, lock: await client.getMailboxLock(path) }
        })
        if (resolved instanceof AuthError) return resolved
        if (resolved instanceof Error) {
          if (requested === 'inbox' || folders.length === 1) return resolved
          console.warn('Skipping IMAP mailbox', requested, resolved.message)
          continue
        }
        const { path, lock } = resolved
        try {
          const searchResult = await client.search(parsedQuery.searchCriteria, { uid: true })
          const uids = [...(searchResult || [])].sort((a, b) => b - a)
          const fetchUids = pageByDate
            ? uids
            : uids.slice(startIndex, startIndex + maxResults)
          if (!pageByDate && uids.length > startIndex + maxResults) moreUids = true
          if (fetchUids.length === 0) continue
          const specialUse = client.mailbox !== false ? client.mailbox.specialUse ?? undefined : undefined
          for await (const msg of client.fetch(fetchUids, {
            uid: true,
            envelope: true,
            flags: true,
            bodyStructure: true,
          }, { uid: true })) {
            const item = this.threadFromImapMessage({
              msg,
              mailboxPath: path,
              requestedFolder: requested,
              specialUse,
            })
            if (item) threads.push(item)
          }
        } finally {
          lock.release()
        }
      }

      if (pageByDate) {
        const page = pageThreadsByDate({ threads, startIndex, maxResults })
        return {
          threads: page.threads,
          rawThreads: [],
          nextPageToken: page.nextPageToken,
        }
      }

      threads.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      return {
        threads,
        rawThreads: [],
        nextPageToken: moreUids ? String(startIndex + maxResults) : null,
      }
    }) as Promise<ThreadListResult | AuthError | ApiError>
  }

  async getThread({
    threadId,
  }: {
    threadId: string
    skipCache?: boolean
  }): Promise<ThreadResult | NotFoundError | AuthError | ApiError> {
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

        const isSent = client.mailbox !== false && client.mailbox.specialUse === '\\Sent'
        const parsed = this.parseImapMessage({ message, folder, isSent })

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

    return result as ThreadResult | NotFoundError | AuthError | ApiError
  }

  async getMessage({ messageId }: { messageId: string }): Promise<ParsedMessage | NotFoundError | AuthError | ApiError> {
    // For IMAP, messageId is the same as threadId
    const result = await this.getThread({ threadId: messageId })
    if (result instanceof Error) return result
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
    /** IMAP has no server-side thread id; threading is carried by In-Reply-To/References. */
    inReplyTo?: string
    references?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
    fromEmail?: string
  }): Promise<{ id: string; threadId: string; labelIds: string[] } | UnsupportedError | AuthError | ApiError> {
    const transporter = await this.getSmtpTransporter()
    if (transporter instanceof Error) return transporter
    const fromEmail = this.account.email
    const toHeader = to.map((r) => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', ')
    const ccHeader = cc && cc.length > 0
      ? cc.map((r) => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', ')
      : undefined
    const bccHeader = bcc && bcc.length > 0
      ? bcc.map((r) => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', ')
      : undefined
    const domain = fromEmail.split('@')[1] || 'localhost'
    const messageId = `<${randomUUID()}@${domain}>`

    // One MIME buffer for SMTP DATA and IMAP Sent APPEND. Do not rebuild a
    // text/plain fallback: that path dropped --attach files.
    // sendMail({ raw }) invents a wrapper Message-ID, so we mint ours and
    // return that instead of info.messageId.
    const rawMime = await buildOutgoingMime({
      from: fromEmail,
      to: toHeader,
      subject,
      text: body,
      cc: ccHeader,
      bcc: bccHeader,
      inReplyTo,
      references,
      attachments,
      messageId,
    })
    if (rawMime instanceof Error) return rawMime

    const sendResult = await errore.tryAsync({
      try: () => transporter.sendMail({
        envelope: {
          from: fromEmail,
          to: [
            ...to.map((r) => r.email),
            ...(cc ?? []).map((r) => r.email),
            ...(bcc ?? []).map((r) => r.email),
          ],
        },
        raw: rawMime,
      }),
      catch: (err) => new ApiError({ reason: `SMTP send failed: ${String(err)}`, cause: err }),
    })
    if (sendResult instanceof Error) return sendResult

    const imapCreds = await this.loadCredentials()
    if (!(imapCreds instanceof Error) && imapCreds.imap) {
      const appendResult = await this.withImap(async (client) => {
        const sentPath = await this.resolveMailboxPath(client, 'sent')
        await client.append(sentPath, rawMime, ['\\Seen'])
      })
      if (appendResult instanceof Error) {
        console.warn('Sent message but failed to save to Sent folder:', appendResult.message)
      }
    }

    return {
      id: messageId,
      threadId: 'unknown',
      labelIds: ['SENT'],
    }
  }

  /**
   * Resolve recipients + threading headers for a message sent into an existing
   * thread. Mirrors GmailClient.resolveThreadReply; recipient inference itself
   * lives in resolveReplyRecipients so both clients behave identically.
   *
   * Note: for IMAP a "thread" is a single message (folder:uid), so the anchor is
   * always that message. Replying to something in Sent would therefore target
   * yourself under the naive rule — the resolver falls back to its To: instead.
   */
  async resolveThreadReply({
    threadId,
    to,
    cc,
    replyAll = false,
    allowSelf = false,
    seenMessageId,
  }: {
    threadId: string
    to?: Array<{ name?: string; email: string }>
    cc?: Array<{ name?: string; email: string }>
    replyAll?: boolean
    allowSelf?: boolean
    seenMessageId?: string | null
  }): Promise<ThreadReplyEnvelope | EmptyThreadError | SelfRecipientError | AmbiguousRecipientError | UnseenLatestError | NotFoundError | AuthError | ApiError> {
    const thread = await this.getThread({ threadId, skipCache: true })
    if (thread instanceof Error) return thread

    const messages = thread.parsed.messages
    if (messages.length === 0) {
      return new EmptyThreadError({ threadId })
    }

    if (seenMessageId !== undefined) {
      const last = threadAnchor(messages)
      if (!last) return new EmptyThreadError({ threadId })
      const unseen = checkThreadLatestSeen({ threadId, lastMessageId: last.id, seenMessageId })
      if (unseen) return unseen
    }

    // IMAP has no portable send-as alias API. A message fetched from Sent is
    // authoritative evidence that its From address belongs to this account.
    const sentFromAddresses = messages
      .filter((message) => message.labelIds.includes('SENT'))
      .map((message) => message.from.email)
    const resolution = resolveReplyRecipients({
      messages,
      selfAddresses: [this.account.email, ...sentFromAddresses],
      threadId,
      replyAll,
      explicitTo: to,
      extraCc: cc,
      allowSelf,
    })
    if (resolution instanceof Error) return resolution

    const { anchor } = resolution
    const references = [anchor.references, anchor.messageId].filter(Boolean).join(' ')

    return {
      to: resolution.to,
      cc: resolution.cc.length > 0 ? resolution.cc : undefined,
      anchorSubject: anchor.subject,
      inReplyTo: anchor.messageId || undefined,
      references: references || undefined,
      source: resolution.source,
    }
  }

  /**
   * Send a message into an existing thread. IMAP has no server-side thread id,
   * so threading is carried entirely by In-Reply-To/References headers, which is
   * what every standards-compliant client uses to group messages.
   */
  async sendInThread({
    threadId,
    body,
    to,
    subject,
    cc,
    bcc,
    replyAll = false,
    allowSelf = false,
    attachments,
    seenMessageId,
  }: {
    threadId: string
    body: string
    to?: Array<{ name?: string; email: string }>
    subject?: string
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    replyAll?: boolean
    allowSelf?: boolean
    fromEmail?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
    seenMessageId?: string | null
  }): Promise<EmptyThreadError | SelfRecipientError | AmbiguousRecipientError | UnseenLatestError | NotFoundError | UnsupportedError | AuthError | ApiError | SentInThread<{ id: string; threadId: string; labelIds: string[] }>> {
    const envelope = await this.resolveThreadReply({ threadId, to, cc, replyAll, allowSelf, seenMessageId })
    if (envelope instanceof Error) return envelope

    const result = await this.sendMessage({
      to: envelope.to,
      subject: subject ?? replySubject(envelope.anchorSubject),
      body,
      cc: envelope.cc,
      bcc,
      inReplyTo: envelope.inReplyTo,
      references: envelope.references,
      attachments,
    })
    if (result instanceof Error) return result

    return {
      message: result,
      to: envelope.to.map((r) => r.email),
      cc: (envelope.cc ?? []).map((r) => r.email),
      bcc: (bcc ?? []).map((r) => r.email),
      recipientSource: envelope.source,
    }
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
  }): Promise<EmptyThreadError | NotFoundError | UnsupportedError | AuthError | ApiError | { id: string; threadId: string; labelIds: string[] }> {
    const thread = await this.getThread({ threadId })
    if (thread instanceof Error) return thread

    const lastMsg = threadAnchor(thread.parsed.messages)
    if (!lastMsg) return new EmptyThreadError({ threadId })

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
        const uids = searchResult || []
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
        // attachmentId is the MIME part number (e.g. "2", "1.2"). download()
        // removes the transfer encoding; fetch bodyParts returns it still encoded.
        const download = await client.download(String(uid), attachmentId, { uid: true })
        if (!download.content) {
          return new NotFoundError({ resource: `attachment ${attachmentId} in message ${messageId}` })
        }
        const chunks: Buffer[] = []
        for await (const chunk of download.content) chunks.push(chunk)
        return Buffer.concat(chunks).toString('base64')
      } finally {
        lock.release()
      }
    })
  }

  // =========================================================================
  // Watch (IMAP polling — simplified version without IDLE)
  // =========================================================================

  async *watchInbox({
    folder = 'inbox',
    intervalMs = 15_000,
    query,
    signal,
  }: {
    folder?: string
    intervalMs?: number
    query?: string
    signal?: AbortSignal
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
        const uids = searchResult || []
        return uids.length > 0 ? Math.max(...uids) : 0
      } finally {
        lock.release()
      }
    })
    if (seedResult instanceof Error) throw seedResult
    lastUid = seedResult as number

    while (!signal?.aborted) {
      // Check for new messages since lastUid
      const pollResult = await this.withImap(async (client) => {
        const lock = await client.getMailboxLock(imapFolder)
        try {
          // Search for UIDs > lastUid
          const searchResult = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })
          const uids = searchResult || []
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
              const parsed = this.parseImapMessage({ message: msg, folder: imapFolder })
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

      if (pollResult instanceof AuthError) throw pollResult
      // Network blips must not end a watch that can run for days. Retry next tick.
      if (pollResult instanceof Error) {
        console.error(`# Poll failed for ${this.account.email}, retrying: ${pollResult.message}`)
        await abortableSleep(intervalMs, signal)
        continue
      }
      for (const event of pollResult as WatchEvent[]) {
        // Client-side query filtering (basic: from:, to:, subject:, is:unread, is:starred)
        if (query && !matchesQuery(event.message, query)) continue
        yield event
      }

      await abortableSleep(intervalMs, signal)
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
        const uids = searchResult || []

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
              date: formatEnvelopeDate(env.date),
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
    fromEmail,
    attachments,
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
    const formatList = (list?: Array<{ name?: string; email: string }>) =>
      list && list.length > 0 ? list.map((r) => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', ') : undefined

    const rawMime = await buildOutgoingMime({
      from: fromEmail ?? this.account.email,
      to: formatList(to) ?? '',
      subject,
      text: body,
      cc: formatList(cc),
      bcc: formatList(bcc),
      attachments,
      keepBcc: true,
    })
    if (rawMime instanceof Error) return rawMime

    return this.withImap(async (client) => {
      const draftsPath = await this.resolveMailboxPath(client, 'drafts')
      const appendResult = await client.append(draftsPath, rawMime, ['\\Draft', '\\Seen'])
      const uid = appendResult ? appendResult.uid : undefined
      return {
        id: uid ? makeThreadId(draftsPath, uid) : 'unknown',
        message: { id: 'unknown' },
        threadId: uid ? makeThreadId(draftsPath, uid) : 'unknown',
      }
    })
  }

  async getDraft({ draftId }: { draftId: string }) {
    // Reuse getThread to fetch the full message from Drafts folder
    const result = await this.getThread({ threadId: draftId })
    if (result instanceof Error) return result
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
    if (draft instanceof Error) return draft

    const attachments = await downloadAttachments({
      client: this,
      messageId: draft.message.id,
      attachments: draft.message.attachments,
    })
    if (attachments instanceof Error) return attachments

    const result = await this.sendMessage({
      to: draft.to,
      subject: draft.message.subject,
      body: draft.message.body,
      cc: draft.cc.length > 0 ? draft.cc : undefined,
      bcc: draft.bcc.length > 0 ? draft.bcc : undefined,
      attachments,
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
   * Update an existing draft. IMAP has no native update: APPEND the new
   * message first, then delete the old one, so a failure never loses the draft.
   */
  async updateDraft({
    draftId,
    to,
    subject,
    body,
    cc,
    bcc,
    fromEmail,
    attachments,
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
    const created = await this.createDraft({ to, subject, body, cc, bcc, fromEmail, attachments })
    if (created instanceof Error) return created

    const deleted = await this.deleteDraft({ draftId })
    if (deleted instanceof Error) return deleted

    return created
  }

  /**
   * Create a draft reply to a thread. Resolves reply-to, reply-all CCs,
   * and sets In-Reply-To/References headers, then appends to Drafts.
   */
  async createDraftReply({
    threadId,
    body,
    to,
    replyAll = false,
    cc,
    bcc,
    allowSelf = false,
    fromEmail,
    attachments,
    seenMessageId,
  }: {
    threadId: string
    body: string
    to?: Array<{ name?: string; email: string }>
    replyAll?: boolean
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    allowSelf?: boolean
    fromEmail?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
    seenMessageId?: string | null
  }): Promise<EmptyThreadError | SelfRecipientError | AmbiguousRecipientError | UnseenLatestError | NotFoundError | AuthError | ApiError | SentInThread<{ id: string; message: { id: string }; threadId: string }>> {
    const envelope = await this.resolveThreadReply({ threadId, to, cc, replyAll, allowSelf, seenMessageId })
    if (envelope instanceof Error) return envelope

    // Build MIME with reply headers using mimetext (already used elsewhere in this client)
    const msg = createMimeMessage()
    msg.setSender(fromEmail ?? this.account.email)
    msg.setRecipients(envelope.to.map((r) => ({ name: r.name ?? '', addr: r.email })))
    msg.setSubject(replySubject(envelope.anchorSubject))
    if (envelope.cc && envelope.cc.length > 0) {
      msg.setCc(envelope.cc.map((r) => ({ name: r.name ?? '', addr: r.email })))
    }
    if (bcc && bcc.length > 0) {
      msg.setBcc(bcc.map((r) => ({ name: r.name ?? '', addr: r.email })))
    }
    msg.addMessage({ contentType: 'text/plain', data: body })
    if (envelope.inReplyTo) {
      msg.setHeader('In-Reply-To', envelope.inReplyTo)
    }
    if (envelope.references) {
      msg.setHeader('References', envelope.references)
    }
    if (attachments) {
      for (const att of attachments) {
        msg.addAttachment({
          filename: att.filename,
          contentType: att.mimeType,
          data: att.content.toString('base64'),
        })
      }
    }

    const rawBuffer = Buffer.from(msg.asRaw())

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

    return {
      message: result,
      to: envelope.to.map((r) => r.email),
      cc: (envelope.cc ?? []).map((r) => r.email),
      bcc: (bcc ?? []).map((r) => r.email),
      recipientSource: envelope.source,
    }
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
  }): Promise<EmptyThreadError | NotFoundError | AuthError | ApiError | { id: string; message: { id: string }; threadId: string }> {
    const thread = await this.getThread({ threadId })
    if (thread instanceof Error) return thread

    const lastMsg = threadAnchor(thread.parsed.messages)
    if (!lastMsg) return new EmptyThreadError({ threadId })

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

  private threadFromImapMessage({
    msg,
    mailboxPath,
    requestedFolder,
    specialUse,
  }: {
    msg: FetchMessageObject
    mailboxPath: string
    requestedFolder?: string
    specialUse?: string | false
  }): ThreadListItem | null {
    const env = msg.envelope
    if (!env) return null
    const flags = msg.flags ?? new Set()
    const sent = mailboxIsSent({
      requestedFolder,
      mailboxPath,
      specialUse,
    })
    return {
      id: makeThreadId(mailboxPath, msg.uid),
      historyId: null,
      snippet: env.subject ?? '',
      subject: env.subject ?? '(no subject)',
      from: toSender(env.from?.[0]),
      to: toSenders(env.to),
      cc: toSenders(env.cc),
      date: formatEnvelopeDate(env.date),
      labelIds: sent ? ['SENT'] : [],
      unread: !flags.has('\\Seen'),
      starred: flags.has('\\Flagged'),
      sent,
      messageCount: 1,
      inReplyTo: env.inReplyTo ?? null,
      hasAttachments: this.hasAttachments(msg),
      listUnsubscribe: null,
      listUnsubscribePost: null,
    }
  }

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

  /** Parse an imapflow FetchMessageObject into our ParsedMessage type. Public
   *  for offline parsing tests; it performs no network or state changes. */
  parseImapMessage({
    message: msg,
    folder,
    isSent = isSentFolder(folder),
  }: {
    message: FetchMessageObject
    folder: string
    isSent?: boolean
  }): ParsedMessage {
    const env = msg.envelope ?? {} as Partial<MessageEnvelopeObject>
    const flags = msg.flags ?? new Set()
    const threadId = makeThreadId(folder, msg.uid)

    // Extract body from source if available
    let body = ''
    let mimeType = 'text/plain'
    let textBody: string | null = null
    let listUnsubscribe: string | undefined
    let listUnsubscribePost: string | undefined
    let replyTo: string | undefined

    if (msg.source) {
      const source = msg.source.toString('utf-8')
      const bodyResult = this.extractBodyFromSource(msg.source.toString('latin1'))
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
      replyTo = this.getHeader(headerText, 'reply-to')
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
      replyTo: replyTo ?? (
        env.replyTo
          ?.map((address) => address.name ? `"${address.name}" <${address.address}>` : address.address)
          .filter(Boolean)
          .join(', ') || undefined
      ),
      date: formatEnvelopeDate(env.date),
      labelIds: isSent ? ['SENT'] : [],
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
    const charsetMatch = contentType.match(/charset="?([^";\s]+)"?/i)
    const decoded = decodeBodyCharset(this.decodeTransferEncoding(bodyContent, transferEncoding), charsetMatch?.[1])

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

      // A .txt or .html attachment is not the message body.
      const disposition = this.getHeader(partHeaders, 'content-disposition')
      if (disposition?.split(';')[0]?.trim().toLowerCase() === 'attachment') continue

      // Recursive multipart
      const nestedBoundary = partContentType.match(/boundary="?([^";\s]+)"?/i)
      if (nestedBoundary) {
        const nested = this.parseMultipart(partBody, nestedBoundary[1]!)
        if (nested.mimeType === 'text/html') htmlBody = nested.body
        if (nested.textBody) textBody = nested.textBody
        continue
      }

      const charsetMatch = partContentType.match(/charset="?([^";\s]+)"?/i)
      const decoded = decodeBodyCharset(this.decodeTransferEncoding(partBody, partEncoding), charsetMatch?.[1])

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

  private decodeTransferEncoding(content: string, encoding: string): Buffer {
    const enc = encoding.toLowerCase().trim()
    if (enc === 'base64') {
      return Buffer.from(content.replace(/\s/g, ''), 'base64')
    }
    if (enc === 'quoted-printable') {
      return decodeQuotedPrintable(content)
    }
    return Buffer.from(content, 'latin1')
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
