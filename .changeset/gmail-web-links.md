---
'zele': minor
---

Commands that take a thread ID now also take a Gmail web link, such as `https://mail.google.com/mail/u/0/#inbox/FMfcgz…`, and the draft commands take a draft's compose link (`…#drafts?compose=…`). Links are decoded to Gmail API IDs offline, with no API call.
