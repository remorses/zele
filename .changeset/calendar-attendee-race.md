---
'zele': patch
---

With zele's own Google client, `cal respond` now sends only your own answer, and `cal update --add-attendees` / `--remove-attendees` refuse to save if someone else changed the event in the meantime. Before, a guest removed by another editor at the same time could be added back and emailed.
