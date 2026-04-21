# Changelog

## 0.3.21

- **`--limit` everywhere** — replaces `--max` on `mail list`, `mail search`, `cal events`, and `draft list`. Controls how many results are fetched and shown (default: 20):

  ```bash
  zele mail list --limit 5
  zele mail list --filter "is:unread" --limit 10
  zele mail search "from:github" --limit 50
  zele cal events --limit 5
  zele draft list --limit 10
  ```

- **`--filter` everywhere** — replaces `--query` on `cal events`, `draft list`, and `mail watch`. Now consistent with `mail list`:

  ```bash
  zele cal events --filter "standup"
  zele draft list --filter "invoice"
  zele mail watch --filter "from:github"
  ```

## 0.3.20

1. **`--draft` flag on `mail reply` and `mail forward`** — save as draft instead of sending immediately:

   ```bash
   # Draft a reply — sets In-Reply-To, References, and Re: subject automatically
   zele mail reply <threadId> --body "sounds good" --draft

   # Draft a reply-all
   zele mail reply <threadId> --body "sounds good" --all --draft

   # Draft a forward
   zele mail forward <threadId> --to colleague@example.com --draft
   ```

   The draft is created with full threading headers (`In-Reply-To`, `References`) so it appears correctly inside the original thread in Gmail. For Gmail accounts, the draft is associated with the thread via the API `threadId` field. For IMAP accounts, the headers are set in the raw MIME message appended to the Drafts folder.

2. **`draft update <draftId>`** — update the content of an existing draft, preserving unchanged fields:

   ```bash
   # Change just the body
   zele draft update <draftId> --body "updated text"

   # Read new body from stdin
   echo "new body" | zele draft update <draftId> --body-file -

   # Change recipients and subject
   zele draft update <draftId> --to new@example.com --subject "New subject"
   ```

   Fetches the existing draft first and merges — only the fields you provide are changed. Thread association and send-as alias are preserved automatically.

3. **`mail unsubscribe <threadId>`** — unsubscribe from mailing lists using standard headers (RFC 2369 `List-Unsubscribe` + RFC 8058 one-click):

   ```bash
   # Auto mode (prefers one-click → mailto → url)
   zele mail unsubscribe <threadId>

   # Preview only
   zele mail unsubscribe <threadId> --dry-run

   # Force a specific mechanism
   zele mail unsubscribe <threadId> --via mailto
   zele mail unsubscribe <threadId> --via one-click

   # Archive or trash after unsubscribing
   zele mail unsubscribe <threadId> --then archive
   ```

   One-click (`--via one-click`) sends an HTTPS POST with `List-Unsubscribe=One-Click`. In auto mode, one-click is only used when the message passes DKIM to prevent spoofed headers from triggering background requests. An SSRF guard blocks requests to localhost, RFC 1918, and link-local ranges.

4. **`can_unsubscribe` and `one_click` in `mail list` / `mail search`** — every thread row now shows whether a standardized unsubscribe mechanism is present, so you can spot newsletters at a glance.

5. **Fixed timeout on slow unsubscribe endpoints** — one-click POST requests now time out after 10 s via `AbortSignal.timeout()` so a slow endpoint can't hang the CLI.

6. **`mail unsubscribe` tolerates 3xx redirects** — many real senders (ConvertKit, SendGrid, Mailchimp) redirect after processing the POST. 3xx is now treated as success with a warning, instead of failing. 4xx/5xx still fail.

## 0.3.19

1. **`can_unsubscribe` and `one_click` fields in `mail list` / `mail search`** — every thread row now shows whether a standardized unsubscribe mechanism is advertised, so you can spot newsletters at a glance:

   ```yaml
   - id: 19d799bb39a035fc
     from: Karan at Cartesia <changelog@mail.cartesia.ai>
     subject: What's Cooking at Cartesia | March 2026
     can_unsubscribe: true
     one_click: true
     unsubscribe: <mailto:...>, <https://app.loops.so/unsubscribe/...>
   ```

   `can_unsubscribe: true` means the message has a usable `List-Unsubscribe` header (RFC 2369). `one_click: true` additionally means it has a valid RFC 8058 one-click setup (`List-Unsubscribe-Post: List-Unsubscribe=One-Click` plus an `https:` URL). Both fields are omitted when false to keep the output clean. Works for Gmail accounts; IMAP list views use envelope-only fetches so these flags stay off in list mode but still populate correctly on `getThread()`.

