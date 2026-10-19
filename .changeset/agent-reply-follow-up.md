---
'zele': patch
---

Fix `mail watch` on Gmail returning an old message right after start. Watch now reads a live history cursor instead of the 24-hour cached profile, also when the cursor expires. Expired-history errors are now detected, so that recovery runs.

`mail read` shows each message's ID, so a watch match can be checked against the thread. `--verify` also shows `Message-ID`, `In-Reply-To` and `References`.

The skill and help now tell agents to check existing replies first, run watch in a background shell that notifies them on exit, and read the match before telling the user.
