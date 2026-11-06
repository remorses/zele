// Email address parsing utilities.
// Wraps the `email-addresses` package (RFC 5322 parser) with simpler return types.
// Ported from Zero's apps/server/src/lib/email-utils.ts.
//
// Also hosts resolveReplyRecipients() and checkThreadLatestSeen(). Both are
// pure — no API calls, no account state — so GmailClient and ImapSmtpClient
// share them and tests need no network.
//
// buildOutgoingMime() is the SMTP/IMAP MIME builder. Import MailComposer from
// nodemailer/lib/mail-composer — it is not a public nodemailer export.
// Falling back to a hand-built text/plain RFC 822 drops attachments.

import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import * as errore from 'errore'
import { AmbiguousRecipientError, ApiError, SelfRecipientError, UnseenLatestError } from './api-utils.js'
import emailAddresses from 'email-addresses'
const { parseFrom: _parseFrom, parseAddressList: _parseAddressList } = emailAddresses

export type OutgoingAttachment = {
  filename: string
  mimeType: string
  content: Buffer
}

/** Compile one RFC 822 buffer for SMTP DATA, IMAP Sent APPEND and IMAP Drafts APPEND. */
export async function buildOutgoingMime({
  from,
  to,
  subject,
  text,
  cc,
  bcc,
  inReplyTo,
  references,
  attachments,
  messageId,
  keepBcc = false,
}: {
  from: string
  to: string
  subject: string
  text: string
  cc?: string
  bcc?: string
  inReplyTo?: string
  references?: string
  attachments?: OutgoingAttachment[]
  messageId?: string
  /** Drafts keep the Bcc header so a later send still knows the recipients. */
  keepBcc?: boolean
}): Promise<Buffer | ApiError> {
  const mail: ConstructorParameters<typeof MailComposer>[0] = {
    from,
    to,
    subject,
    text,
  }
  if (cc) mail.cc = cc
  if (bcc) mail.bcc = bcc
  if (inReplyTo) mail.inReplyTo = inReplyTo
  if (references) mail.references = references
  if (messageId) mail.messageId = messageId
  if (attachments && attachments.length > 0) {
    mail.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.mimeType,
    }))
  }

  return errore.tryAsync({
    try: () => {
      const node = new MailComposer(mail).compile()
      node.keepBcc = keepBcc
      return node.build()
    },
    catch: (err) => new ApiError({ reason: `Failed to compile MIME: ${String(err)}`, cause: err }),
  })
}

/** Download a message's attachments so they can be attached again,
 *  e.g. when a draft is rebuilt by update or sent through SMTP. */
export async function downloadAttachments({
  client,
  messageId,
  attachments,
}: {
  client: { getAttachment(args: { messageId: string; attachmentId: string }): Promise<string | Error> }
  messageId: string
  attachments: Array<{ attachmentId: string; filename: string; mimeType: string }>
}): Promise<OutgoingAttachment[] | Error> {
  const result: OutgoingAttachment[] = []
  for (const att of attachments) {
    const data = await client.getAttachment({ messageId, attachmentId: att.attachmentId })
    if (data instanceof Error) return data
    result.push({ filename: att.filename, mimeType: att.mimeType, content: Buffer.from(data, 'base64') })
  }
  return result
}

export interface Sender {
  name?: string
  email: string
}

const FALLBACK_SENDER: Sender = {
  name: '',
  email: 'no-sender@unknown',
}

/**
 * Parse an RFC 5322 "From" header into a { name, email } object.
 * Handles edge cases like group addresses and missing names.
 */
export function parseFrom(fromHeader: string): Sender {
  const parsed = _parseFrom(fromHeader)
  if (!parsed) return FALLBACK_SENDER

  const first = parsed[0]
  if (!first) return FALLBACK_SENDER

  if (first.type === 'group') {
    const name = first.name || FALLBACK_SENDER.name
    const email = first.addresses?.[0]?.address || FALLBACK_SENDER.email
    return { name, email }
  }

  return {
    name: first.name || first.address,
    email: first.address || FALLBACK_SENDER.email,
  }
}

/**
 * Parse an RFC 5322 address list header (To, Cc, Bcc) into an array of { name, email }.
 * Handles group addresses by flattening them.
 * Returns empty array if the header cannot be parsed (never leaks fallback addresses).
 */
export function parseAddressList(header: string): Sender[] {
  const parsed = _parseAddressList(header)
  if (!parsed) return []

  return parsed.flatMap((address) => {
    if (address.type === 'group') {
      return (address.addresses || []).map((a) => ({
        name: a.name || FALLBACK_SENDER.name,
        email: a.address || FALLBACK_SENDER.email,
      }))
    }

    return {
      name: address.name || FALLBACK_SENDER.name,
      email: address.address || FALLBACK_SENDER.email,
    }
  })
}