2. **`oneClickPost` fetch timeout lowered from 15 s → 5 s** via `AbortSignal.timeout()` so a slow or unreachable unsubscribe endpoint can't hang the CLI.

3. **`mail unsubscribe` tolerates 3xx redirects from real-world senders.** RFC 8058 §3.1 says senders MUST NOT return HTTP redirects, but many widely-deployed senders (ConvertKit, SendGrid, Mailchimp) redirect the POST to a "you have been unsubscribed" confirmation page after processing the body. The CLI now treats 3xx as success with a stderr warning showing the `Location` header, instead of failing. 4xx/5xx responses still fail as before.

4. **Two new helpers in `src/unsubscribe.ts`** — `hasUnsubscribeMechanism()` and `hasOneClickUnsubscribe()` — pure functions that power the new list output without building a full plan. Both covered by new inline-snapshot tests.

## 0.3.18

1. **`mail unsubscribe <threadId>`** — unsubscribe from mailing list threads using the standard headers (RFC 2369 `List-Unsubscribe` + RFC 8058 `List-Unsubscribe-Post` one-click):

   ```bash
   # Auto (prefers RFC 8058 one-click → mailto → url)
   zele mail unsubscribe 19d0f2a

   # Plan only, do not execute
   zele mail unsubscribe 19d0f2a --dry-run

   # Force a specific mechanism
   zele mail unsubscribe 19d0f2a --via mailto
   zele mail unsubscribe 19d0f2a --via one-click --require-dkim

   # Follow up after unsubscribing
   zele mail unsubscribe 19d0f2a --then archive
   zele mail unsubscribe 19d0f2a --then trash
   ```

   Execution details:

   - **One-click (RFC 8058)**: issues an HTTPS `POST` with body `List-Unsubscribe=One-Click`, no cookies, no auth, and no HTTP redirects (senders MUST NOT redirect — 3xx is treated as failure).
   - **`mailto:` (RFC 2369)**: sends the canonical unsubscribe email using the subject/body/cc encoded in the header's query params, via `GmailClient.sendMessage()` or `ImapSmtpClient.sendMessage()` (SMTP) depending on account type.
   - **`http(s):` landing page**: printed to stdout for manual action when only a legacy URL is available.
   - `--require-dkim` refuses one-click unless the message has `auth.authentic === true` (Gmail only — IMAP accounts lack SPF/DKIM/DMARC verdicts).

   Works for **Google** and **IMAP/SMTP** accounts. The decision logic is pure and lives in `src/unsubscribe.ts` for easy testing.

2. **`ParsedMessage.listUnsubscribePost`** — both Gmail and IMAP parsers now extract the RFC 8058 `List-Unsubscribe-Post` header so one-click capability is visible without re-fetching raw headers. The IMAP parser reads it directly from the raw MIME source that `getThread()` already fetches.

3. **Hardened `mail unsubscribe` based on oracle review**:

   - **One-click is default-off unless DKIM passes** — in `--via auto` mode, one-click is only used when the message has `auth.dkim === 'pass'`. Spoofed `List-Unsubscribe-Post` headers on unauthenticated spam can no longer trigger background HTTPS POSTs. Users can still force it with `--via one-click`.
   - **DKIM gate uses `auth.dkim === 'pass'`** instead of the stricter `auth.authentic` (which required SPF + DKIM + DMARC all passing). This matches what RFC 8058 §4 actually cares about.
   - **SSRF guard** — `oneClickPost()` rejects `http:` URLs, localhost, loopback, RFC 1918, link-local, and IPv6 ULA ranges before issuing the POST, so a spoofed `List-Unsubscribe` header can't make the CLI hit internal services.
   - **15 s fetch timeout** via `AbortSignal.timeout()` so a slow endpoint can't hang the CLI.
   - **Sender-order preservation** — non-one-click fallbacks are emitted in the order the sender declared them in `List-Unsubscribe` (RFC 2369 §2 left-to-right preference), instead of always grouping mailto before url.
   - **`mailto:` parser no longer rewrites `+` to space** — RFC 6068 `mailto:` URIs are not form-urlencoded, so `foo+tag@example.com` stays intact instead of turning into `foo tag@example.com`.
   - **CRLF sanitization** — `to`, `cc`, and `subject` parsed from `mailto:` headers have `\r` and `\n` stripped as defense-in-depth against header injection. `body` keeps newlines since it becomes message content.
   - **Partial-success UX** — when `--then archive` or `--then trash` fails, the command now prints the unsubscribe success first so users can see that the irreversible action already completed, then reports the follow-up failure as a non-fatal warning.

