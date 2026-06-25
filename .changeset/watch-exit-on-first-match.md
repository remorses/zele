---
'zele': minor
---

Change `mail watch` to exit on first matching email instead of running forever.

Previously `mail watch` ran an infinite loop printing every new email. Now it blocks until the first email matching the filter arrives, prints it, and exits with code 0. This makes it useful for agents that need to wait for a specific email (verification codes, replies, etc.).

New `--timeout` flag sets a maximum wait time in seconds. If no matching email arrives before the deadline, the command exits with code 1.

The `--once` flag has been removed since the new behavior subsumes it.

```bash
# wait for a reply from alice
zele mail watch --filter "is:unread from:alice@example.com"

# wait for a verification code with a 5-minute timeout
zele mail watch --filter "is:unread subject:verification" --timeout 300

# send then wait for the reply
zele mail send --to bob@example.com --subject "Question" --body "Can you check this?"
zele mail watch --filter "is:unread from:bob subject:Re:Question" --timeout 600
```
