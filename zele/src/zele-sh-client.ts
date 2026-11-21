// zele.sh client: receive-only @zele.sh inboxes hosted on Cloudflare.
//
//   zele CLI ──Bearer token──► https://zele.sh/api/v1/*  (inboxes, message index, raw .eml)
//            ──email OTP────► https://zele.sh/api/auth/* (better-auth, @gmail.com owners only)
//
// The server only indexes headers. Bodies and attachments are parsed here from
// the raw MIME with postal-mime. Each message is its own "thread" (like IMAP).
// Sending is not supported: zele.sh inboxes are receive-only for now.

import PostalMime, { type Address } from 'postal-mime'
import { createAuthClient } from 'better-auth/client'
import { emailOTPClient } from 'better-auth/client/plugins'
import * as errore from 'errore'
import { ApiError, AuthError, NotFoundError, UnsupportedError, ZeleShSignedOutError, abortableSleep, isTruthy } from './api-utils.js'
import { parseAuthResults, type AttachmentMeta, type ParsedMessage, type ThreadListItem, type ThreadListResult, type ThreadResult, type WatchEvent } from './gmail-client.js'
import type { AccountId } from './auth.js'

export const DEFAULT_ZELE_API_URL = 'https://zele.sh'
export const ZELE_SH_DOMAIN = 'zele.sh'

/** `--api-url` flag, then ZELE_API_URL, then https://zele.sh. No trailing slash. */
export function resolveZeleApiUrl(override?: string): string {
  return (override || process.env.ZELE_API_URL || DEFAULT_ZELE_API_URL).replace(/\/+$/, '')
}

const UNSUPPORTED_HINT = 'zele.sh inboxes are receive-only for now.'