// ---------------------------------------------------------------------------
// Reply recipient resolution
// ---------------------------------------------------------------------------

/** Minimal structural shape a thread message must have to drive reply resolution.
 *  ParsedMessage (gmail-client.ts) satisfies this; declaring it structurally here
 *  avoids an import cycle between email-utils and the clients. */
export interface ReplyAnchorMessage {
  from: Sender
  to: Sender[]
  cc?: Sender[] | null
  /** Raw Reply-To header value, unparsed (it is a full address list, not one address). */
  replyTo?: string
  isDraft: boolean
}

/** Where the resolved To: came from. Useful for hints and for skipping the self guard. */
export type ReplyRecipientSource =
  | 'explicit' // caller passed --to
  | 'reply-to' // anchor's Reply-To header
  | 'from' // anchor's From header
  | 'recipients' // anchor was sent by me, so its To: is the counterparty
  | 'previous-sender' // walked back to the last message not sent by me

/** Everything needed to compose a message inside an existing thread.
 *  Produced by the clients from a ReplyResolution. */
export interface ThreadReplyEnvelope {
  to: Sender[]
  cc?: Sender[]
  /** Subject of the anchor message, before any "Re:" prefixing. */
  anchorSubject: string
  inReplyTo?: string
  references?: string
  source: ReplyRecipientSource
}

/** Result of sending into a thread: the provider's own response plus the
 *  recipients that were actually used, so callers can show them to the user
 *  instead of guessing. */
export interface SentInThread<M> {
  message: M
  to: string[]
  cc: string[]
  bcc: string[]
  recipientSource: ReplyRecipientSource
}

/** Prefix a subject with "Re:" unless it already has one (case-insensitive). */
export function replySubject(subject: string): string {
  return /^re\s*:/i.test(subject.trim()) ? subject : `Re: ${subject}`
}

/** Refuse a reply unless `mail read` already showed this live last message.
 *  Compare Gmail/IMAP message ids, not RFC Message-ID headers. */
export function checkThreadLatestSeen({
  threadId,
  lastMessageId,
  seenMessageId,
}: {
  threadId: string
  lastMessageId: string
  seenMessageId: string | null
}): UnseenLatestError | null {
  if (seenMessageId === lastMessageId) return null
  return new UnseenLatestError({ threadId, lastMessageId })
}

/**
 * The message a reply/forward should be based on: the last non-draft message.
 * Drafts live in thread.messages too, and a draft's From is always me while its
 * Message-ID is empty, so anchoring on one both misroutes the reply and breaks
 * threading. Returns undefined for a draft-only thread — there is nothing to
 * reply to yet, and replying to a draft would produce an empty In-Reply-To.
 */
export function threadAnchor<M extends { isDraft: boolean }>(messages: M[]): M | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && !message.isDraft) return message
  }
}

export interface ReplyResolution<M extends ReplyAnchorMessage> {
  /** Message that drives In-Reply-To / References / subject. Never a draft. */
  anchor: M
  to: Sender[]
  cc: Sender[]
  source: ReplyRecipientSource
}

const normalize = (email: string) => email.trim().toLowerCase()

/** Normalize delivery aliases only for deciding whether an address is "me".
 * Plus tags route to the same mailbox on providers that support them. Consumer
 * Gmail also ignores dots and treats googlemail.com as gmail.com. Do not use
 * this for outgoing addresses: the exact address still matters to the user. */
function normalizeSelfAddress(email: string): string {
  const normalized = normalize(email)
  const separator = normalized.lastIndexOf('@')
  if (separator === -1) return normalized

  let local = normalized.slice(0, separator).replace(/\+.*/, '')
  let domain = normalized.slice(separator + 1)
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replaceAll('.', '')
    domain = 'gmail.com'
  }
  return `${local}@${domain}`
}

