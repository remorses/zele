# Changelog

## 0.11.0

1. **Drafts with attachments** — `draft create` and `draft update` accept repeatable `--attach <file>`, like `mail send`:

   ```bash
   zele draft create --to bob@example.com --subject "Report" --body "Attached" --attach report.pdf --attach logo.png
   zele draft update <draft-id> --attach extra.pdf  # adds a file, keeps existing ones
   ```

   `draft update` keeps the attachments the draft already has. Before, any update dropped them. On IMAP, drafts keep their attachments when created, updated and sent, and a failed update no longer loses the draft.

2. **Replies mark the thread as read** — `mail reply` (with or without `--all`), `mail send --thread-id` and TUI replies mark the thread read after sending, on Gmail and IMAP. If marking read fails, zele prints a warning but still reports the reply as sent.

3. **`mail read` shows each message's ID** — so a `mail watch` match can be checked against the thread. `--verify` also shows `Message-ID`, `In-Reply-To` and `References`.

4. **Fixed `attachment get`** — on Gmail, files save with their real filename and already downloaded files are skipped. Attachment IDs are now stable MIME part IDs (like `1` or `0.2`) instead of Gmail IDs that change on every fetch. On IMAP, it saves the real file instead of base64 text, and `.txt` or `.html` attachments are no longer shown as the message body.

5. **Fixed `mail watch` on Gmail returning an old message right after start** — watch now reads a live history cursor instead of a cached profile, also when the cursor expires.

## 0.10.0

1. **Free, permanent `@zele.sh` email addresses** (receive-only for now). Sign in with a @gmail.com owner and create up to 10 addresses for yourself, a project, or your agents:

   ```bash
   zele login zele --owner you@gmail.com --name tommy
   zele inbox create bills
   zele inbox list
   zele mail list --account tommy@zele.sh
   ```

   The sign-in code is read automatically from the owner Gmail when it is already a zele account; otherwise pass `--code`. Each inbox works with `mail list`, `mail read`, `mail search`, `mail watch`, star, archive, trash, spam, and attachments. Sending, drafts, and labels return a clear "receive-only" error. `zele logout zele` signs out and removes the inbox accounts from this machine.

2. **`mail watch` is now the way to wait for a reply after sending** — `mail send` and `mail reply` print the exact watch command to run next:

   ```bash
   zele mail send --to bob@example.com --subject "Question" --body "Hey"
   # Wait for the reply: zele mail watch --account me@example.com --filter 'from:bob@example.com subject:"Question"' --timeout 259200
   ```

   - `mail watch` prints how long it waited: an `elapsed` field on the match, `Timed out after 3d 0h 0m 0s` on timeout, and `# Still watching, 3m 0s elapsed` on stderr every minute
   - `mail watch` no longer exits on a network error. It prints `# Poll failed ..., retrying` and polls again, so a watch can run for days. Auth errors still stop it

3. **Fixed `mail watch` on Gmail returning an old email as a match** — it reused a history cursor from an earlier run and replayed emails that arrived since then. Now only emails that arrive after the command starts can match, same as IMAP.

## 0.9.0

1. **Proton Mail Bridge and self-signed IMAP/SMTP servers** — `login imap` now works with local TLS endpoints that use their own certificate:

   ```bash
   # Proton Bridge default (STARTTLS on 1143/1025), trusting the exported cert
   zele login imap \
     --email you@proton.me \
     --imap-host 127.0.0.1 --imap-port 1143 \
     --smtp-host 127.0.0.1 --smtp-port 1025 \
     --password "<bridge-password>" \
     --no-tls --ca ~/bridge/cert.pem

   # Bridge SSL mode: both listeners use implicit TLS
   zele login imap \
     --email you@proton.me \
     --imap-host 127.0.0.1 --imap-port 1143 \
     --smtp-host 127.0.0.1 --smtp-port 1025 \
     --password "<bridge-password>" \
     --smtp-tls --ca ~/bridge/cert.pem
   ```

   - `--ca <path>` trusts a PEM certificate, such as Bridge's exported `cert.pem`
   - `--smtp-tls` forces implicit TLS on a custom SMTP port
   - `--insecure` skips certificate verification. It is unsafe; prefer `--ca`
   - `--no-tls` disables implicit IMAP TLS. STARTTLS is still used when the server offers it

