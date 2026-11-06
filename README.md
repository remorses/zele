<div hidden align='center'>
    <br/>
    <br/>
    <h3>zele</h3>
    <p>Email & Calendar CLI — Gmail, Outlook, IMAP/SMTP, Google Calendar. For you and your agents</p>
    <br/>
    <br/>
</div>

## Install

Multi-account email and calendar client supporting **Google OAuth**, **Microsoft OAuth** (Outlook / Hotmail), **IMAP/SMTP** (Fastmail, any provider), and free **@zele.sh** addresses. SQLite cache, YAML output.

All CLI commands work with **Node.js** (v22.16+). The interactive TUI (`zele` with no subcommand) requires [Bun](https://bun.sh) and will auto-spawn it if available.

```bash
# with npm / npx (CLI commands only, no TUI)
npm install -g zele

# with bun (full support including TUI)
bun install -g zele
```

> If you install via npm and run `zele` (the TUI), it will try to find `bun` in your PATH and re-spawn automatically. If bun is not installed, you'll get install instructions.

<p className='text-sm text-muted-foreground'>Works with Gmail, Outlook, Fastmail, Proton Mail and any IMAP/SMTP provider</p>

<Marquee duration={30} slowOnHover gap={48}>
  <Icon icon="/logos/gmail.svg" size={28} color="var(--muted-foreground)" />
  <Icon icon="/logos/googlecalendar.svg" size={28} color="var(--muted-foreground)" />
  <Icon icon="/logos/microsoftoutlook.svg" size={28} color="var(--muted-foreground)" />
  <Icon icon="/logos/fastmail.svg" size={28} color="var(--muted-foreground)" />
  <Icon icon="/logos/protonmail.svg" size={28} color="var(--muted-foreground)" />
  <Icon icon="/logos/icloud.svg" size={28} color="var(--muted-foreground)" />
  <Icon icon="/logos/yahoo.svg" size={28} color="var(--muted-foreground)" />
  <Icon icon="/logos/zoho.svg" size={28} color="var(--muted-foreground)" />
</Marquee>

## Setup

### Google accounts

```bash
zele login
```

Opens a browser for Google OAuth2. Repeat to add more accounts.

#### Remote / headless login (for agents)

In an agent or non-TTY shell, `zele login --method google` and `zele login microsoft` start a background daemon and return immediately. Open the printed URL, approve access, then poll:

```bash
zele login --method google
zele whoami
```

On a TTY, login stays in the foreground. If the browser cannot reach localhost, paste the redirect URL into the prompt.

IMAP/SMTP password login is non-interactive.

### Outlook / Hotmail / Microsoft 365

Microsoft disabled password IMAP on Outlook.com. Use browser OAuth (XOAUTH2):

```bash
zele login microsoft
zele login microsoft --email you@outlook.com
```

This uses Thunderbird's public Microsoft client ID and a localhost callback, same pattern as Google login.

### IMAP/SMTP accounts

For non-Google, non-Microsoft providers (Fastmail, Gmail with app passwords, any IMAP server):

```bash
# Fastmail
zele login imap \
  --email you@fastmail.com \
  --imap-host imap.fastmail.com --imap-port 993 \
  --smtp-host smtp.fastmail.com --smtp-port 465 \
  --password "your-app-password"

# Gmail (app password)
zele login imap \
  --email you@gmail.com \
  --imap-host imap.gmail.com --imap-port 993 \
  --smtp-host smtp.gmail.com --smtp-port 465 \
  --password "your-app-password"

# IMAP-only (no sending)
zele login imap \
  --email reader@example.com \
  --imap-host imap.example.com --imap-port 993 \
  --password "pass"

# Proton Mail Bridge (STARTTLS on 1143/1025, self-signed cert)
zele login imap \
  --email you@proton.me \
  --imap-host 127.0.0.1 --imap-port 1143 \
  --smtp-host 127.0.0.1 --smtp-port 1025 \
  --password "<bridge-password>" \
  --no-tls --ca ~/bridge/cert.pem
```

Use `--imap-user` / `--smtp-user` if the login username differs from your email. Omit `--smtp-host` for read-only access.

For self-signed servers, prefer `--ca <path>` to trust a PEM certificate (Proton Bridge exports `cert.pem`). `--insecure` disables certificate verification and is unsafe. `--no-tls` disables implicit IMAP TLS; STARTTLS is still attempted when the server advertises it. Bridge SSL mode (implicit TLS on custom ports) needs `--smtp-tls`.

### Free @zele.sh inboxes (receive only)

Get up to **10 free, permanent `@zele.sh` addresses**: a real email address for you, a project, or each of your agents. They keep your mail until you delete it. They are receive-only for now; sending is planned. The **owner** is your **@gmail.com** address (other domains are not accepted, to keep bots out).

```bash
zele login zele --owner you@gmail.com --name tommy   # sign in + create tommy@zele.sh
zele inbox create bills                               # bills@zele.sh
zele inbox list
zele mail list --account tommy@zele.sh
zele mail watch --account bills@zele.sh --filter 'subject:verify' --timeout 600
zele inbox delete bills@zele.sh --force               # the address is never reused
```

Sign-in sends a code to the owner Gmail. If that Gmail is already a zele account, zele reads the code from it and trashes the code email, so login needs no typing. Otherwise type the code, or pass `--code`.

Inboxes work like any other account: `mail list`, `read`, `search` (`from:`, `to:`, `subject:`, `is:unread`), `watch`, `star`, `archive`, `trash`, `spam` and `attachment`. `zele logout zele` removes the session and inbox accounts from this machine; inboxes and mail stay on the server.

### Account management

```bash
zele whoami         # show authenticated accounts (type, capabilities)
zele logout         # remove credentials
```

## Commands

### Mail

```bash
zele mail list --limit 100                        # list up to 100 recent inbox threads
zele mail list --filter "is:unread" --limit 100   # list unread inbox threads
zele mail list --folder sent --limit 100          # list sent mail
zele mail list --filter "is:unread" --limit 100 | yq '.[].id' | xargs zele mail read  # read all unread
zele mail search "from:github" --limit 100        # search with Gmail query syntax
zele mail read <thread-id>                        # read a thread
zele mail send                                    # send an email
zele mail send --thread-id <thread-id>            # send into an existing thread
zele mail reply <thread-id>                       # reply to a thread (must mail read first)
zele mail reply <thread-id> --dry-run             # show who the reply would go to
zele mail reply <thread-id> --to paul@acme.com    # override the inferred recipient
zele mail reply <thread-id> --attach report.xlsx  # reply with an attachment
zele mail reply <thread-id> --force               # reply without a prior mail read
zele mail forward <thread-id>                     # forward a thread
zele mail watch                                   # wait for the next new email
zele mail watch --filter "is:unread from:alice"   # wait for a specific email
zele mail watch --timeout 300                     # wait up to 5 minutes
```

`mail list` defaults to **Inbox**. Use `--folder sent` for mail you sent. `is:unread` on `mail list` only matches unread Inbox threads. `mail search` looks in Inbox and Sent on IMAP, and Gmail all-mail on Google accounts.

**Reply safety.** `mail reply` and `mail send --thread-id` **refuse to send** unless `mail read` already showed the live last message in that thread. This stops agents from answering a stale view after a new reply arrives. `--dry-run` does not send, so it skips the check. `--force` skips it too.

**Reply recipients** are inferred from the thread, not from the sender of the last message. If the last message is one you sent, the reply still goes to the person you sent it to, and if a thread would only reply back to your own address zele **refuses to send** instead of quietly mailing you. Check first with `--dry-run`, override with `--to`, or opt in with `--allow-self`.

```bash
zele mail reply <thread-id> --dry-run                      # to / cc / subject / In-Reply-To, sends nothing
zele mail reply <thread-id> --to paul@acme.com --body "…"  # explicit recipient wins
zele mail reply <thread-id> --allow-self --body "…"        # deliberate note to self
```

Use `mail send --thread-id` when you want full control over recipients and subject while keeping correct threading (`In-Reply-To`, `References`, and Gmail's `threadId`):

```bash
zele mail send --thread-id <thread-id> --to paul@acme.com --cc dana@acme.com --body "…"
```

`mail watch` blocks until the first **new** email matching the filter arrives, prints it with the `elapsed` wait time, and exits 0. Exit 1 means timeout, auth error or another failure; stderr says which. Poll errors are retried and a heartbeat prints every minute, so waiting days (`--timeout 259200`) is fine.

**Check existing replies first.** Watch only sees mail that arrives after it starts. `mail send` and `mail reply` print the watch command to run next:

```bash
zele mail search 'from:bob@example.com subject:Question' --account me@example.com --limit 100
zele mail watch --account me@example.com --filter 'from:bob@example.com subject:"Question"' --timeout 259200
zele mail read <thread_id> --account me@example.com
```

**Agents** should run watch with their shell tool's background mode, so the same agent is notified when it exits. Use completion notifications, not a separate agent or detached `&` / `nohup` process. A match is only a candidate: `mail read` its thread and check that `message_id` is a new **Message ID** from the expected sender that replies to the tracked email before telling the user. `mail read --verify` also shows `Message-ID`, `In-Reply-To` and `References`. If watch returns the same old message again, stop it and report that monitoring is broken. Monitoring never gives permission to send a follow-up.

**Body formatting.** Write each paragraph as **one line**. Separate paragraphs with one blank line. Never hard-wrap lines at 72-80 columns: mail clients reflow text themselves, and hard breaks show up as broken mid-sentence lines. Capitalize the first word of every paragraph, also after a greeting that ends with a comma. These rules also apply to drafts you show the user before sending.

```bash
zele mail send --to bob@example.com --subject "Meeting" --body "Hi Bob,

Can we move tomorrow's meeting to 3pm? I have a conflict in the morning and want to keep the full hour.

Thanks,
Alice"
```

### Mail actions

```bash
zele mail star <thread-id>
zele mail unstar <thread-id>
zele mail archive <thread-id>
zele mail trash <thread-id>
zele mail untrash <thread-id>
zele mail read-mark <thread-id>
zele mail unread-mark <thread-id>
zele mail spam <thread-id>
zele mail unspam <thread-id>
zele mail label <thread-id>
zele mail trash-spam
```

All action commands accept **one or more thread IDs** and an optional `--account` flag. On Google accounts, archiving removes the `INBOX` label. On IMAP accounts, it moves the message to the server's Archive folder (`Archive`, `Archives`, `All Mail`, `[Gmail]/All Mail`, or `INBOX.Archive`).

```bash
# archive a single thread
zele mail archive 18f3b7c9d2a1e4f0

# archive multiple threads at once
zele mail archive 18f3b7c9d2a1e4f0 18f3b7c9d2a1e4f1 18f3b7c9d2a1e4f2

# archive from a specific account when you have multiple
zele mail archive 18f3b7c9d2a1e4f0 --account you@example.com

# bulk archive: pipe thread IDs from a search
zele mail search "from:noreply@github.com older_than:7d" --limit 100 \
  | yq '.[].id' \
  | xargs zele mail archive

# list archived threads later
zele mail list --folder archive --limit 100
```

### Search query syntax

For **Google accounts**, `mail search` and `mail list --filter` use [Gmail search operators](https://support.google.com/mail/answer/7190) server-side. For **IMAP accounts**, queries are translated to IMAP SEARCH criteria (a subset is supported). IMAP `mail search` looks in **Inbox** and **Sent**. Use `in:sent` or `in:inbox` on `mail search` to search one mailbox. `mail list --folder` stays on that mailbox even if the filter has `in:`.

| Operator | Example | Google | IMAP |
|---|---|---|---|
| `from:` | `from:github` | yes | yes |
| `to:` | `to:me@example.com` | yes | yes |
| `subject:` | `subject:invoice` | yes | yes |
| `is:unread` | `is:unread` | yes | yes |
| `is:starred` | `is:starred` | yes | yes |
| `has:attachment` | `has:attachment` | yes | yes |
| `newer_than:` | `newer_than:7d` | yes | yes |
| `older_than:` | `older_than:1m` | yes | yes |
| `after:` | `after:2024/01/01` | yes | yes |
| `before:` | `before:2024/12/31` | yes | yes |
| `cc:` | `cc:team@example.com` | yes | no |
| `-` (negate) | `-from:noreply` | yes | no |
| `" "` (quotes) | `"exact phrase"` | yes | no |
| `label:` | `label:work` | yes | no |
| `in:` | `in:sent` | yes | yes |
| `filename:` | `filename:pdf` | yes | no |
| `size:` / `larger:` / `smaller:` | `larger:5M` | yes | no |
| `OR` / `{ }` | `from:a OR from:b` | yes | no |

```bash
zele mail list --filter "is:unread" --limit 100
zele mail list --folder sent --limit 100
zele mail list --filter "from:github newer_than:7d" --folder sent --limit 100
zele mail search "from:github is:unread newer_than:7d" --limit 100
zele mail search "in:sent to:me@example.com" --limit 20
zele mail watch --filter "from:github has:attachment" --timeout 300
```

### Drafts

```bash
zele draft list
zele draft create
zele draft create --attach report.pdf --attach logo.png  # draft with attachments
zele draft update <draft-id> --attach extra.pdf          # add a file, keep existing ones
zele draft send <draft-id>
zele draft delete <draft-id>
```

### Labels (Google only)

```bash
zele label list
zele label counts
zele label create <name>
zele label rename <label-id> <name>
zele label delete <label-id>
```

### Filters (Google only)

```bash
zele mail filter list
```

### Calendar (Google only)

```bash
zele cal list                     # list calendars
zele cal events                   # upcoming events
zele cal get <event-id>           # event details
zele cal create                   # create an event
zele cal update <event-id>        # update an event
zele cal delete <event-id>        # delete an event
zele cal respond <event-id>       # accept/decline
zele cal freebusy                 # check availability
```

#### Shared / subscribed calendars

Zele uses Google CalDAV for calendar access. By default, Google only syncs calendars you **own** over CalDAV — shared or subscribed calendars (e.g. a partner's calendar) won't appear in `zele cal list` even after accepting the share invitation.

To fix this, visit Google's CalDAV sync settings and enable the shared calendar:

1. Open **https://www.google.com/calendar/syncselect** (logged in as the account you use with zele)
2. Check the box next to any shared calendar you want to access
3. Click **Save**

After that, `zele cal list` will show the shared calendar and you can query it:

```bash
zele cal events --calendar "other-person@gmail.com" --week
```

> **Why is this needed?** Google's CalDAV endpoint only exposes calendars marked for sync (originally designed for mobile device sync). The Google Calendar web UI uses a different internal API, so calendars visible there may not appear via CalDAV until explicitly enabled at the sync settings page.

### Attachments

```bash
zele attachment list <thread-id>
zele attachment get <message-id> <attachment-id>
```

### Profile

```bash
zele profile                      # show account info
```

## Multi-account

All commands support `--account <email>` to filter by account. Without it, commands fetch from all accounts and merge results.

Google and IMAP/SMTP accounts work side by side — `mail list` merges results from both. Google-only features (labels, filters, calendar) show a helpful error when used with IMAP accounts.

### Feature compatibility

| Feature | Google | IMAP/SMTP | zele.sh |
|---|---|---|---|
| List, read, search emails | yes | yes | yes |
| Send, reply, forward | yes | yes (requires SMTP) | no (receive only) |
| Star, archive, trash, mark read | yes | yes | yes |
| Drafts | yes | yes | no |
| Attachments | yes | yes | yes |
| Watch for new emails | yes | yes | yes |
| Date/sender/subject filters | yes | yes | from/to/subject only |
| Labels | yes | no (IMAP uses folders) | no |
| Filters | yes | no | no |
| Calendar | yes | no | no |
| Gmail search operators | full | subset (see table above) | from:, to:, subject:, is:unread |

## Output

All structured data is output as YAML. In TTY mode, keys are colored for readability. Pipe output to other tools for scripting.

## For AI agents

**Always run `zele --help` first.** The top-level help already contains every subcommand, option, and flag — there is no need to run `zele <command> --help` separately. The help output is the source of truth. Read it in full — never pipe through `head`, `tail`, or `sed` to truncate.

**Never use the TUI.** Running `zele` with no subcommand launches a human-facing terminal UI for browsing email. Agents must use the CLI subcommands (`zele mail list`, `zele cal events`, etc.) which output structured YAML that can be parsed and piped.

**Always run `zele whoami` before account-scoped commands.** When the user asks to check email "for a specific account" (e.g. "my work email", "my personal Gmail"), run `zele whoami` first to list connected accounts and find the exact address to pass to `--account`. Never guess the email — pick it from the `whoami` output. The output also shows account type (`google` or `imap_smtp`) and capabilities so you know which features are available. Outlook accounts show as `imap_smtp` after `zele login microsoft`.

```bash
# list connected accounts first
zele whoami

# then scope commands to the right account
zele mail list --account user@work.com
```

**Prefer YAML parsing over regex.** Pipe command output through `yq` to extract IDs and fields reliably:

```bash
# read all unread emails
zele mail list --filter "is:unread" --limit 100 | yq '.[].id' | xargs zele mail read

# bulk archive unread
zele mail list --filter "is:unread" --limit 100 | yq '.[].id' | xargs zele mail archive
```

## Shell Completions

Enable Tab completion for your shell:

```bash
zele completions install
```

Restart your shell (or run `autoload -Uz compinit && compinit` for zsh). Then Tab works:

```bash
zele <TAB>          # shows all commands
zele mail <TAB>     # completes mail subcommands
zele login --<TAB>  # shows available options
```

Completions stay up-to-date automatically. To remove:

```bash
zele completions uninstall
```

## License

ISC
