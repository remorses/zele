// Gmail API client for CLI/TUI use.
// Wraps the @googleapis/gmail SDK with structured methods, object params, and inferred return types.
// No abstract interfaces, no RPC layer — just a concrete class for Gmail.
// Ported from Zero's GoogleMailManager (apps/server/src/lib/driver/google.ts) with CLI adaptations:
//   - No HTML sanitization (CLI renders text)
//   - No Effect library (simple retry loop)
//   - Uses batchModify for label mutations (more efficient than per-thread modify)
//   - Body decoding inline with Buffer (no base64-js dependency)
//   - Concurrent hydration with configurable concurrency limit

import { gmail as gmailApi, type gmail_v1 } from '@googleapis/gmail'
import type { OAuth2Client } from 'google-auth-library'
import { createMimeMessage } from 'mimetext'
import { parseFrom, parseAddressList } from './email-utils.js'
import { withRetry, mapConcurrent } from './api-utils.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Sender {
  name?: string
  email: string
}

export interface ParsedMessage {
  id: string
  threadId: string
  subject: string
  snippet: string
  from: Sender
  to: Sender[]
  cc: Sender[] | null
  bcc: Sender[]
  replyTo?: string
  date: string
  labelIds: string[]
  unread: boolean
  starred: boolean
  isDraft: boolean
  messageId: string
  inReplyTo?: string
  references?: string
  listUnsubscribe?: string
  body: string // decoded plain text or html
  mimeType: string // 'text/plain' or 'text/html'
  attachments: AttachmentMeta[]
}

export interface AttachmentMeta {
  attachmentId: string
  filename: string
  mimeType: string
  size: number
}

export interface ThreadData {
  id: string
  historyId: string | null
  messages: ParsedMessage[]
  subject: string
  snippet: string
  from: Sender
  date: string
  labelIds: string[]
  hasUnread: boolean
  messageCount: number
}

export interface ThreadListItem {
  id: string
  historyId: string | null
  snippet: string
  subject: string
  from: Sender
  date: string
  labelIds: string[]
  unread: boolean
  messageCount: number
}

export interface ThreadListResult {
  threads: ThreadListItem[]
  nextPageToken: string | null
  resultSizeEstimate: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_LABEL_IDS = new Set([
  'INBOX',
  'TRASH',
  'SPAM',
  'DRAFT',
  'SENT',
  'STARRED',
  'UNREAD',
  'IMPORTANT',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
  'CATEGORY_PROMOTIONS',
  'MUTED',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeBase64Url(encoded: string) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

function encodeBase64Url(data: string | Buffer) {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// GmailClient
// ---------------------------------------------------------------------------

export class GmailClient {
  private gmail: gmail_v1.Gmail
  private labelIdCache: Record<string, string> = {}

  constructor({ auth }: { auth: OAuth2Client }) {
    this.gmail = gmailApi({ version: 'v1', auth })
  }

  // =========================================================================
  // Thread operations
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
  } = {}): Promise<ThreadListResult> {
    const { q, resolvedLabelIds } = this.buildSearchParams(folder, query, labelIds)

    const res = await withRetry(() =>
      this.gmail.users.threads.list({
        userId: 'me',
        q: q || undefined,
        labelIds: resolvedLabelIds.length > 0 ? resolvedLabelIds : undefined,
        maxResults,
        pageToken: pageToken || undefined,
      }),
    )

    const rawThreads = res.data.threads ?? []

    // Hydrate with metadata
    const threads = await mapConcurrent(rawThreads, async (t) => {
      if (!t.id) return null
      try {
        const detail = await withRetry(() =>
          this.gmail.users.threads.get({
            userId: 'me',
            id: t.id!,
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date', 'To'],
          }),
        )
        return this.parseThreadListItem(t.id, detail.data)
      } catch {
        return null
      }
    })

    return {
      threads: threads.filter((t): t is ThreadListItem => t !== null),
      nextPageToken: res.data.nextPageToken ?? null,
      resultSizeEstimate: res.data.resultSizeEstimate ?? 0,
    }
  }

  async getThread({ threadId }: { threadId: string }) {
    const res = await withRetry(() =>
      this.gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      }),
    )

    if (!res.data.messages || res.data.messages.length === 0) {
      return {
        id: threadId,
        historyId: res.data.historyId ?? null,
        messages: [],
        subject: '',
        snippet: '',
        from: { email: '' },
        date: '',
        labelIds: [],
        hasUnread: false,
        messageCount: 0,
      } satisfies ThreadData
    }

    const messages = res.data.messages.map((m) => this.parseMessage(m))
    const latest = messages.findLast((m) => !m.isDraft) ?? messages[messages.length - 1]!
    const allLabels = [...new Set(messages.flatMap((m) => m.labelIds))]

    return {
      id: threadId,
      historyId: res.data.historyId ?? null,
      messages,
      subject: latest.subject,
      snippet: latest.snippet,
      from: latest.from,
      date: latest.date,
      labelIds: allLabels,
      hasUnread: messages.some((m) => m.unread),
      messageCount: messages.filter((m) => !m.isDraft).length,
    } satisfies ThreadData
  }