2. **New `label rename` command** — rename a Gmail label in place. The label keeps its ID and all its threads:

   ```bash
   zele label list
   zele label rename Label_12 Bookings
   ```

3. **`mail search` now finds mail you sent** — before, search looked only in Inbox. IMAP search now looks in **Inbox** and **Sent**; use `in:sent` or `in:inbox` for one mailbox. Gmail search with no `--folder` now searches all mail (spam and trash excluded). Results from both mailboxes are sorted by date across pages. `mail list --folder` stays on that folder even if the filter has a different `in:`.

   ```bash
   zele mail search "to:alice@example.com" --limit 20
   zele mail search "in:sent to:alice@example.com" --limit 20
   ```

4. **No more hard-wrapped Gmail drafts** — Gmail opened text-only drafts in its plain-text composer, which broke long paragraphs into ~78-column lines on send. Plain-text bodies are now sent with an HTML copy, so lines wrap naturally. Text like `Bob <bob@example.com>` or `Vec<String>` is no longer mistaken for HTML. This also fixes forwarded drafts losing their line breaks.

5. **`mail label --add` no longer creates junk labels** — labels created or renamed outside zele were not found, so zele created duplicates, and a label ID like `Label_12` became a new label with that literal name. zele now matches label IDs as well as names, refreshes the label list before it treats a label as missing, and rejects unknown `Label_<n>` IDs.

6. **Fixed `mail list --filter is:unread`** — it no longer returns read or sent threads, and it fills `--limit` with real matches. `from` is now the sender of the latest message, and threads where you sent the latest message show `flags: sent`. `--label Work` resolves label names.

7. **Fixed unreadable non-ASCII IMAP bodies** — Chinese (UTF-8, GBK), Latin-1 accents and Windows-1252 punctuation now show correctly in quoted-printable, base64 and raw bodies.

Thanks @georgantas for #15, @yougeqiu for #16, @emanuelet for #18 and #19, and @Cvikli for finding the draft wrapping bug in #17!

## 0.8.0

1. **Importable mail SDK** — apps can list, read, reply, and mutate mail without spawning the CLI. `import 'zele'` now resolves to `dist/index.js`:

   ```ts
   import {
     listMailThreads,
     readMailThread,
     messageToMarkdown,
     archiveMail,
     replyMail,
   } from 'zele'

   const listed = await listMailThreads({ folder: 'inbox', limit: 20 })
   if (listed instanceof Error) throw listed

   const first = listed.threads[0]
   const thread = await readMailThread({
     threadId: first.id,
     account: first.account,
   })
   if (thread instanceof Error) throw thread

   console.log(messageToMarkdown(thread.messages[0]))
   ```

   The same module also exports `starMail`, `unstarMail`, `trashMail`, `markMailRead`, `markMailUnread`, `getMailAttachment`, plus `listAccounts` and `getClients` for the lower-level Gmail and IMAP clients. Functions return `Error | T` instead of throwing.

2. **IMAP/SMTP `--attach` now survives send** — `--attach` already reached SMTP, but the Sent-folder copy fell back to a plain-text RFC 822 body because `MailComposer` is not a public nodemailer export. Zele now compiles one MIME buffer with `nodemailer/lib/mail-composer` and uses that buffer for both SMTP DATA and IMAP Sent APPEND:

   ```bash
   zele mail send --account you@example.com --to peer@example.com \
     --subject 'Invoice' --body 'Attached.' --attach ./invoice.pdf
   ```

## 0.7.0

