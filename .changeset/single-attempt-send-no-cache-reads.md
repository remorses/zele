---
"zele": minor
---

Add opt-in `--single-attempt` to `mail send` and `mail reply`: exactly one send request is made, so a send the server accepted but reported as failed cannot be retried into a duplicate. Add opt-in `--no-cache` to `mail list`, `mail search` and `mail read`: the local thread cache is neither read nor written, so sensitive threads leave no cached copy of their headers or bodies on disk. Defaults are unchanged.

Fixes #22
