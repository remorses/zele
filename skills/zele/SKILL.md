---
name: zele
repo: remorses/zele
description: >
  zele is a multi-account email and calendar CLI for Gmail, IMAP/SMTP
  (Fastmail, Outlook, any provider), and Google Calendar. It reads,
  searches, sends, replies, forwards, archives, stars, and trashes emails,
  waits for replies with `zele mail watch` (run it in a background shell
  after sending), manages drafts, labels, attachments, and Gmail filters,
  and creates, updates, and deletes calendar events with RSVP and
  free/busy support. Output is YAML so commands can be piped through yq
  and xargs. ALWAYS load this skill when the user asks to check email,
  mentions an email they sent, read/send messages, reply or forward,
  archive or trash threads, manage drafts or labels, download attachments, schedule meetings, check their calendar, RSVP
  to events, create a free permanent @zele.sh email address (receive-only
  for now) for themselves, a project, or an agent, or when they run any `zele`
  command. Load it before writing
  any code or shell commands that touch zele so you know the correct
  subcommand structure, the Google vs IMAP feature matrix, the headless
  login flow, and the agent-specific rules.
---

# zele

Every time you use zele, you MUST fetch the latest README:

```bash
curl -s https://raw.githubusercontent.com/remorses/zele/main/README.md # NEVER pipe to head/tail, read the full output
```

Then run the CLI help once — it already includes every subcommand, option, and flag:

```bash
zele --help # NEVER pipe to head/tail, read the full output
```

The README and `zele --help` output are the source of truth for commands, options, flags, the Google vs IMAP feature matrix, search operators, and the headless login flow.

## Reply follow-up

After a successful send, reply, forward or draft send, or when the user mentions an email they sent, **check for a reply**, unless they ask not to monitor:

1. **Check existing replies first.** Find the sent email on the right `--account` (ask if unclear). Search read and unread mail and `mail read` the candidates; note existing message IDs. Watch only sees mail that arrives after it starts. If a reply is already there, report it.
2. **Otherwise watch in a background shell.** Run the watch command (printed by `mail send` / `mail reply`) with the shell tool's background mode, so you get a notification when it exits. Do not use a separate agent, bare `&`, `nohup` or `sleep`. Set the shell timeout longer than `--timeout`, or disable it. If you cannot get a completion notification, say that no monitoring is active.
3. **Validate the match before you alert the user.** A match is a candidate only. `mail read` its `thread_id` and check that its `message_id` is a new **Message ID** from the expected sender that answers the sent email. The date comes from the sender's Date header, so an old date alone does not mean replay. If watch returns an old ID again, stop it and tell the user that monitoring is broken.
4. **Handle exit 1.** It means timeout, auth error or another failure. Read stderr, tell the user, and check existing replies again before you restart.

Monitoring never gives permission to send. Get approval for every reply or follow-up.

```bash
zele mail search 'from:bob@example.com subject:Question' --account me@example.com --limit 100
# no reply yet: run this with the shell tool's background mode
zele mail watch --account me@example.com --filter 'from:bob@example.com subject:"Question"' --timeout 259200
zele mail read <thread_id> --account me@example.com
```

## Rules

1. **Never use the TUI.** Running `zele` with no subcommand launches a human-facing TUI. Agents must use the CLI subcommands (`zele mail list`, `zele cal events`, etc.) which output structured YAML.
2. **Always run `zele whoami` first** when the user asks to operate on a specific account. Pick the exact email from the output and pass it with `--account`. Never guess account emails.
3. **Never truncate `--help` or README output** with `head`, `tail`, `sed`, `awk`, or `less`. Critical rules are spread throughout. Read them in full.
4. **Parse YAML output with `yq`**, not regex. Pipe IDs through `xargs` for bulk actions. Always use `--limit 100` (or higher) so you don't miss threads:
   ```bash
   # read all unread emails
   zele mail list --filter "is:unread" --limit 100 | yq '.[].id' | xargs zele mail read

   # bulk archive
   zele mail list --filter "is:unread" --limit 100 | yq '.[].id' | xargs zele mail archive
   ```
