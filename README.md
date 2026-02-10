<div align='center'>
    <br/>
    <br/>
    <h3>zele</h3>
    <p>Manage emails & calendar from your terminal. For you and your agents</p>
    <br/>
    <br/>
</div>

## Install

Multi-account Gmail and Google Calendar client with OAuth2 auth, SQLite cache, and YAML output.

```bash
npm install -g zele
```

## Setup

```bash
zele login
```

Opens a browser for Google OAuth2. Repeat to add more accounts.

```bash
zele whoami         # show authenticated accounts
zele logout         # remove credentials
```

## Commands

### Mail

```bash
zele mail list                    # list recent threads
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
zele mail label <thread-id>
zele mail trash-spam
```

### Search query syntax

`mail search` and `mail watch --query` use [Gmail search operators](https://support.google.com/mail/answer/7190). `mail search` sends the query server-side (full Gmail support), while `mail watch --query` evaluates a subset client-side.

| Operator | Example | Description |
|---|---|---|
| `from:` | `from:github` | Messages from a sender |
| `to:` | `to:me@example.com` | Messages sent to a recipient |
| `cc:` | `cc:team@example.com` | Messages where recipient was CC'd |
| `subject:` | `subject:invoice` | Messages with words in the subject |
| `is:unread` | `is:unread` | Unread messages |
| `is:read` | `is:read` | Read messages |
| `is:starred` | `is:starred` | Starred messages |
| `has:attachment` | `has:attachment` | Messages with attachments (heuristic in watch) |
| `-` (negate) | `-from:noreply` | Exclude matching messages |
| `" "` (quotes) | `"exact phrase"` | Match an exact phrase |
| `label:` | `label:work` | Messages with a specific label (search only) |
| `in:` | `in:sent` | Messages in a folder (search only) |
| `after:` | `after:2024/01/01` | Messages after a date (search only) |
| `before:` | `before:2024/12/31` | Messages before a date (search only) |
| `newer_than:` | `newer_than:7d` | Messages newer than a period (search only) |
| `older_than:` | `older_than:1m` | Messages older than a period (search only) |
| `filename:` | `filename:pdf` | Attachment filename (search only) |
| `size:` / `larger:` / `smaller:` | `larger:5M` | Filter by message size (search only) |
| `OR` | `from:a OR from:b` | Match either term (search only) |
| `{ }` | `{from:a from:b}` | Group OR terms (search only) |

Combine multiple operators to narrow results:

```bash
zele mail search "from:github is:unread newer_than:7d"
zele mail watch --query "from:github has:attachment"
```

Operators marked **(search only)** are handled server-side by Gmail and only available in `mail search`. Using them in `mail watch --query` prints a warning and skips the operator.

### Drafts

```bash
zele draft list
zele draft create
zele draft send <draft-id>
zele draft delete <draft-id>
```

### Labels

```bash
zele label list
zele label counts
zele label create <name>
zele label delete <label-id>
```

### Calendar

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

## Output

All structured data is output as YAML. In TTY mode, keys are colored for readability. Pipe output to other tools for scripting.

## License

ISC