## 0.3.17

1. **IMAP/SMTP account support** — connect any email provider (Fastmail, Outlook, Gmail app passwords, or any IMAP server) alongside existing Google OAuth accounts:

   ```bash
   # Fastmail
   zele login imap \
     --email you@fastmail.com \
     --imap-host imap.fastmail.com --imap-port 993 \
     --smtp-host smtp.fastmail.com --smtp-port 465 \
     --password "your-app-password"

   # Outlook
   zele login imap \
     --email you@outlook.com \
     --imap-host outlook.office365.com --imap-port 993 \
     --smtp-host smtp-mail.outlook.com --smtp-port 587 \
     --password "your-password"

   # IMAP-only (no sending)
   zele login imap \
     --email reader@example.com \
     --imap-host imap.example.com \
     --password "pass"
   ```

   All read/write mail commands work with IMAP accounts: `mail list`, `mail read`, `mail search`, `mail send`, `mail reply`, `mail forward`, `mail star`, `mail archive`, `mail trash`, `mail mark-read`, `draft list`, `draft send`, etc. Google-only features (labels, filters, calendar) show a clear error when used with IMAP accounts.

   `mail list` and `mail search` merge results from Google and IMAP accounts automatically. RFC 6154 special-use folder detection means sent/drafts/trash resolve correctly across providers (including Outlook "Sent Items", localized Gmail folders, etc.).

   `whoami` shows account type and capabilities for each connected account.

2. **Email authentication verification (SPF/DKIM/DMARC)** — `mail read` now shows structured auth verdicts per message:

   ```
   auth: spf=pass dkim=pass dmarc=pass ✓
   ```

   Use `--verify` to see the raw `Authentication-Results` header. The `authentic` boolean field is useful for agents acting on sensitive emails (e.g. subscription cancellations):

   ```bash
   zele mail read <thread-id> | yq '.messages[0].auth.authentic'
   ```

## 0.3.16

1. **Richer `mail list` / `mail search` output** — threads now show recipient, snippet, labels, and attachment/reply flags alongside the existing from/subject/date:

   ```yaml
   - id: 19ccf065cd1242d4
     from: GitHub <noreply@github.com>
     to: you@example.com
     subject: "PR merged: fix timeout"
     snippet: "Your pull request was merged into main..."
     flags: [unread, attachment]
     labels: [work]
     date: 2026-03-19
   ```

   `cc` and `unsubscribe` fields are included when present.

2. **`mail read` accepts multiple thread IDs** — fetch several threads in one call:

   ```bash
   zele mail read 19ccf065 1a3b4c5d 1f2e3d4c
   ```

   Threads are fetched concurrently. Each gets a separator header (`Thread 2/3 · <id>`). Single-thread output is unchanged. `--raw` is restricted to one ID; `--raw-html` works per-thread.

3. **`--filter` option for `mail list`** — pass Gmail search operators directly:

   ```bash
   zele mail list --filter "is:unread"
   zele mail list --filter "has:attachment from:github"
   zele mail list --filter "label:work newer_than:7d"
   ```

   Composes with existing `--folder` and `--label` options.

4. **Mark threads as spam / remove from spam** — two new mail action commands:

   ```bash
   zele mail spam <thread-id>      # mark as spam (adds SPAM label, removes from inbox)
   zele mail unspam <thread-id>    # remove from spam (removes SPAM label, moves to inbox)
   ```

   Both accept multiple thread IDs like the other bulk actions (`star`, `archive`, etc.).

5. **`next_page` token shown in `mail list`, `mail search`, `draft list`** — pagination now works end-to-end:

   ```bash
   zele mail list --account you@example.com > page1.yaml
   # grab next_page value from output, then:
   zele mail list --account you@example.com --page <token>
   ```

