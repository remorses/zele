// Unsubscribe header parsing and mechanism planning.
// Implements RFC 2369 (List-Unsubscribe) + RFC 8058 (List-Unsubscribe-Post
// One-Click). Pure functions only — no network, no client access.
//
// RFC 2369 says List-Unsubscribe contains one or more angle-bracket-enclosed
// URIs, comma-separated. Each URI is either mailto: (send an email) or
// http(s): (a landing page).
//
// RFC 8058 adds one-click: when both List-Unsubscribe and
// List-Unsubscribe-Post (with the single value "List-Unsubscribe=One-Click")
// are present, a client can POST `List-Unsubscribe=One-Click` to the https
// URL with no cookies, no auth, and no redirects allowed.

export interface MailtoSpec {
  to: string
  subject?: string
  body?: string
  cc?: string[]
}

export type UnsubscribeMechanism =
  | { kind: 'one-click'; url: string }
  | { kind: 'mailto'; mailto: MailtoSpec }
  | { kind: 'url'; url: string }

export interface UnsubscribePlan {
  /** Mechanisms in preference order: one-click > mailto > url. */
  mechanisms: UnsubscribeMechanism[]
  /** True when RFC 8058 one-click is available (both headers present, https URL). */
  hasOneClick: boolean
  /** True if DKIM passed, false if failed, null if unknown (e.g. IMAP, sent mail). */
  dkimAuthentic: boolean | null
  /** Non-fatal concerns the caller may want to surface. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Split a List-Unsubscribe header into its `<URI>` entries. Commas only
 * separate entries when they are outside angle brackets; whitespace and
 * line folding inside the header are tolerated per RFC 2369 §2.
 */
export function parseListUnsubscribeEntries(header: string): string[] {
  if (!header) return []
  const entries: string[] = []
  let depth = 0
  let current = ''
  for (const ch of header) {
    if (ch === '<') {
      depth++
      current += ch
      continue
    }
    if (ch === '>') {
      depth = Math.max(0, depth - 1)
      current += ch
      continue
    }
    if (ch === ',' && depth === 0) {
      entries.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim().length > 0) entries.push(current)

  // Extract the URI inside each angle bracket pair. Anything outside is ignored
  // (comments, trailing text) per RFC 2369 §2 guideline 2.
  const result: string[] = []
  for (const raw of entries) {
    const match = raw.match(/<([^>]*)>/)
    if (!match) continue
    const uri = match[1]!.replace(/\s+/g, '').trim()
    if (uri.length > 0) result.push(uri)
  }
  return result
}

/**
 * Parse a mailto: URI into its target address and optional subject/body/cc.
 * Returns null if the URI is not a valid mailto.
 *
 * Supports percent-encoding per RFC 6068. Note: `mailto:` is NOT
 * application/x-www-form-urlencoded, so `+` is preserved literally (this
 * matters for plus-addressing like `foo+tag@example.com`).
 */
export function parseMailto(uri: string): MailtoSpec | null {
  if (!/^mailto:/i.test(uri)) return null
  const afterScheme = uri.slice('mailto:'.length)
  const qIndex = afterScheme.indexOf('?')
  const rawTo = qIndex === -1 ? afterScheme : afterScheme.slice(0, qIndex)
  const query = qIndex === -1 ? '' : afterScheme.slice(qIndex + 1)

  const decode = (s: string): string => {
    try {
      // RFC 6068: only percent-decode. Do NOT rewrite `+` → space.
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }

  // Strip CRLF (defense-in-depth against header injection through mailto
  // fields that get passed to SMTP/mimetext). Only body is allowed to keep
  // newlines because it becomes message content.
  const sanitizeHeader = (s: string) => s.replace(/[\r\n]/g, '').trim()

  const to = sanitizeHeader(decode(rawTo))
  if (!to) return null

  const spec: MailtoSpec = { to }
  if (!query) return spec

  const cc: string[] = []
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase()
    const value = eq === -1 ? '' : decode(pair.slice(eq + 1))
    if (key === 'subject') spec.subject = sanitizeHeader(value)
    else if (key === 'body') spec.body = value
    else if (key === 'cc') {
      for (const addr of value.split(',')) {
        const trimmed = sanitizeHeader(addr)
        if (trimmed) cc.push(trimmed)
      }
    }
  }
  if (cc.length > 0) spec.cc = cc
  return spec
}

/**
 * Parse a List-Unsubscribe-Post header value. Per RFC 8058 §5 the only legal
 * value is exactly `List-Unsubscribe=One-Click`. Whitespace-tolerant.
 */
export function parseListUnsubscribePost(header: string | undefined): boolean {
  if (!header) return false
  return header.replace(/\s+/g, '').toLowerCase() === 'list-unsubscribe=one-click'
}

/**
 * Lightweight check for whether a message has any standardized unsubscribe
 * mechanism advertised. Used by list views that want to surface a
 * `can_unsubscribe` boolean without building a full plan. Returns true when
 * List-Unsubscribe contains at least one valid mailto: or http(s): entry.
 */
export function hasUnsubscribeMechanism(listUnsubscribe: string | null | undefined): boolean {
  if (!listUnsubscribe) return false
  const entries = parseListUnsubscribeEntries(listUnsubscribe)
  return entries.some((e) => /^(mailto|https?):/i.test(e))
}

/**
 * Check whether a message advertises RFC 8058 one-click unsubscribe: both
 * List-Unsubscribe-Post=One-Click and at least one https: URL in
 * List-Unsubscribe. Does not check DKIM — the executor is responsible for
 * that gating at the point of actually POSTing.
 */
export function hasOneClickUnsubscribe(
  listUnsubscribe: string | null | undefined,
  listUnsubscribePost: string | null | undefined,
): boolean {
  if (!parseListUnsubscribePost(listUnsubscribePost ?? undefined)) return false
  if (!listUnsubscribe) return false
  return parseListUnsubscribeEntries(listUnsubscribe).some((e) => /^https:/i.test(e))
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Build an unsubscribe plan from the raw headers + DKIM authenticity flag.
 *
 * Preference order:
 *   1. RFC 8058 one-click (List-Unsubscribe-Post present + https URL).
 *      Emitted first because it is the spec-preferred programmatic path.
 *   2. The remaining entries in sender-declared order (RFC 2369 §2 says
 *      clients should prefer left-to-right order). Each http(s): entry
 *      becomes a `url` mechanism, each mailto: entry becomes a `mailto`.
 */
export function planUnsubscribe({
  listUnsubscribe,
  listUnsubscribePost,
  dkimAuthentic,
}: {
  listUnsubscribe: string | undefined
  listUnsubscribePost: string | undefined
  /** True iff DKIM=pass on the message. Null when unknown (IMAP, sent mail). */
  dkimAuthentic: boolean | null
}): UnsubscribePlan {
  const warnings: string[] = []
  const mechanisms: UnsubscribeMechanism[] = []

  const entries = listUnsubscribe ? parseListUnsubscribeEntries(listUnsubscribe) : []
  const postOneClick = parseListUnsubscribePost(listUnsubscribePost)

  // First pass: RFC 8058 one-click extraction. Any https entries become
  // one-click candidates if the Post header is present.
  const oneClickUrls = new Set<string>()
  let hasOneClick = false
  if (postOneClick) {
    const httpsEntries = entries.filter((e) => /^https:/i.test(e))
    if (httpsEntries.length > 0) {
      hasOneClick = true
      for (const url of httpsEntries) {
        mechanisms.push({ kind: 'one-click', url })
        oneClickUrls.add(url)
      }
    } else if (entries.some((e) => /^http:/i.test(e))) {
      warnings.push('List-Unsubscribe-Post is present but no https URL (only http); RFC 8058 requires https')
    } else {
      warnings.push('List-Unsubscribe-Post is present but no http(s) URL to POST to')
    }
  }

  // Second pass: legacy fallbacks in sender-declared order (RFC 2369 §2
  // left-to-right preference). http(s) URLs already claimed by one-click
  // are skipped so we don't emit duplicate mechanisms.
  for (const uri of entries) {
    if (/^mailto:/i.test(uri)) {
      const mailto = parseMailto(uri)
      if (mailto) mechanisms.push({ kind: 'mailto', mailto })
      continue
    }
    if (/^https?:/i.test(uri)) {
      if (oneClickUrls.has(uri)) continue
      mechanisms.push({ kind: 'url', url: uri })
      continue
    }
  }

  // DKIM safety notes for one-click. RFC 8058 §4 says the message SHOULD have
  // a valid DKIM signature covering both headers; we approximate with a
  // DKIM=pass verdict from the receiving MTA.
  if (hasOneClick) {
    if (dkimAuthentic === false) {
      warnings.push('DKIM did not pass; one-click may be spoofed by an attacker')
    } else if (dkimAuthentic === null) {
      warnings.push('DKIM status unknown (no authentication info on this message)')
    }
  }

  return {
    mechanisms,
    hasOneClick,
    dkimAuthentic,
    warnings,
  }
}