/** Case-insensitive dedupe that keeps the first occurrence (and its display name). */
function dedupe(addresses: Sender[]): Sender[] {
  const seen = new Set<string>()
  const out: Sender[] = []
  for (const a of addresses) {
    const key = normalize(a.email)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

/**
 * Resolve the recipients of a reply to a thread.
 *
 * The naive rule ("reply to the sender of the last message") silently mails you
 * back when the last message in the thread is one *you* sent — which is the
 * common case right after you send something. It also breaks on drafts (whose
 * From is you and whose Message-ID is empty) and on Reply-To headers that carry
 * a display name, because the raw header string is not a bare address.
 *
 * Resolution order:
 *   1. explicit `to` (from --to) wins outright
 *   2. anchor's Reply-To (parsed as an address list), else its From
 *   3. if those are all me: the anchor's To: recipients minus me
 *   4. else: walk backwards for the most recent message not sent by me
 *   5. else: SelfRecipientError / AmbiguousRecipientError
 *
 * Self matching is case-insensitive and treats plus-tagged variants as the same
 * mailbox. Gmail/Googlemail dotted variants are equivalent too. This is used
 * only by the safety guard; outgoing addresses retain their exact spelling.
 */
export function resolveReplyRecipients<M extends ReplyAnchorMessage>({
  messages,
  selfAddresses,
  threadId,
  replyAll = false,
  explicitTo,
  extraCc,
  allowSelf = false,
}: {
  messages: M[]
  /** Account address plus any send-as aliases. Compared case-insensitively. */
  selfAddresses: string[]
  threadId: string
  replyAll?: boolean
  explicitTo?: Sender[]
  extraCc?: Sender[]
  /** Allow self only when no external recipient can be inferred. */
  allowSelf?: boolean
}): ReplyResolution<M> | SelfRecipientError | AmbiguousRecipientError {
  const self = new Set(selfAddresses.map(normalizeSelfAddress).filter(Boolean))
  const isSelf = (a: Sender) => self.has(normalizeSelfAddress(a.email))
  /** Drop empty addresses and the parser's fallback placeholder — never mail those. */
  const usable = (a: Sender) => {
    const email = normalize(a.email)
    return email.length > 0 && email !== FALLBACK_SENDER.email
  }

  // Drafts have no Message-ID and are always "from me", so they must never
  // drive recipients or threading headers.
  const anchor = threadAnchor(messages)
  if (!anchor) return new AmbiguousRecipientError({ threadId })

  const resolveTo = (): { to: Sender[]; source: ReplyRecipientSource } | SelfRecipientError | AmbiguousRecipientError => {
    if (explicitTo && explicitTo.length > 0) {
      return { to: explicitTo, source: 'explicit' }
    }

    // Reply-To is an address list header; parse it instead of using the raw string.
    const replyToAddresses = (anchor.replyTo ? parseAddressList(anchor.replyTo) : []).filter(usable)
    const candidates = (replyToAddresses.length > 0 ? replyToAddresses : [anchor.from]).filter(usable)
    const candidateSource: ReplyRecipientSource = replyToAddresses.length > 0 ? 'reply-to' : 'from'

    const external = candidates.filter((a) => !isSelf(a))
    if (external.length > 0) return { to: external, source: candidateSource }

    // The anchor was sent by me: the counterparty is who I sent it to.
    const anchorRecipients = anchor.to.filter(usable).filter((a) => !isSelf(a))
    if (anchorRecipients.length > 0) return { to: anchorRecipients, source: 'recipients' }

    // Self-addressed anchor: walk backwards for the last message from someone else.
    const anchorIndex = messages.indexOf(anchor)
    for (let i = anchorIndex - 1; i >= 0; i--) {
      const msg = messages[i]!
      if (msg.isDraft) continue
      const prev = (msg.replyTo ? parseAddressList(msg.replyTo) : [msg.from])
        .filter(usable)
        .filter((a) => !isSelf(a))
      if (prev.length > 0) return { to: prev, source: 'previous-sender' }
      const prevRecipients = msg.to.filter(usable).filter((a) => !isSelf(a))
      if (prevRecipients.length > 0) return { to: prevRecipients, source: 'previous-sender' }
    }

    const candidate = candidates[0]
    if (candidate) {
      if (allowSelf) return { to: [candidate], source: candidateSource }
      return new SelfRecipientError({
        recipient: candidate.email,
        account: selfAddresses[0] ?? candidate.email,
      })
    }
    return new AmbiguousRecipientError({ threadId })
  }

  const resolved = resolveTo()
  if (resolved instanceof Error) return resolved

  const to = dedupe(resolved.to.filter(usable))
  if (to.length === 0) return new AmbiguousRecipientError({ threadId })
  const toKeys = new Set(to.map((a) => normalize(a.email)))

  const cc: Sender[] = []
  if (replyAll) {
    const everyone = [...anchor.to, ...(anchor.cc ?? [])]
    for (const a of everyone) {
      if (isSelf(a)) continue
      if (toKeys.has(normalize(a.email))) continue
      cc.push(a)
    }
  }
  // Explicit --cc is always honored, even without --all.
  for (const a of extraCc ?? []) {
    if (toKeys.has(normalize(a.email))) continue
    cc.push(a)
  }

  return { anchor, to, cc: dedupe(cc), source: resolved.source }
}
