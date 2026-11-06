---
'zele': patch
---

`mail reply` (with or without `--all`) and `mail send --thread-id` now mark the thread as read after the message is sent, on Gmail and IMAP. Before, the thread stayed unread. Replies sent from the TUI do the same. If marking read fails, the command prints a warning but still reports the reply as sent.
