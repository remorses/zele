# Changelog

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
## 0.3.13 (fork)

- **Filters:** Add `filter list`, `filter create`, `filter delete` commands for managing Gmail filters
- **Auth:** Add `gmail.settings.basic` scope for filter management


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
