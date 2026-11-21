---
'zele': patch
---

Gmail sends are no longer retried after an error where the mail may already be sent. Before, a 403 `backendError` was treated as a rate limit, so `mail send`, `mail reply` and `draft send` could retry it and send a duplicate. Now sends, draft creation, label creation and filter creation retry only real rate limit errors (429 and 403 quota errors), which Google rejects before doing any work. Reads still retry backend errors.

The retry backoff is also much shorter. It was up to 10 attempts with a 60 second base delay (about 8.5 hours in the worst case). It is now up to 5 attempts with 2, 4, 8 and 16 second waits (30 seconds in the worst case).

Fixes #22
