# zele

Gmail CLI — manage email from your terminal.

Multi-account Gmail and Google Calendar client with OAuth2 auth, SQLite cache, and YAML output.

## Install

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
zele attachment list <message-id>
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
