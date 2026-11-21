---
'zele': minor
---

With several accounts signed in, commands that take a Gmail thread ID no longer need `--account`: zele uses the Google account that has the thread. IMAP IDs repeat between mailboxes, so they still need `--account`.