6. **Fixed `--to` date-only resolving to start of day in `cal events`** — `--from 2026-03-12 --to 2026-03-12` now correctly matches events on that day. Previously both dates resolved to `00:00`, producing a zero-width range with no results.

## 0.3.15

**Mail TUI: Mailbox folder switching**

The actions panel (`Ctrl+K`) now has a **Mailbox** section to switch between folders without leaving the TUI:

| Folder | Gmail label |
|--------|-------------|
| Inbox | `INBOX` |
| Sent | `SENT` |
| Starred | `STARRED` |
| Drafts | `DRAFT` |
| Archive | (no label) |
| Spam | `SPAM` |
| Trash | `TRASH` |
| All Mail | `UNREAD` |

The search bar placeholder updates to reflect the active folder (e.g. `Search Sent...`). Active folder is persisted across sessions.

**Mail TUI: Compose/reply placeholder with signature template**

The body field in reply, reply-all, and forward forms now shows a multi-line placeholder with a signature block:

```
Type your reply...

---

Best,
Name
```

**Security fixes** (thanks @nullvariable for all four!)

- **Attachment path traversal** — `attachment get` now validates that the resolved output path stays within `--out-dir`, stripping directory components, null bytes, control chars, and Windows reserved names from filenames. Filenames are capped at 255 characters.
- **CRLF injection in email headers** — `In-Reply-To` and `References` header values are sanitized before being passed to mimetext, preventing header injection via malicious message-id values (CWE-93).
- **Database file permissions** — `~/.zele` directory is created with mode `0700` and database files (`sqlite.db`, `-wal`, `-shm`) are secured with mode `0600`, preventing token exposure on multi-user systems.
- **Gmail query injection via folder param** — the `folder` parameter is validated against an allowlist before being interpolated into Gmail search queries.

**Dependencies:** termcast `1.3.50 → 1.3.53`, tuistory `0.0.15 → 0.0.16`

## 0.3.14

- **Mail:** Add `--attach` flag to `mail send` command for sending file attachments (supports multiple files)
- **Mail TUI:** Auto-mark threads as read when opening detail view
- **Mail TUI:** Persist selected account and detail panel visibility across sessions
- **Output:** Clean up command outputs by removing comment prefixes
- **Build:** Drop bin/zele shell wrapper, point bin to dist/cli.js directly (requires bun installation)
- **Dependencies:** Bump termcast to 1.3.48 for latest TUI improvements

## 0.3.13

- **Mail TUI:** Add global mutation loading state for archive, star, trash, and mark read/unread operations
- **Mail TUI:** Separate action panels for selection mode vs normal mode for clearer UI
- **Mail TUI:** Fix pagination calculation to account for relaxed list spacing (3 lines per item)
- **Mail TUI:** Unify reply/forward forms into single ComposeForm with account selector dropdown
- **Mail TUI:** Clean up account dropdown styling and remove destructive action styles
- **Gmail Client:** Show other party in thread list instead of own email when user sent latest reply
- **Gmail Client:** Convert static parse methods to instance methods for simpler code
- **Dependencies:** Bump termcast to 1.3.47 to fix React reconciler issues on Windows

## 0.3.12

- **Build:** Fix build script to run `bun run generate` before TypeScript compilation to ensure Prisma client is generated
- **Build:** Use bun instead of pnpm in build script to match package manager configuration

## 0.3.11

- **Code Quality:** Add Prettier configuration and format entire codebase for consistent style
- **Mail TUI:** Swap unread/starred icon colors (unread now yellow, starred now orange) for better visual hierarchy
- **Dependencies:** Lock Prisma versions to `7.3.0` (remove `^` prefix) for more predictable builds

## 0.3.10

- **Dependencies:** Bump `termcast` to `^1.3.45`

## 0.3.9

- **Dependencies:** Remove unused `@opentui/core` and `@opentui/react` dependencies (already provided by termcast)

## 0.3.8

- **Dependencies:** Bump `@opentuah/core` and `@opentuah/react` to `^0.1.90` for latest TUI improvements

## 0.3.7

