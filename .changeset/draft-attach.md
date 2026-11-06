---
'zele': patch
---

`draft create` and `draft update` accept repeatable `--attach <file>`, like `mail send`. Fixes #23. `draft update` keeps the attachments the draft already has and adds the new files. Before, any update dropped them.

IMAP drafts now keep their attachments when created, updated and sent. `attachment get` on IMAP accounts now saves the real file instead of base64 text. An IMAP draft update no longer loses the draft if saving the new version fails. On IMAP, a `.txt` or `.html` attachment is no longer shown as the message body.