1. **Microsoft OAuth for Outlook, Hotmail, and Microsoft 365** — connect Microsoft accounts without an app password:

   ```bash
   zele login microsoft
   zele login microsoft --email you@outlook.com
   zele login --method microsoft
   ```

   Outlook.com requires XOAUTH2 for IMAP and SMTP. Zele opens the Microsoft consent page, stores the resulting tokens, and refreshes access tokens before each connection so long-running commands such as `mail watch` continue after the one-hour token expires.

   In agent and non-TTY environments, browser login starts as a background daemon and returns immediately. Approve the printed URL, then poll for the authenticated account:

   ```bash
   zele login --method microsoft
   zele whoami
   ```

   Outlook accounts appear as `imap_smtp` in `zele whoami`. Mail commands work through IMAP and SMTP; Google-only labels, filters, and calendar commands remain unavailable.

## 0.6.0

1. **Safer `mail reply` recipients** — replies used to go to the sender of the last message. When that last message was yours, the reply landed in your own inbox. Drafts made it worse: a trailing draft became the anchor, so the reply targeted you and lost its `In-Reply-To` header.

   Recipients now come from the thread:

   - the anchor is the last **non-draft** message
   - `Reply-To` is parsed as an address list, so `Reply-To: Paul <paul@acme.com>` and multi-address `Reply-To` work
   - when the last message was sent by you, the reply goes to **its recipients**; if it was self-addressed, zele walks back to the last message from someone else
   - send-as aliases, plus-tagged variants, and Gmail dotted variants count as you

   New flags:

   ```bash
   zele mail reply <thread-id> --dry-run                      # print recipients/sender/threading headers, send nothing
   zele mail reply <thread-id> --to paul@acme.com --body "…"  # override the inferred recipient
   zele mail reply <thread-id> --bcc ops@acme.com --body "…"
   zele mail reply <thread-id> --allow-self --body "…"        # deliberate note to self
   ```

   A reply that would only reach you is **refused** with `SelfRecipientError` instead of being sent silently. `mail reply` prints the resolved recipients on success.

   New `zele mail send --thread-id` sends into an existing thread with correct `In-Reply-To`/`References` (and Gmail's `threadId`):

   ```bash
   zele mail send --thread-id <thread-id> --to paul@acme.com --cc dana@acme.com --body "…"
   ```

2. **`mail reply` requires a prior `mail read`** — agents can no longer reply from a stale thread view. If the latest message changed since the last `mail read`, the command fails with `UnseenLatestError`:

   ```bash
   zele mail read 18f3b7c9d2a1e4f0
   zele mail reply 18f3b7c9d2a1e4f0 --body "sounds good"
   ```

   `--dry-run` still works without a prior read because it does not send. Pass `--force` to skip the check. `mail watch` and `mail list` do not count as a read. The TUI is unchanged.

3. **Reliable local database** — Prisma + `@prisma/adapter-libsql` could acknowledge writes in the same process and then roll them back on exit. That made `mail reply` fail with "latest message was not read" after `mail read`, and it dropped refreshed OAuth tokens.

   The CLI now uses Drizzle with `node:sqlite`. A write is committed when the statement returns. Existing `~/.zele/sqlite.db` files keep working.

   CLI commands now need **Node.js 22.16+**.

## 0.5.0

1. **`mail watch` exits on first match** — `mail watch` now blocks until the first email matching the filter arrives, prints it, and exits with code 0. This makes it useful for agents that need to wait for a specific email (verification codes, replies, etc.). The `--once` flag has been removed since the new behavior subsumes it.

   New `--timeout` flag sets a maximum wait time in seconds. If no matching email arrives before the deadline, the command exits with code 1:

   ```bash
   # wait for a reply from alice
   zele mail watch --filter "is:unread from:alice@example.com"

   # wait for a verification code with a 5-minute timeout
   zele mail watch --filter "is:unread subject:verification" --timeout 300

   # send then wait for the reply
   zele mail send --to bob@example.com --subject "Question" --body "Can you check this?"
   zele mail watch --filter "is:unread from:bob subject:Re:Question" --timeout 600
   ```

2. **Attachment support for `mail reply`** — send file attachments with replies and draft replies via the `--attach` flag:

   ```bash
   zele mail reply <threadId> --body "See attached" --attach report.pdf
   zele mail reply <threadId> --body "Multiple files" --attach a.pdf --attach b.png
   zele mail reply <threadId> --body "Draft with attachment" --attach doc.pdf --draft
   ```

   Works with both Gmail and IMAP/SMTP accounts. The `--attach` flag is repeatable, matching the existing `mail send --attach` behavior. (Closes #14)

3. **Shell completions and goke framework alignment** — install tab completions for zsh and bash via `zele completions install`. AI agents (Claude, Cursor, Codex, etc.) are detected automatically and skip interactive prompts. Google OAuth login fails fast in non-TTY environments with clear instructions instead of hanging. Destructive commands (`cal delete`, `draft delete`, `label delete`) now require `--force` in non-TTY/agent mode.

4. **Interactive IMAP login** — `zele login imap` is now fully interactive in TTY mode: prompts for email, shows a provider preset selector (Fastmail, Gmail, Outlook, Custom) that auto-fills IMAP/SMTP hosts and ports, and prompts for password with masked input. All flags still work for non-interactive/agent use.

5. **Interactive prompts for `cal respond` and `logout`** — `cal respond` prompts for accept/decline/tentative when `--status` is omitted. `logout` shows an account selector when multiple accounts are logged in.

6. **Atomic schema initialization** — schema DDL and column migrations now run inside a single `BEGIN IMMEDIATE` transaction via the libsql client, acquiring the write lock once instead of 13+ separate transactions. Eliminates `SQLITE_BUSY` errors when multiple CLI processes start concurrently (TUI + watch + CLI commands).

7. **Fixed transient SQLITE_BUSY errors** — concurrent process access no longer causes intermittent database busy errors. Thanks @Cyberlane for #13!

## 0.4.0

1. **Run CLI under Node.js** — all CLI subcommands (`mail`, `cal`, `label`, etc.) now work with plain Node.js v18+. The TUI auto-spawns bun when running under Node; if bun isn't installed, it shows install instructions:

   ```bash
   # CLI-only (no bun needed)
   npm install -g zele
   zele mail list --limit 100

   # Full TUI support
   bun install -g zele
   zele
   ```

2. **Fixed child signal propagation** — when the TUI is terminated by a signal (Ctrl+C, SIGTERM), the parent process now re-raises the signal so the shell sees the correct exit status (130 for SIGINT, 143 for SIGTERM) instead of a generic exit code 1.

3. **Preserved HTML comments in email rendering** — HTML comments embedded in emails (like `<!-- metadata -->`) now pass through the HTML-to-markdown conversion instead of being stripped. Useful for programmatic consumers that embed metadata in outgoing emails.

4. **Fixed @opentui/react version mismatch** — bumped `@opentui/core` and `@opentui/react` from `^0.1.88` to `^0.2.12` to match termcast's peer dependency range. Fresh installs were resolving an incompatible 0.1.x version, causing "Renderer not found" and React dispatcher crashes on TUI launch.

## 0.3.21

1. **Polished interactive prompts** — replaced raw readline prompts with `@clack/prompts` across auth, draft, calendar, and label commands. All confirmation dialogs and selects now have a clean, styled UI.

2. **`--method` flag on `zele login`** — skip the interactive prompt and log in non-interactively:

   ```bash
   zele login --method google
   zele login --method imap
   ```

   Non-TTY environments (scripts, CI) without `--method` now exit with a clear message instead of hanging.

3. **`--limit` everywhere** — replaces `--max` on `mail list`, `mail search`, `cal events`, and `draft list`:

   ```bash
   zele mail list --filter "is:unread" --limit 100
   zele mail search "from:github" --limit 100
   zele cal events --limit 100
   zele draft list --limit 100
   ```

4. **`--filter` everywhere** — replaces `--query` on `cal events`, `draft list`, and `mail watch`. Now consistent with `mail list`:

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
- **Mail:** Add support for Gmail search operators in `watch --filter` (e.g., `from:github`, `is:unread`)
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