  async getMessage({
    messageId,
    format = 'full',
  }: {
    messageId: string
    format?: 'full' | 'metadata' | 'minimal' | 'raw'
  }) {
    const res = await withRetry(() =>
      this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format,
      }),
    )

    if (format === 'raw') {
      return {
        id: messageId,
        raw: res.data.raw ? decodeBase64Url(res.data.raw) : '',
      }
    }

    return this.parseMessage(res.data)
  }

  async getRawMessage({ messageId }: { messageId: string }) {
    const res = await withRetry(() =>
      this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'raw',
      }),
    )

    if (!res.data.raw) throw new Error('No raw email data found')
    return decodeBase64Url(res.data.raw)
  }

  // =========================================================================
  // Send / compose
  // =========================================================================

  async sendMessage({
    to,
    subject,
    body,
    cc,
    bcc,
    threadId,
    inReplyTo,
    references,
    attachments,
    fromEmail,
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
  }) {
    const raw = this.buildMimeMessage({
      to,
      subject,
      body,
      cc,
      bcc,
      inReplyTo,
      references,
      attachments,
      fromEmail,
    })

    const res = await withRetry(() =>
      this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw,
          threadId,
        },
      }),
    )

    return res.data
  }

  // =========================================================================
  // Draft operations
  // =========================================================================

  async createDraft({
    to,
    subject,
    body,
    cc,
    bcc,
    threadId,
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
    const raw = this.buildMimeMessage({ to, subject, body, cc, bcc, attachments, fromEmail })

    const res = await withRetry(() =>
      this.gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: { raw, threadId },
        },
      }),
    )

    return res.data
  }

  async updateDraft({
    draftId,
    to,
    subject,
    body,
    cc,
    bcc,
    threadId,
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
    const raw = this.buildMimeMessage({ to, subject, body, cc, bcc, attachments, fromEmail })

    const res = await withRetry(() =>
      this.gmail.users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: {
          message: { raw, threadId },
        },
      }),
    )

    return res.data
  }

  async getDraft({ draftId }: { draftId: string }) {
    const res = await withRetry(() =>
      this.gmail.users.drafts.get({
        userId: 'me',
        id: draftId,
        format: 'full',
      }),
    )

    if (!res.data || !res.data.message) throw new Error('Draft not found')

    const message = this.parseMessage(res.data.message)
    const headers = res.data.message.payload?.headers ?? []

    return {
      id: res.data.id ?? draftId,
      message,
      to: this.getHeaderValues(headers, 'to'),
      cc: this.getHeaderValues(headers, 'cc'),
      bcc: this.getHeaderValues(headers, 'bcc'),
    }
  }

  async listDrafts({
    query,
    maxResults = 20,
    pageToken,
  }: {
    query?: string
    maxResults?: number
    pageToken?: string
  } = {}) {
    const res = await withRetry(() =>
      this.gmail.users.drafts.list({
        userId: 'me',
        q: query || undefined,
        maxResults,
        pageToken: pageToken || undefined,
      }),
    )

    const drafts = await mapConcurrent(res.data.drafts ?? [], async (draft) => {
      if (!draft.id) return null
      try {
        const detail = await withRetry(() =>
          this.gmail.users.drafts.get({
            userId: 'me',
            id: draft.id!,
            format: 'metadata',
          }),
        )
        if (!detail.data.message) return null
        const headers = detail.data.message.payload?.headers ?? []
        return {
          id: draft.id,
          threadId: detail.data.message.threadId ?? null,
          subject: this.getHeader(headers, 'subject') ?? '(no subject)',
          to: this.getHeaderValues(headers, 'to'),
          date: this.getHeader(headers, 'date') ?? '',
          snippet: detail.data.message.snippet ?? '',
        }
      } catch {
        return null
      }
    })

    return {
      drafts: drafts.filter((d): d is NonNullable<typeof d> => d !== null),
      nextPageToken: res.data.nextPageToken ?? null,
    }
  }

  async sendDraft({ draftId }: { draftId: string }) {
    const res = await withRetry(() =>
      this.gmail.users.drafts.send({
        userId: 'me',
        requestBody: { id: draftId },
      }),
    )

    return res.data
  }

  async deleteDraft({ draftId }: { draftId: string }) {
    await withRetry(() =>
      this.gmail.users.drafts.delete({
        userId: 'me',
        id: draftId,
      }),
    )
  }

  // =========================================================================
  // Label mutations (read/unread, star, archive, trash, labels)
  // =========================================================================

  async markAsRead({ threadIds }: { threadIds: string[] }) {
    const messageIds = await this.getMessageIdsForThreads(threadIds, (labelIds) =>
      labelIds.includes('UNREAD'),
    )
    if (messageIds.length === 0) return
    await this.batchModifyMessages(messageIds, { removeLabelIds: ['UNREAD'] })
  }

  async markAsUnread({ threadIds }: { threadIds: string[] }) {
    const messageIds = await this.getMessageIdsForThreads(threadIds, (labelIds) =>
      !labelIds.includes('UNREAD'),
    )
    if (messageIds.length === 0) return
    await this.batchModifyMessages(messageIds, { addLabelIds: ['UNREAD'] })
  }

  async star({ threadIds }: { threadIds: string[] }) {
    const messageIds = await this.getMessageIdsForThreads(threadIds)
    if (messageIds.length === 0) return
    await this.batchModifyMessages(messageIds, { addLabelIds: ['STARRED'] })
  }

  async unstar({ threadIds }: { threadIds: string[] }) {
    const messageIds = await this.getMessageIdsForThreads(threadIds, (labelIds) =>
      labelIds.includes('STARRED'),
    )
    if (messageIds.length === 0) return
    await this.batchModifyMessages(messageIds, { removeLabelIds: ['STARRED'] })
  }

  async modifyLabels({
    threadIds,
    addLabelIds = [],
    removeLabelIds = [],
  }: {
    threadIds: string[]
    addLabelIds?: string[]
    removeLabelIds?: string[]
  }) {
    // Resolve add labels (auto-create if missing), but only look up remove labels (never create)
    const resolvedAdd = await Promise.all(addLabelIds.map((l) => this.resolveLabelId(l)))
    const resolvedRemove = (
      await Promise.all(removeLabelIds.map((l) => this.lookupLabelId(l)))
    ).filter((id): id is string => id !== null)

    const messageIds = await this.getMessageIdsForThreads(threadIds)
    if (messageIds.length === 0) return

    await this.batchModifyMessages(messageIds, {
      addLabelIds: resolvedAdd,
      removeLabelIds: resolvedRemove,
    })
  }

  async trash({ threadId }: { threadId: string }) {
    await withRetry(() =>
      this.gmail.users.threads.trash({
        userId: 'me',
        id: threadId,
      }),
    )
  }

  async untrash({ threadId }: { threadId: string }) {
    await withRetry(() =>
      this.gmail.users.threads.untrash({
        userId: 'me',
        id: threadId,
      }),
    )
  }

  async archive({ threadIds }: { threadIds: string[] }) {
    const messageIds = await this.getMessageIdsForThreads(threadIds)
    if (messageIds.length === 0) return
    await this.batchModifyMessages(messageIds, { removeLabelIds: ['INBOX'] })
  }

  async deleteMessage({ messageId }: { messageId: string }) {
    await withRetry(() =>
      this.gmail.users.messages.delete({
        userId: 'me',
        id: messageId,
      }),
    )
  }

  /** Moves all spam threads to trash. Does not permanently delete. */
  async trashAllSpam() {
    let totalDeleted = 0
    let pageToken: string | undefined

    while (true) {
      const res = await this.listThreads({
        folder: 'spam',
        maxResults: 100,
        pageToken,
      })

      if (res.threads.length === 0) break

      const threadIds = res.threads.map((t) => t.id)
      const messageIds = await this.getMessageIdsForThreads(threadIds)
      await this.batchModifyMessages(messageIds, {
        addLabelIds: ['TRASH'],
        removeLabelIds: ['SPAM', 'INBOX'],
      })

      totalDeleted += threadIds.length
      pageToken = res.nextPageToken ?? undefined
      if (!pageToken) break
    }

    return { count: totalDeleted }
  }

  // =========================================================================
  // Labels CRUD
  // =========================================================================

  async listLabels() {
    const res = await withRetry(() =>
      this.gmail.users.labels.list({ userId: 'me' }),
    )

    return (
      res.data.labels?.map((label) => ({
        id: label.id ?? '',
        name: label.name ?? '',
        type: (label.type ?? 'user') as 'system' | 'user',
        messageListVisibility: label.messageListVisibility ?? null,
        labelListVisibility: label.labelListVisibility ?? null,
        color: label.color
          ? {
              backgroundColor: label.color.backgroundColor ?? '',
              textColor: label.color.textColor ?? '',
            }
          : null,
      })) ?? []
    )
  }

  async getLabel({ labelId }: { labelId: string }) {
    const res = await withRetry(() =>
      this.gmail.users.labels.get({
        userId: 'me',
        id: labelId,
      }),
    )

    return {
      id: res.data.id ?? labelId,
      name: res.data.name ?? '',
      type: (res.data.type ?? 'user') as 'system' | 'user',
      messagesTotal: res.data.messagesTotal ?? 0,
      messagesUnread: res.data.messagesUnread ?? 0,
      threadsTotal: res.data.threadsTotal ?? 0,
      threadsUnread: res.data.threadsUnread ?? 0,
      color: res.data.color
        ? {
            backgroundColor: res.data.color.backgroundColor ?? '',
            textColor: res.data.color.textColor ?? '',
          }
        : null,
    }
  }

  async createLabel({
    name,
    color,
  }: {
    name: string
    color?: { backgroundColor: string; textColor: string }
  }) {
    const res = await withRetry(() =>
      this.gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
          color,
        },
      }),
    )

    return {
      id: res.data.id ?? '',
      name: res.data.name ?? name,
    }
  }

  async updateLabel({
    labelId,
    name,
    color,
  }: {
    labelId: string
    name?: string
    color?: { backgroundColor: string; textColor: string }
  }) {
    await withRetry(() =>
      this.gmail.users.labels.update({
        userId: 'me',
        id: labelId,
        requestBody: {
          name,
          color,
        },
      }),
    )
    // Invalidate label ID cache since name may have changed
    this.labelIdCache = {}
  }

  async deleteLabel({ labelId }: { labelId: string }) {
    await withRetry(() =>
      this.gmail.users.labels.delete({
        userId: 'me',
        id: labelId,
      }),
    )
    // Invalidate label ID cache
    this.labelIdCache = {}
  }

  // =========================================================================
  // Label counts (unread counts per folder/label)
  // =========================================================================

  async getLabelCounts() {
    // Fetch label counts and archive count concurrently
    const [labels, archiveRes] = await Promise.all([
      this.listLabels(),
      withRetry(() =>
        this.gmail.users.threads.list({
          userId: 'me',
          q: 'in:archive',
          maxResults: 1,
        }),
      ).catch(() => null),
    ])

    const counts = await mapConcurrent(labels, async (label) => {
      if (!label.id) return null
      try {
        const detail = await withRetry(() =>
          this.gmail.users.labels.get({
            userId: 'me',
            id: label.id,
          }),
        )
        const labelName = (detail.data.name ?? detail.data.id ?? '').toLowerCase()
        const isTotalLabel = labelName === 'draft' || labelName === 'sent'
        return {
          label: labelName === 'draft' ? 'drafts' : labelName,
          count: Number(isTotalLabel ? detail.data.threadsTotal : detail.data.threadsUnread) || 0,
        }
      } catch {
        return null
      }
    })

    const result = counts.filter((c): c is NonNullable<typeof c> => c !== null)

    // Add archive count (same as Zero's count() method)
    if (archiveRes) {
      result.push({
        label: 'archive',
        count: Number(archiveRes.data.resultSizeEstimate ?? 0),
      })
    }

    return result
  }

  // =========================================================================
  // Attachments
  // =========================================================================

  async getAttachment({
    messageId,
    attachmentId,
  }: {
    messageId: string
    attachmentId: string
  }) {
    const res = await withRetry(() =>
      this.gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
      }),
    )

    const data = res.data.data ?? ''
    // Convert base64url to standard base64
    return data.replace(/-/g, '+').replace(/_/g, '/')
  }

  async getMessageAttachments({ messageId }: { messageId: string }) {
    const res = await withRetry(() =>
      this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
      }),
    )

    const parts = res.data.payload?.parts
    if (!parts) return []

    const attachmentParts = this.findAttachmentParts(parts)

    const attachments = await mapConcurrent(attachmentParts, async (part) => {
      const attId = part.body?.attachmentId
      if (!attId) return null
      try {
        const data = await this.getAttachment({ messageId, attachmentId: attId })
        return {
          filename: part.filename ?? '',
          mimeType: part.mimeType ?? '',
          size: Number(part.body?.size ?? 0),
          attachmentId: attId,
          data,
        }
      } catch {
        return null
      }
    })

    return attachments.filter((a): a is NonNullable<typeof a> => a !== null)
  }

  // =========================================================================
  // Account / profile
  // =========================================================================

  async getProfile() {
    const res = await withRetry(() =>
      this.gmail.users.getProfile({ userId: 'me' }),
    )

    return {
      emailAddress: res.data.emailAddress ?? '',
      messagesTotal: res.data.messagesTotal ?? 0,
      threadsTotal: res.data.threadsTotal ?? 0,
      historyId: res.data.historyId ?? '',
    }
  }

  async getEmailAliases() {
    const profile = await this.getProfile()
    const primaryEmail = profile.emailAddress

    const aliases: Array<{ email: string; name?: string; primary: boolean }> = [
      { email: primaryEmail, primary: true },
    ]

    try {
      const settings = await withRetry(() =>
        this.gmail.users.settings.sendAs.list({ userId: 'me' }),
      )

      for (const alias of settings.data.sendAs ?? []) {
        if (alias.isPrimary && alias.sendAsEmail === primaryEmail) continue
        aliases.push({
          email: alias.sendAsEmail ?? '',
          name: alias.displayName ?? undefined,
          primary: alias.isPrimary ?? false,
        })
      }
    } catch {
      // sendAs.list may fail if the user doesn't have permission
    }

    return aliases
  }

  // =========================================================================
  // History / sync
  // =========================================================================

  async listHistory({
    startHistoryId,
    labelId,
    historyTypes,
  }: {
    startHistoryId: string
    labelId?: string
    historyTypes?: Array<'messageAdded' | 'messageDeleted' | 'labelAdded' | 'labelRemoved'>
  }) {
    const allHistory: gmail_v1.Schema$History[] = []
    let pageToken: string | undefined
    let latestHistoryId = startHistoryId

    while (true) {
      const res = await withRetry(() =>
        this.gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          labelId,
          historyTypes,
          pageToken,
        }),
      )

      if (res.data.history) {
        allHistory.push(...res.data.history)
      }
      latestHistoryId = res.data.historyId ?? latestHistoryId

      pageToken = res.data.nextPageToken ?? undefined
      if (!pageToken) break
    }

    return {
      history: allHistory,
      historyId: latestHistoryId,
    }
  }

  // NOTE: This method wraps Gmail's push notification API (users.watch),
  // which requires a Google Cloud Pub/Sub topic. Since zele uses borrowed
  // OAuth credentials (Thunderbird's client ID), we cannot create Pub/Sub
  // resources on their GCP project. Users would need their own GCP project,
  // which defeats the zero-config design. The CLI uses History API polling
  // instead (see src/commands/watch.ts). This method is kept for potential
  // future use if users bring their own GCP credentials.
  async watch({
    topicName,
    labelIds = ['INBOX'],
  }: {
    topicName: string
    labelIds?: string[]
  }) {
    const res = await withRetry(() =>
      this.gmail.users.watch({
        userId: 'me',
        requestBody: {
          topicName,
          labelIds,
        },
      }),
    )

    return {
      historyId: res.data.historyId ?? '',
      expiration: res.data.expiration ?? '',
    }
  }

  async stopWatch() {
    await withRetry(() =>
      this.gmail.users.stop({ userId: 'me' }),
    )
  }

  // =========================================================================
  // Private: message parsing
  // =========================================================================

  private parseMessage(message: gmail_v1.Schema$Message): ParsedMessage {
    const headers = message.payload?.headers ?? []
    const labelIds = message.labelIds ?? []

    const fromHeader = this.getHeader(headers, 'from') ?? ''
    const toHeader = this.getHeader(headers, 'to') ?? ''
    const ccHeaders = this.getHeaderAll(headers, 'cc')

    const { body, mimeType } = this.extractBody(message.payload ?? {})

    return {
      id: message.id ?? '',
      threadId: message.threadId ?? '',
      subject: (this.getHeader(headers, 'subject') ?? '(no subject)').replace(/"/g, '').trim(),
      snippet: message.snippet ?? '',
      from: parseFrom(fromHeader),
      to: toHeader ? parseAddressList(toHeader) : [],
      cc:
        ccHeaders.length > 0
          ? ccHeaders.filter((h) => h.trim().length > 0).flatMap((h) => parseAddressList(h))
          : null,
      bcc: [],
      replyTo: this.getHeader(headers, 'reply-to') ?? undefined,
      date: this.getHeader(headers, 'date') ?? '',
      labelIds,
      unread: labelIds.includes('UNREAD'),
      starred: labelIds.includes('STARRED'),
      isDraft: labelIds.includes('DRAFT'),
      messageId: this.getHeader(headers, 'message-id') ?? '',
      inReplyTo: this.getHeader(headers, 'in-reply-to') ?? undefined,
      references: this.getHeader(headers, 'references') ?? undefined,
      listUnsubscribe: this.getHeader(headers, 'list-unsubscribe') ?? undefined,
      body,
      mimeType,
      attachments: this.extractAttachmentMeta(message.payload?.parts ?? []),
    }
  }

  private parseThreadListItem(
    threadId: string,
    thread: gmail_v1.Schema$Thread,
  ): ThreadListItem {
    const messages = thread.messages ?? []
    // Use the last non-draft message, or the last message
    const latest =
      messages.findLast((m) => !m.labelIds?.includes('DRAFT')) ?? messages[messages.length - 1]

    const headers = latest?.payload?.headers ?? []
    const allLabels = [...new Set(messages.flatMap((m) => m.labelIds ?? []))]

    return {
      id: threadId,
      historyId: thread.historyId ?? null,
      snippet: latest?.snippet ?? '',
      subject: (this.getHeader(headers, 'subject') ?? '(no subject)').replace(/"/g, '').trim(),
      from: parseFrom(this.getHeader(headers, 'from') ?? ''),
      date: this.getHeader(headers, 'date') ?? '',
      labelIds: allLabels,
      unread: allLabels.includes('UNREAD'),
      messageCount: messages.filter((m) => !m.labelIds?.includes('DRAFT')).length,
    }
  }

  // =========================================================================
  // Private: body extraction
  // =========================================================================

  private extractBody(payload: gmail_v1.Schema$MessagePart): {
    body: string
    mimeType: string
  } {
    // Direct body on payload
    if (payload.body?.data) {
      return {
        body: decodeBase64Url(payload.body.data),
        mimeType: payload.mimeType ?? 'text/plain',
      }
    }

    if (!payload.parts) {
      return { body: '', mimeType: 'text/plain' }
    }

    // Prefer text/html, fallback to text/plain
    const htmlBody = this.findBodyPart(payload.parts, 'text/html')
    if (htmlBody) {
      return { body: decodeBase64Url(htmlBody), mimeType: 'text/html' }
    }

    const textBody = this.findBodyPart(payload.parts, 'text/plain')
    if (textBody) {
      return { body: decodeBase64Url(textBody), mimeType: 'text/plain' }
    }

    // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = this.extractBody(part)
        if (nested.body) return nested
      }
    }

    return { body: '', mimeType: 'text/plain' }
  }

  private findBodyPart(parts: gmail_v1.Schema$MessagePart[], mimeType: string): string | null {
    for (const part of parts) {
      if (part.mimeType === mimeType && part.body?.data) {
        return part.body.data
      }
      if (part.parts) {
        const found = this.findBodyPart(part.parts, mimeType)
        if (found) return found
      }
    }
    return null
  }

  // =========================================================================
  // Private: attachment handling
  // =========================================================================

  private extractAttachmentMeta(parts: gmail_v1.Schema$MessagePart[]): AttachmentMeta[] {
    const results: AttachmentMeta[] = []

    for (const part of parts) {
      if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
        // Skip inline images (content-disposition: inline with content-id)
        const disposition =
          part.headers?.find((h) => h.name?.toLowerCase() === 'content-disposition')?.value ?? ''
        const hasContentId = part.headers?.some((h) => h.name?.toLowerCase() === 'content-id')
        const isInline = disposition.toLowerCase().includes('inline')

        if (!isInline || !hasContentId) {
          results.push({
            attachmentId: part.body.attachmentId,
            filename: part.filename,
            mimeType: part.mimeType ?? 'application/octet-stream',
            size: Number(part.body.size ?? 0),
          })
        }
      }

      // Recurse into nested parts
      if (part.parts) {
        results.push(...this.extractAttachmentMeta(part.parts))
      }
    }

    return results
  }

  private findAttachmentParts(
    parts: gmail_v1.Schema$MessagePart[],
  ): gmail_v1.Schema$MessagePart[] {
    const results: gmail_v1.Schema$MessagePart[] = []

    for (const part of parts) {
      if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
        // Filter out inline CID images (same logic as Zero's findAttachments)
        const disposition =
          part.headers?.find((h) => h.name?.toLowerCase() === 'content-disposition')?.value ?? ''
        const isInline = disposition.toLowerCase().includes('inline')
        const hasContentId = part.headers?.some((h) => h.name?.toLowerCase() === 'content-id')

        if (!isInline || !hasContentId) {
          results.push(part)
        }
      }
      if (part.parts) {
        results.push(...this.findAttachmentParts(part.parts))
      }
    }

    return results
  }

  // =========================================================================
  // Private: MIME message construction
  // =========================================================================

  private buildMimeMessage({
    to,
    subject,
    body,
    cc,
    bcc,
    inReplyTo,
    references,
    attachments,
    fromEmail,
  }: {
    to: Array<{ name?: string; email: string }>
    subject: string
    body: string
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    inReplyTo?: string
    references?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
    fromEmail?: string
  }) {
    const msg = createMimeMessage()

    // Gmail API replaces the From header with the authenticated user's email on send.
    // For drafts, if no fromEmail is provided, Gmail uses the default sending address.
    // 'me' is a valid Gmail API alias that gets resolved server-side.
    msg.setSender(fromEmail || 'me')
    msg.setRecipients(to.map((r) => ({ name: r.name ?? '', addr: r.email })))

    if (cc && cc.length > 0) {
      msg.setCc(cc.map((r) => ({ name: r.name ?? '', addr: r.email })))
    }

    if (bcc && bcc.length > 0) {
      msg.setBcc(bcc.map((r) => ({ name: r.name ?? '', addr: r.email })))
    }

    msg.setSubject(subject)

    // Detect if body is HTML
    const isHtml = /<[a-z][\s\S]*>/i.test(body)
    msg.addMessage({
      contentType: isHtml ? 'text/html' : 'text/plain',
      data: body,
    })

    if (inReplyTo) {
      msg.setHeader('In-Reply-To', inReplyTo)
    }

    if (references) {
      const refs = references
        .split(' ')
        .filter(Boolean)
        .map((ref) => {
          if (!ref.startsWith('<')) ref = `<${ref}`
          if (!ref.endsWith('>')) ref = `${ref}>`
          return ref
        })
      msg.setHeader('References', refs.join(' '))
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

    return encodeBase64Url(msg.asRaw())
  }

  // =========================================================================
  // Private: label resolution
  // =========================================================================

  /** Look up a label ID by name. Returns null if not found (never creates). */
  private async lookupLabelId(labelNameOrId: string): Promise<string | null> {
    if (SYSTEM_LABEL_IDS.has(labelNameOrId)) return labelNameOrId
    if (this.labelIdCache[labelNameOrId]) return this.labelIdCache[labelNameOrId]!

    const labels = await this.listLabels()
    const match = labels.find((l) => l.name.toLowerCase() === labelNameOrId.toLowerCase())
    if (match) {
      this.labelIdCache[labelNameOrId] = match.id
      return match.id
    }

    return null
  }

  /** Resolve a label ID by name, auto-creating if it doesn't exist. */
  private async resolveLabelId(labelNameOrId: string): Promise<string> {
    if (SYSTEM_LABEL_IDS.has(labelNameOrId)) return labelNameOrId
    if (this.labelIdCache[labelNameOrId]) return this.labelIdCache[labelNameOrId]!

    const labels = await this.listLabels()
    const match = labels.find((l) => l.name.toLowerCase() === labelNameOrId.toLowerCase())
    if (match) {
      this.labelIdCache[labelNameOrId] = match.id
      return match.id
    }

    // Label doesn't exist — create it
    const created = await this.createLabel({
      name: labelNameOrId.charAt(0).toUpperCase() + labelNameOrId.slice(1).toLowerCase(),
    })
    this.labelIdCache[labelNameOrId] = created.id
    return created.id
  }

  // =========================================================================
  // Private: search / folder normalization
  // =========================================================================

  private buildSearchParams(
    folder?: string,
    query?: string,
    labelIds?: string[],
  ) {
    const resolvedLabelIds = [...(labelIds ?? [])]
    let q = query ?? ''

    if (!folder || folder === 'inbox') {
      if (!resolvedLabelIds.includes('INBOX')) {
        resolvedLabelIds.push('INBOX')
      }
      return { q, resolvedLabelIds }
    }

    // For non-inbox folders, use Gmail search syntax.
    // Caller-provided labelIds are preserved as additional filters.
    switch (folder) {
      case 'sent':
        q = `in:sent ${q}`.trim()
        break
      case 'trash':
      case 'bin':
        q = `in:trash ${q}`.trim()
        break
      case 'spam':
        q = `in:spam ${q}`.trim()
        break
      case 'drafts':
      case 'draft':
        q = `is:draft ${q}`.trim()
        break
      case 'starred':
        q = `is:starred ${q}`.trim()
        break
      case 'archive':
        q = `in:archive ${q}`.trim()
        break
      case 'snoozed':
        q = `label:Snoozed ${q}`.trim()
        break
      case 'all':
        q = `in:anywhere ${q}`.trim()
        break
      default:
        // Treat as a label name
        q = `label:${folder} ${q}`.trim()
        break
    }

    return { q, resolvedLabelIds }
  }

  // =========================================================================
  // Private: batch operations
  // =========================================================================

  private async getMessageIdsForThreads(
    threadIds: string[],
    filter?: (labelIds: string[]) => boolean,
  ) {
    const allIds: string[] = []

    await mapConcurrent(threadIds, async (threadId) => {
      const res = await withRetry(() =>
        this.gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'metadata',
        }),
      )

      for (const msg of res.data.messages ?? []) {
        if (!msg.id) continue
        if (filter && !filter(msg.labelIds ?? [])) continue
        allIds.push(msg.id)
      }
    })

    return [...new Set(allIds)]
  }

  private async batchModifyMessages(
    messageIds: string[],
    body: { addLabelIds?: string[]; removeLabelIds?: string[] },
  ) {
    if (messageIds.length === 0) return

    // Gmail batchModify accepts up to 1000 IDs
    const chunkSize = 1000
    for (let i = 0; i < messageIds.length; i += chunkSize) {
      const chunk = messageIds.slice(i, i + chunkSize)
      await withRetry(() =>
        this.gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: chunk,
            ...body,
          },
        }),
      )
    }
  }

  // =========================================================================
  // Private: header utilities
  // =========================================================================

  private getHeader(
    headers: gmail_v1.Schema$MessagePartHeader[],
    name: string,
  ): string | null {
    return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null
  }

  private getHeaderAll(
    headers: gmail_v1.Schema$MessagePartHeader[],
    name: string,
  ): string[] {
    return headers
      .filter((h) => h.name?.toLowerCase() === name.toLowerCase())
      .map((h) => h.value ?? '')
      .filter((v) => v.length > 0)
  }

  private getHeaderValues(
    headers: gmail_v1.Schema$MessagePartHeader[],
    name: string,
  ): string[] {
    const raw = this.getHeaderAll(headers, name)
    return raw.flatMap((v) =>
      v
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean),
    )
  }
}
