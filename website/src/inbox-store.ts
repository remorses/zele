// One SQLite Durable Object per owner (idFromName(userId)). It stores only
// message pointers, headers, and flags. Raw mail lives in R2 (env.MAIL).
// Kept as plain SQL with typed RPC methods: the table is small, private to this
// class, and never queried from outside, so drizzle would add no safety here.

import { DurableObject, env } from 'cloudflare:workers'
import { TRASH_RETENTION_MS, parseQuery } from './email-rules.ts'

export function getInboxStore(userId: string) {
  return env.INBOX_STORE.get(env.INBOX_STORE.idFromName(userId))
}

export const MAIL_FOLDERS = ['inbox', 'archive', 'trash', 'spam'] as const
export type MailFolder = (typeof MAIL_FOLDERS)[number]

export type MessageRow = {
  messageId: string
  inbox: string
  r2Key: string
  receivedAt: number
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
  folder: MailFolder
  unread: boolean
  starred: boolean
}

export type NewMessage = Omit<MessageRow, 'folder' | 'unread' | 'starred'> & { folder: MailFolder }

type SqlRow = Record<string, SqlStorageValue>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS message (
  message_id TEXT PRIMARY KEY,
  inbox TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL,
  message_id_header TEXT NOT NULL,
  in_reply_to TEXT NOT NULL,
  size INTEGER NOT NULL,
  has_attachments INTEGER NOT NULL,
  folder TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 1,
  starred INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER
);
CREATE INDEX IF NOT EXISTS message_inbox_folder_idx ON message (inbox, folder, message_id DESC);
CREATE INDEX IF NOT EXISTS message_trashed_at_idx ON message (trashed_at);
-- Deleted inboxes stay here so an in-flight delivery cannot insert after deletion.
CREATE TABLE IF NOT EXISTS deleted_inbox (inbox TEXT PRIMARY KEY);
`

function toRow(r: SqlRow): MessageRow {
  return {
    messageId: String(r.message_id),
    inbox: String(r.inbox),
    r2Key: String(r.r2_key),
    receivedAt: Number(r.received_at),
    fromEmail: String(r.from_email),
    fromName: String(r.from_name),
    to: JSON.parse(String(r.to_json)),
    cc: JSON.parse(String(r.cc_json)),
    subject: String(r.subject),
    snippet: String(r.snippet),
    messageIdHeader: String(r.message_id_header),
    inReplyTo: String(r.in_reply_to),
    size: Number(r.size),
    hasAttachments: Number(r.has_attachments) === 1,
    folder: String(r.folder) as MailFolder,
    unread: Number(r.unread) === 1,
    starred: Number(r.starred) === 1,
  }
}

export class InboxStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(SCHEMA)
  }

  /** Total stored raw bytes, used for the per-owner quota. */
  async usageBytes(): Promise<number> {
    const row = this.ctx.storage.sql.exec('SELECT COALESCE(SUM(size), 0) AS total FROM message').one()
    return Number(row.total)
  }

  /**
   * Quota and deleted-inbox checks run in the same statement as the insert, so
   * concurrent deliveries cannot exceed the quota or land in a deleted inbox.
   */
  async insertMessage({ message, maxBytes }: { message: NewMessage; maxBytes: number }): Promise<'inserted' | 'mailbox_full' | 'inbox_deleted'> {
    const rows = this.ctx.storage.sql
      .exec(
        `INSERT INTO message (message_id, inbox, r2_key, received_at, from_email, from_name, to_json, cc_json,
          subject, snippet, message_id_header, in_reply_to, size, has_attachments, folder)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COALESCE(SUM(size), 0) FROM message) + ? <= ?
           AND NOT EXISTS (SELECT 1 FROM deleted_inbox WHERE inbox = ?)
         RETURNING message_id`,
        message.messageId,
        message.inbox,
        message.r2Key,
        message.receivedAt,
        message.fromEmail,
        message.fromName,
        JSON.stringify(message.to),
        JSON.stringify(message.cc),
        message.subject,
        message.snippet,
        message.messageIdHeader,
        message.inReplyTo,
        message.size,
        message.hasAttachments ? 1 : 0,
        message.folder,
        message.size,
        maxBytes,
        message.inbox,
      )
      .toArray()
    if (rows.length > 0) return 'inserted'
    const deleted = this.ctx.storage.sql.exec('SELECT 1 FROM deleted_inbox WHERE inbox = ?', message.inbox).toArray()
    return deleted.length > 0 ? 'inbox_deleted' : 'mailbox_full'
  }

  /**
   * Newest first. `cursor` is the last messageId of the previous page (ULIDs sort by time).
   * Folder `starred` and `all` are views: starred = starred outside trash/spam, all = outside trash/spam.
   */
  async listMessages({
    inboxes,
    folder,
    query,
    cursor,
    limit,
  }: {
    inboxes: string[]
    folder: MailFolder | 'starred' | 'all'
    query?: string
    cursor?: string
    limit: number
  }): Promise<{ messages: MessageRow[]; nextCursor: string | null }> {
    if (inboxes.length === 0) return { messages: [], nextCursor: null }
    const where: string[] = [`inbox IN (${inboxes.map(() => '?').join(',')})`]
    const params: SqlStorageValue[] = [...inboxes]
    if (folder === 'starred') where.push(`starred = 1 AND folder NOT IN ('trash', 'spam')`)
    else if (folder === 'all') where.push(`folder NOT IN ('trash', 'spam')`)
    else {
      where.push('folder = ?')
      params.push(folder)
    }
    if (cursor) {
      where.push('message_id < ?')
      params.push(cursor)
    }
    for (const term of parseQuery(query)) {
      if (term.field === 'unread') {
        where.push('unread = 1')
        continue
      }
      const like = `%${term.value.replaceAll('%', '').replaceAll('_', '')}%`
      const columns = QUERY_COLUMNS[term.field]
      where.push(`(${columns.map((c) => `${c} LIKE ?`).join(' OR ')})`)
      params.push(...columns.map(() => like))
    }
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM message WHERE ${where.join(' AND ')} ORDER BY message_id DESC LIMIT ?`, ...params, limit + 1)
      .toArray()
    const messages = rows.slice(0, limit).map(toRow)
    const nextCursor = rows.length > limit ? messages.at(-1)!.messageId : null
    return { messages, nextCursor }
  }

  async getMessage(messageId: string): Promise<MessageRow | null> {
    const rows = this.ctx.storage.sql.exec('SELECT * FROM message WHERE message_id = ?', messageId).toArray()
    return rows[0] ? toRow(rows[0]) : null
  }

  async updateMessages({
    messageIds,
    folder,
    unread,
    starred,
  }: {
    messageIds: string[]
    folder?: MailFolder
    unread?: boolean
    starred?: boolean
  }): Promise<number> {
    const sets: string[] = []
    const params: SqlStorageValue[] = []
    if (folder) {
      sets.push('folder = ?', 'trashed_at = ?')
      params.push(folder, folder === 'trash' ? Date.now() : null)
    }
    if (unread !== undefined) {
      sets.push('unread = ?')
      params.push(unread ? 1 : 0)
    }
    if (starred !== undefined) {
      sets.push('starred = ?')
      params.push(starred ? 1 : 0)
    }
    if (sets.length === 0 || messageIds.length === 0) return 0
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE message SET ${sets.join(', ')} WHERE message_id IN (${messageIds.map(() => '?').join(',')})`,
      ...params,
      ...messageIds,
    )
    if (folder === 'trash') await this.scheduleTrashPurge()
    return cursor.rowsWritten
  }

  /** Marks the inbox deleted (blocks new inserts), then deletes its rows and R2 objects. */
  async deleteInbox(inbox: string): Promise<number> {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO deleted_inbox (inbox) VALUES (?)', inbox)
    return this.deleteWhere('inbox = ?', [inbox])
  }

  async alarm(): Promise<void> {
    await this.deleteWhere('trashed_at IS NOT NULL AND trashed_at < ?', [Date.now() - TRASH_RETENTION_MS])
    await this.scheduleTrashPurge()
  }

  private async scheduleTrashPurge(): Promise<void> {
    const row = this.ctx.storage.sql.exec('SELECT MIN(trashed_at) AS oldest FROM message WHERE trashed_at IS NOT NULL').one()
    if (row.oldest === null) return
    const at = Number(row.oldest) + TRASH_RETENTION_MS
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1000))
  }

  // R2 delete accepts at most 1000 keys per call.
  private async deleteWhere(condition: string, params: SqlStorageValue[]): Promise<number> {
    let deleted = 0
    while (true) {
      const rows = this.ctx.storage.sql
        .exec(`SELECT message_id, r2_key FROM message WHERE ${condition} LIMIT 1000`, ...params)
        .toArray()
      if (rows.length === 0) return deleted
      await this.env.MAIL.delete(rows.map((r) => String(r.r2_key)))
      const ids = rows.map((r) => String(r.message_id))
      this.ctx.storage.sql.exec(`DELETE FROM message WHERE message_id IN (${ids.map(() => '?').join(',')})`, ...ids)
      deleted += rows.length
    }
  }
}

const QUERY_COLUMNS = {
  from: ['from_email', 'from_name'],
  to: ['to_json', 'cc_json'],
  subject: ['subject'],
  text: ['subject', 'snippet', 'from_email', 'from_name'],
} as const