5. **Google-only features** (labels, Gmail filters, `zele cal *`, full profile) fail on IMAP accounts with a clear error. Check `zele whoami` output for account type before using them.
6. **Headless Google login** requires a tmux wrapper because `zele login` is interactive. See the README "Remote / headless login" section for the exact pattern.
7. **Wait for expected emails with `zele mail watch`**, not `sleep`. For replies, follow the reply follow-up section above. For verification codes, check they did not already arrive, then: `zele mail watch --filter 'subject:verification' --timeout 300`.
8. **Check reply recipients before sending** with `zele mail reply <thread-id> --dry-run`. Recipients are inferred from the thread, not from the sender of the last message, so a thread whose last message you sent still replies to the other person. If a reply would only reach the account's own address, zele refuses to send:
   ```bash
   # see to / cc / subject / In-Reply-To without sending
   zele mail reply <thread-id> --dry-run

   # override the inferred recipient
   zele mail reply <thread-id> --to paul@acme.com --body "..."

   # deliberately reply to yourself (normally refused)
   zele mail reply <thread-id> --allow-self --body "..."
   ```
    Never work around a `SelfRecipientError` by switching to `zele mail send`; pass `--to` to `zele mail reply` instead, so threading headers stay correct.
9. **Read a thread before replying.** `zele mail reply` and `zele mail send --thread-id` fail with `UnseenLatestError` unless `zele mail read <thread-id>` already showed the live last message. `mail watch` and `mail list` do **not** count. If a new reply arrives after you read, read again before sending:
    ```bash
    zele mail read <thread-id>
    zele mail reply <thread-id> --body "..."
    ```
    Never pass `--force` to skip this unless the user explicitly asks to send without reading.
10. **Send into an existing thread** with `zele mail send --thread-id <thread-id>` when you need full control of recipients and subject but still want correct `In-Reply-To`/`References` headers. Recipients and subject are inferred from the thread when omitted. The same read-before-reply rule applies.
11. **Format email bodies like a human wrote them.** These rules apply to `--body` and to every draft you show the user for approval:
    - **Never hard-wrap.** Write each paragraph as one line. Separate paragraphs with one blank line. Do not break lines at 72-80 columns: mail clients wrap text themselves, and hard breaks render as lines broken mid-sentence. Show drafts exactly as they will be sent.
    - **Capitalize the first word of every paragraph**, also after a greeting that ends with a comma. Write `Buongiorno,` then `Sono Tommaso...`, not `sono Tommaso...`. Same in English: `Hi Bob,` then `Can we...`.
    ```
    Buongiorno,

    Sono Tommaso De Rossi e vorrei prenotare una visita presso la vostra sede di Genova. Potreste indicarmi le prime date disponibili?

    Grazie mille!
    Tommaso De Rossi
    ```
12. **Free `@zele.sh` addresses (receive only for now).** These are permanent, real addresses, not throwaway ones: use them when the user wants a new address for themselves, a project, or an agent. Mail stays until the user deletes it. Each owner (a **@gmail.com** address, no other domains) gets up to **10** inboxes. They work like any account with `--account name@zele.sh` for list, read, search, watch, star, archive, trash and attachments. Sending, drafts and labels fail with a receive-only error.
    ```bash
    # 1. pick the owner: a @gmail.com account from `zele whoami` (type: google).
    #    The sign-in code is then read from that Gmail automatically.
    zele login zele --owner you@gmail.com --name tommy   # sign in + create tommy@zele.sh
    zele inbox create bills                               # more inboxes, already signed in
    zele inbox list

    # 2. wait for a signup / verification email
    zele mail watch --account bills@zele.sh --filter 'subject:verify' --timeout 600
    ```
    - Without `--owner` in an agent shell, `login zele` fails and lists the Gmail accounts in zele. Pick one, do not guess.
    - If the owner Gmail is not a zele account, the code is emailed and the command prints `Rerun with: zele login zele --owner ... --code <code>`. Ask the user for the code.
    - `zele inbox delete <address> --force` deletes the inbox and all its mail. The address can **never** be created again, so confirm with the user first.
    - `zele logout zele --force` removes the session and the inbox accounts from this machine. Inboxes and mail stay on the server.