function unsupported(feature: string) {
  return new UnsupportedError({ feature, accountType: 'zele.sh', hint: UNSUPPORTED_HINT })
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

export type ZeleShMessage = {
  messageId: string
  inbox: string
  receivedAt: string
  fromEmail: string
  fromName: string
  to: Array<{ name: string; email: string }>
  cc: Array<{ name: string; email: string }>
  subject: string
  snippet: string
  messageIdHeader: string
  inReplyTo: string
  size: number
  hasAttachments: boolean
  folder: 'inbox' | 'archive' | 'trash' | 'spam'
  unread: boolean
  starred: boolean
}

export type ZeleShInbox = { address: string; createdAt: string }

type Fail = ZeleShSignedOutError | NotFoundError | ApiError
type ClientFail = Fail | AuthError

/** Thin typed wrapper over the zele.sh JSON API. Errors are returned as values. */
export class ZeleShApi {
  constructor(
    readonly apiUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    { body, as = 'json' }: { body?: unknown; as?: 'json' | 'text' } = {},
  ): Promise<T | Fail> {
    const res = await errore.tryAsync({
      try: () =>
        fetch(new URL(path, this.apiUrl), {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
      catch: (err) => new ApiError({ reason: `zele.sh request failed: ${String(err)}`, cause: err }),
    })
    if (res instanceof Error) return res
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const message = errore.tryFn(() => (JSON.parse(text) as { message?: string }).message)
      const reason = (typeof message === 'string' && message) || text || `HTTP ${res.status}`
      if (res.status === 401) return new ZeleShSignedOutError({ apiUrl: this.apiUrl })
      if (res.status === 404) return new NotFoundError({ resource: reason })
      return new ApiError({ reason })
    }
    return errore.tryAsync({
      try: async () => (as === 'text' ? await res.text() : await res.json()) as T,
      catch: (err) => new ApiError({ reason: `Invalid zele.sh response for ${path}: ${String(err)}`, cause: err }),
    })
  }

  listInboxes() {
    return this.request<{ owner: string; limit: number; inboxes: ZeleShInbox[] }>('GET', '/api/v1/inboxes')
  }

  createInbox({ name }: { name: string }) {
    return this.request<ZeleShInbox & { used: number; limit: number }>('POST', '/api/v1/inboxes', { body: { name } })
  }

  deleteInbox({ address }: { address: string }) {
    return this.request<{ address: string; deletedMessages: number }>(
      'DELETE',
      `/api/v1/inboxes/${encodeURIComponent(address)}`,
    )
  }

  listMessages({ inbox, folder, query, cursor, limit }: { inbox: string; folder: string; query?: string; cursor?: string; limit: number }) {
    const params = new URLSearchParams({ inbox, folder, limit: String(limit) })
    if (query) params.set('q', query)
    if (cursor) params.set('cursor', cursor)
    return this.request<{ messages: ZeleShMessage[]; nextCursor: string | null }>('GET', `/api/v1/messages?${params}`)
  }

  getMessage({ messageId }: { messageId: string }) {
    return this.request<ZeleShMessage>('GET', `/api/v1/messages/${encodeURIComponent(messageId)}`)
  }

  getRawMessage({ messageId }: { messageId: string }) {
    return this.request<string>('GET', `/api/v1/messages/${encodeURIComponent(messageId)}/raw`, { as: 'text' })
  }

  updateMessages(body: { messageIds: string[]; folder?: ZeleShMessage['folder']; unread?: boolean; starred?: boolean }) {
    return this.request<{ updated: number }>('PATCH', '/api/v1/messages', { body })
  }
}

// ---------------------------------------------------------------------------
// Email OTP sign-in (better-auth). Owner must be a @gmail.com address.
// ---------------------------------------------------------------------------

function authClient(apiUrl: string) {
  return createAuthClient({
    baseURL: apiUrl,
    plugins: [emailOTPClient()],
    // better-auth checks Origin on these endpoints. CLI requests are not browser
    // requests, so CSRF does not apply; send the server's own origin.
    fetchOptions: { headers: { origin: apiUrl } },
  })
}

export async function sendZeleShCode({ apiUrl, email }: { apiUrl: string; email: string }): Promise<void | ApiError> {
  const result = await errore.tryAsync({
    try: () => authClient(apiUrl).emailOtp.sendVerificationOtp({ email, type: 'sign-in' }),
    catch: (err) => new ApiError({ reason: `zele.sh request failed: ${String(err)}`, cause: err }),
  })
  if (result instanceof Error) return result
  if (result.error) return new ApiError({ reason: result.error.message ?? result.error.statusText })
}

export async function signInZeleSh({
  apiUrl,
  email,
  code,
}: {
  apiUrl: string
  email: string
  code: string
}): Promise<{ token: string; ownerEmail: string } | AuthError | ApiError> {
  let token: string | null = null
  const result = await errore.tryAsync({
    try: () =>
      authClient(apiUrl).signIn.emailOtp(
        { email, otp: code },
        { onSuccess: (ctx) => { token = ctx.response.headers.get('set-auth-token') } },
      ),
    catch: (err) => new ApiError({ reason: `zele.sh request failed: ${String(err)}`, cause: err }),
  })
  if (result instanceof Error) return result
  if (result.error) return new AuthError({ email, reason: result.error.message ?? result.error.statusText })
  if (!token) return new ApiError({ reason: 'zele.sh did not return a session token' })
  return { token, ownerEmail: result.data.user.email }
}

/** Codes are sent with the subject `zele.sh code: 123456`. */
export function codeFromSubject(subject: string): string | null {
  return /zele\.sh code:\s*(\d{6})\b/.exec(subject)?.[1] ?? null
}

// ---------------------------------------------------------------------------
// Raw MIME -> ParsedMessage
// ---------------------------------------------------------------------------

function senders(addresses: Address[] | undefined) {
  return (addresses ?? [])
    .flatMap((a) => (a.group ? a.group : [a]))
    .map((m) => ({ name: m.name || undefined, email: m.address }))
}

/** Parses raw MIME into zele's ParsedMessage. Attachment ids are part indexes. */
export async function parseRawMessage({ raw, meta }: { raw: string; meta: ZeleShMessage }): Promise<ParsedMessage> {
  const email = await PostalMime.parse(raw)
  const header = (key: string) => email.headers.find((h) => h.key === key)?.value
  const authHeader = header('authentication-results')
  const attachments: AttachmentMeta[] = email.attachments.map((a, i) => ({
    attachmentId: String(i),
    filename: a.filename ?? `attachment-${i}`,
    mimeType: a.mimeType,
    size: typeof a.content === 'string' ? a.content.length : a.content.byteLength,
  }))
  return {
    id: meta.messageId,
    threadId: meta.messageId,
    subject: email.subject ?? meta.subject ?? '(no subject)',
    snippet: meta.snippet,
    from: senders(email.from ? [email.from] : [])[0] ?? { email: meta.fromEmail, name: meta.fromName || undefined },
    to: senders(email.to),
    cc: email.cc ? senders(email.cc) : null,
    bcc: senders(email.bcc),
    replyTo: header('reply-to'),
    date: email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : meta.receivedAt,
    labelIds: labelIds(meta),
    unread: meta.unread,
    starred: meta.starred,
    isDraft: false,
    messageId: email.messageId ?? meta.messageIdHeader,
    inReplyTo: email.inReplyTo,
    references: email.references,
    listUnsubscribe: header('list-unsubscribe'),
    listUnsubscribePost: header('list-unsubscribe-post'),
    body: email.html ?? email.text ?? '',
    mimeType: email.html ? 'text/html' : 'text/plain',
    textBody: email.text ?? null,
    attachments,
    auth: authHeader ? parseAuthResults(authHeader) : null,
  }
}

function labelIds(m: ZeleShMessage): string[] {
  return [
    m.folder === 'inbox' ? 'INBOX' : m.folder === 'trash' ? 'TRASH' : m.folder === 'spam' ? 'SPAM' : null,
    m.unread ? 'UNREAD' : null,
    m.starred ? 'STARRED' : null,
  ].filter(isTruthy)
}

function toListItem(m: ZeleShMessage): ThreadListItem {
  return {
    id: m.messageId,
    historyId: null,
    snippet: m.snippet || m.subject,
    subject: m.subject || '(no subject)',
    from: { email: m.fromEmail, name: m.fromName || undefined },
    to: m.to.map((t) => ({ email: t.email, name: t.name || undefined })),
    cc: m.cc.map((t) => ({ email: t.email, name: t.name || undefined })),
    date: m.receivedAt,
    labelIds: labelIds(m),
    unread: m.unread,
    starred: m.starred,
    sent: false,
    messageCount: 1,
    inReplyTo: m.inReplyTo || null,
    hasAttachments: m.hasAttachments,
    listUnsubscribe: null,
    listUnsubscribePost: null,
  }
}

// ---------------------------------------------------------------------------
// ZeleShClient: same method surface as ImapSmtpClient, so commands work unchanged.
// ---------------------------------------------------------------------------

const SERVER_FOLDERS = new Set(['inbox', 'archive', 'trash', 'spam', 'starred', 'all'])

export class ZeleShClient {
  private readonly account: AccountId
  private readonly loadApi: () => Promise<ZeleShApi | AuthError | ZeleShSignedOutError>

  constructor({ account, loadApi }: { account: AccountId; loadApi: () => Promise<ZeleShApi | AuthError | ZeleShSignedOutError> }) {
    this.account = account
    this.loadApi = loadApi
  }

  async listThreads({
    query,
    folder = 'inbox',
    maxResults = 25,
    pageToken,
  }: {
    query?: string
    folder?: string
    maxResults?: number
    labelIds?: string[]
    pageToken?: string
  } = {}): Promise<ThreadListResult | ClientFail> {
    const lower = folder.toLowerCase()
    // zele.sh is receive-only: there is no sent or drafts folder.
    if (!SERVER_FOLDERS.has(lower)) return { threads: [], rawThreads: [], nextPageToken: null }
    const api = await this.loadApi()
    if (api instanceof Error) return api
    const page = await api.listMessages({
      inbox: this.account.email,
      folder: lower,
      query,
      cursor: pageToken,
      limit: Math.min(maxResults, 100),
    })
    if (page instanceof Error) return page
    return { threads: page.messages.map(toListItem), rawThreads: [], nextPageToken: page.nextCursor }
  }

  async getThread({ threadId }: { threadId: string; skipCache?: boolean; headersOnly?: boolean }): Promise<ThreadResult | ClientFail> {
    const message = await this.getMessage({ messageId: threadId })
    if (message instanceof Error) return message
    return {
      parsed: {
        id: threadId,
        historyId: null,
        messages: [message],
        subject: message.subject,
        snippet: message.snippet,
        from: message.from,
        date: message.date,
        labelIds: message.labelIds,
        hasUnread: message.unread,
        messageCount: 1,
      },
      raw: {},
    }
  }

  async getMessage({ messageId }: { messageId: string }): Promise<ParsedMessage | ClientFail> {
    const api = await this.loadApi()
    if (api instanceof Error) return api
    const [meta, raw] = await Promise.all([api.getMessage({ messageId }), api.getRawMessage({ messageId })])
    if (meta instanceof Error) return meta
    if (raw instanceof Error) return raw
    return errore.tryAsync({
      try: () => parseRawMessage({ raw, meta }),
      catch: (err) => new ApiError({ reason: `Failed to parse message ${messageId}: ${String(err)}`, cause: err }),
    })
  }

  async getRawMessage({ messageId }: { messageId: string }): Promise<string | ClientFail> {
    const api = await this.loadApi()
    if (api instanceof Error) return api
    return api.getRawMessage({ messageId })
  }

  async getAttachment({ messageId, attachmentId }: { messageId: string; attachmentId: string }): Promise<string | ClientFail> {
    const raw = await this.getRawMessage({ messageId })
    if (raw instanceof Error) return raw
    const email = await errore.tryAsync({
      try: () => PostalMime.parse(raw, { attachmentEncoding: 'base64' }),
      catch: (err) => new ApiError({ reason: `Failed to parse message ${messageId}: ${String(err)}`, cause: err }),
    })
    if (email instanceof Error) return email
    const attachment = email.attachments[Number(attachmentId)]
    if (!attachment || typeof attachment.content !== 'string') {
      return new NotFoundError({ resource: `attachment ${attachmentId} in message ${messageId}` })
    }
    return attachment.content
  }

  private async update(body: Parameters<ZeleShApi['updateMessages']>[0]): Promise<void | ClientFail> {
    const api = await this.loadApi()
    if (api instanceof Error) return api
    const result = await api.updateMessages(body)
    if (result instanceof Error) return result
  }

  star({ threadIds }: { threadIds: string[] }) {
    return this.update({ messageIds: threadIds, starred: true })
  }

  unstar({ threadIds }: { threadIds: string[] }) {
    return this.update({ messageIds: threadIds, starred: false })
  }

  markAsRead({ threadIds }: { threadIds: string[] }) {
    return this.update({ messageIds: threadIds, unread: false })
  }

  markAsUnread({ threadIds }: { threadIds: string[] }) {
    return this.update({ messageIds: threadIds, unread: true })
  }

  trash({ threadId }: { threadId: string }) {
    return this.update({ messageIds: [threadId], folder: 'trash' })
  }

  untrash({ threadId }: { threadId: string }) {
    return this.update({ messageIds: [threadId], folder: 'inbox' })
  }

  archive({ threadIds }: { threadIds: string[] }) {
    return this.update({ messageIds: threadIds, folder: 'archive' })
  }

  markAsSpam({ threadIds }: { threadIds: string[] }) {
    return this.update({ messageIds: threadIds, folder: 'spam' })
  }

  unmarkSpam({ threadIds }: { threadIds: string[] }) {
    return this.update({ messageIds: threadIds, folder: 'inbox' })
  }

  async trashAllSpam(): Promise<{ count: number } | ClientFail> {
    let count = 0
    while (true) {
      const page = await this.listThreads({ folder: 'spam', maxResults: 100 })
      if (page instanceof Error) return page
      if (page.threads.length === 0) return { count }
      const result = await this.update({ messageIds: page.threads.map((t) => t.id), folder: 'trash' })
      if (result instanceof Error) return result
      count += page.threads.length
    }
  }

  async getProfile() {
    return { emailAddress: this.account.email, messagesTotal: 0, threadsTotal: 0, historyId: '0' }
  }

  async getEmailAliases() {
    return [{ email: this.account.email, primary: true }]
  }

  /** Polls the newest page and yields messages with a newer ULID than the seed. */
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
    const seed = await this.listThreads({ folder, query, maxResults: 1 })
    if (seed instanceof Error) throw seed
    let newest = seed.threads[0]?.id ?? ''
    while (!signal?.aborted) {
      await abortableSleep(intervalMs, signal)
      if (signal?.aborted) return
      const page = await this.listThreads({ folder, query, maxResults: 50 })
      if (page instanceof AuthError || page instanceof ZeleShSignedOutError) throw page
      if (page instanceof Error) {
        console.error(`# Poll failed for ${this.account.email}, retrying: ${page.message}`)
        continue
      }
      const fresh = page.threads.filter((t) => t.id > newest).reverse()
      for (const thread of fresh) {
        newest = thread.id
        const message = await this.getMessage({ messageId: thread.id })
        if (message instanceof AuthError) throw message
        if (message instanceof Error) continue
        yield { account: this.account, type: 'new_message', message, threadId: thread.id }
      }
    }
  }

  // ── Receive-only: everything below needs sending or drafts ──
  // TODO: implement once zele.sh supports sending (server has no send route yet).

  async sendMessage(_opts: unknown) {
    return unsupported('Sending email')
  }

  async resolveThreadReply(_opts: unknown) {
    return unsupported('Replying')
  }

  async sendInThread(_opts: unknown) {
    return unsupported('Sending email')
  }

  async forwardThread(_opts: unknown) {
    return unsupported('Forwarding')
  }

  async listLabels() {
    return unsupported('Labels')
  }

  async modifyLabels(_opts: unknown) {
    return unsupported('Labels')
  }

  async listDrafts(_opts?: unknown) {
    return unsupported('Drafts')
  }

  async createDraft(_opts: unknown) {
    return unsupported('Drafts')
  }

  async getDraft(_opts: unknown) {
    return unsupported('Drafts')
  }

  async sendDraft(_opts: unknown) {
    return unsupported('Drafts')
  }

  async deleteDraft(_opts: unknown) {
    return unsupported('Drafts')
  }

  async updateDraft(_opts: unknown) {
    return unsupported('Drafts')
  }

  async createDraftReply(_opts: unknown) {
    return unsupported('Drafts')
  }

  async createDraftForward(_opts: unknown) {
    return unsupported('Drafts')
  }

  async listFolders() {
    return ['inbox', 'archive', 'starred', 'spam', 'trash'].map((name) => ({ name, path: name, flags: [] as string[] }))
  }

  async invalidateThreads(_threadIds: string[]): Promise<void> {}
  async invalidateThread(_threadId: string): Promise<void> {}
}