- **Auth:** Improve OAuth callback page (dark mode, clearer errors, and copy/paste-friendly next steps)
- **Mail TUI:** Make pagination adapt to terminal height via `useTerminalDimensions`
- **Mail TUI:** Tweak unread styling colors for better contrast
- **Dependencies:** Bump Termcast and track latest `@opentuah` releases via `@opentui/*` aliasing

## 0.3.6

- **TUI Auth:** Auto-run `zele login` before launching the root TUI command when no accounts are registered
- **Mail Command:** Auto-run `zele login` before launching `zele mail` TUI when no accounts are registered

## 0.3.5

- **TUI:** Switch `mail-tui` `useCachedPromise` import from `@raycast/utils` to `@termcast/utils` for Termcast-native compatibility
- **Dependencies:** Bump `@termcast/utils` to `^2.2.6` and remove `@raycast/api` from dev dependencies to avoid Raycast/Bun resolution issues
- **Build:** Set `noImplicitAny: false` in `tsconfig.json` to keep TypeScript builds green with updated TUI/runtime dependencies

## 0.3.4

- **Attachments:** Change `attachment list` to accept a `thread-id` and list attachments across all messages in the thread
- **Attachments:** Include `thread_id`, `message_id`, and `attachment_id` in list output so `attachment get` IDs are directly discoverable

## 0.3.3

- **Auth:** Remove legacy `~/.zele/tokens.json` import path; authentication now uses the SQLite `accounts` table only
- **Auth:** Drop startup migration hooks from account/client/status loading paths (no backwards-compat token file handling)

## 0.3.2

- **CLI:** Remove all `--no-cache` flags and corresponding client `noCache` params now that remaining caches are safe-by-default
- **Cache:** Keep automatic caching only for safe paths (per-thread hydration, labels, profile, calendar list) with no user-facing stale toggles

## 0.3.1

- **Cache:** Always fetch fresh data for `mail list`, `mail search`, `label counts`, and `cal events` to avoid stale CLI output
- **Cache:** Keep per-thread cache for expensive N+1 thread hydration in mail list/search and reuse cached thread payloads when history IDs match
- **Database:** Remove obsolete cache tables for thread-list, calendar-event-list, and label-count result caching
- **CLI:** Remove ineffective `--no-cache` flags from commands that are now always fresh (`label counts`, `cal events`)

## 0.3.0

- **Mail:** Add `mail watch` command for polling new emails using Gmail History API (incremental sync)
- **Mail:** Add support for Gmail search operators in `watch --query` (e.g., `from:github`, `is:unread`)
- **Mail:** Show sender email address in `from` fields for better clarity
- **Fixes:** Improve query parsing and handle server-only operators correctly

## 0.2.0

- **Calendar:** Add comprehensive calendar commands (`cal list`, `events`, `get`, `create`, `update`, `delete`, `respond`, `freebusy`)
- **Calendar:** Use CalDAV protocol instead of Google REST API for better compatibility and efficiency
- **Calendar:** Add local caching for calendar lists and events
- **Auth:** Breaking change: `auth` namespace removed. Use `zele login`, `zele logout`, `zele whoami` directly
- **Docs:** Add comprehensive README with install, setup, and command reference
- **Fixes:** Improved error logging with stack traces
- **Internal:** Remove focus/ooo commands (use `cal create` instead)


## 0.1.3

- Add CHANGELOG.md
- Add changelog guidance to AGENTS.md

## 0.1.2

- Replace monolithic `googleapis` with scoped `@googleapis/gmail` for smaller install size

## 0.1.1

- Rename package from `gtui` to `zele`
- Rename config directory `~/.gtui` to `~/.zele`, database `gtui.db` to `zele.db`
- Rename env vars `GTUI_CLIENT_ID`/`GTUI_CLIENT_SECRET` to `ZELE_CLIENT_ID`/`ZELE_CLIENT_SECRET`
- Style login flow with picocolors (bold steps, cyan URL, dim hints, yellow warnings)

## 0.1.0

- Initial release as `gtui`
- Multi-account Gmail CLI with OAuth2 authentication
- Commands: mail (list, search, read, send, reply, forward), drafts, labels, attachments, profile
- Prisma-backed SQLite cache with TTL-based expiry
- YAML output with TTY-aware coloring
