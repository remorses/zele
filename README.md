<div align='center'>
    <br/>
    <br/>
    <h3>zele</h3>
    <p>Email & Calendar CLI — Gmail, IMAP/SMTP, Google Calendar. For you and your agents</p>
    <br/>
    <br/>
</div>

## Install

Multi-account email and calendar client supporting **Google OAuth** and **IMAP/SMTP** (Fastmail, Outlook, any provider). SQLite cache, YAML output.

Requires [bun](https://bun.sh):

```bash
# install bun (skip if already installed)
curl -fsSL https://bun.sh/install | bash   # macOS/Linux
powershell -c "irm bun.sh/install.ps1|iex" # Windows

# install zele
bun install -g zele
```

## Setup

### Google accounts

```bash
zele login
```

Opens a browser for Google OAuth2. Repeat to add more accounts.

#### Remote / headless login (for agents)

`zele login` is interactive — it prints an authorization URL and waits for the redirect URL to be pasted back. In agent or headless environments, run it inside a `tmux` session so the process persists and can be driven programmatically:

```bash
# start login in a tmux session
tmux new-session -d -s zele-login 'zele login'

# read the authorization URL from tmux output
tmux capture-pane -t zele-login -p

# after the user completes consent in their browser, paste the redirect URL
tmux send-keys -t zele-login 'http://localhost:...?code=...' Enter

# verify login succeeded
tmux capture-pane -t zele-login -p
tmux kill-session -t zele-login
```

IMAP/SMTP login is non-interactive and requires no tmux wrapper.

### IMAP/SMTP accounts

For non-Google providers (Fastmail, Outlook, Gmail with app passwords, any IMAP server):

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

# Outlook
zele login imap \
  --email you@outlook.com \
  --imap-host outlook.office365.com --imap-port 993 \
  --smtp-host smtp-mail.outlook.com --smtp-port 587 \
  --password "your-password"

# IMAP-only (no sending)
zele login imap \
  --email reader@example.com \
  --imap-host imap.example.com --imap-port 993 \
  --password "pass"
```

Use `--imap-user` / `--smtp-user` if the login username differs from your email. Omit `--smtp-host` for read-only access.

### Account management

```bash
zele whoami         # show authenticated accounts (type, capabilities)
zele logout         # remove credentials
```

## Commands

### Mail

```bash
zele mail list                    # list recent threads
zele mail list --filter "is:unread"  # only unread threads
zele mail search "from:github"   # search with Gmail query syntax
zele mail read <thread-id>       # read a thread
zele mail send                    # send an email
zele mail reply <thread-id>      # reply to a thread
zele mail forward <thread-id>    # forward a thread
zele mail watch                   # watch for new emails (poll)
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
zele mail search "from:noreply@github.com older_than:7d" \
  | yq '.[].id' \
  | xargs zele mail archive

# list archived threads later
zele mail list --filter "in:archive"
```

### Search query syntax

For **Google accounts**, `mail search` and `mail list --filter` use [Gmail search operators](https://support.google.com/mail/answer/7190) server-side. For **IMAP accounts**, queries are translated to IMAP SEARCH criteria (a subset is supported).

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
| `in:` | `in:sent` | yes | no |
| `filename:` | `filename:pdf` | yes | no |
| `size:` / `larger:` / `smaller:` | `larger:5M` | yes | no |
| `OR` / `{ }` | `from:a OR from:b` | yes | no |

```bash
zele mail list --filter "is:unread"
zele mail list --filter "from:github newer_than:7d" --folder sent
zele mail search "from:github is:unread newer_than:7d"
zele mail watch --query "from:github has:attachment"
```

### Drafts

```bash
zele draft list
zele draft create
zele draft send <draft-id>
zele draft delete <draft-id>
```

### Labels (Google only)

```bash
zele label list
zele label counts
zele label create <name>
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

| Feature | Google | IMAP/SMTP |
|---|---|---|
| List, read, search emails | yes | yes |
| Send, reply, forward | yes | yes (requires SMTP) |
| Star, archive, trash, mark read | yes | yes |
| Drafts | yes | yes |
| Attachments | yes | yes |
| Watch for new emails | yes | yes |
| Date/sender/subject filters | yes | yes |
| Labels | yes | no (IMAP uses folders) |
| Filters | yes | no |
| Calendar | yes | no |
| Gmail search operators | full | subset (see table above) |

## Output

All structured data is output as YAML. In TTY mode, keys are colored for readability. Pipe output to other tools for scripting.

## For AI agents

**Always run `zele --help` first.** The top-level help already contains every subcommand, option, and flag — there is no need to run `zele <command> --help` separately. The help output is the source of truth. Read it in full — never pipe through `head`, `tail`, or `sed` to truncate.

**Never use the TUI.** Running `zele` with no subcommand launches a human-facing terminal UI for browsing email. Agents must use the CLI subcommands (`zele mail list`, `zele cal events`, etc.) which output structured YAML that can be parsed and piped.

**Always run `zele whoami` before account-scoped commands.** When the user asks to check email "for a specific account" (e.g. "my work email", "my personal Gmail"), run `zele whoami` first to list connected accounts and find the exact address to pass to `--account`. Never guess the email — pick it from the `whoami` output. The output also shows account type (`google` or `imap_smtp`) and capabilities so you know which features are available.

```bash
# list connected accounts first
zele whoami

# then scope commands to the right account
zele mail list --account user@work.com
```

**Prefer YAML parsing over regex.** Pipe command output through `yq` to extract IDs and fields reliably:

```bash
zele mail list --filter "is:unread" | yq '.[].id' | xargs zele mail archive
```

## License

ISC
