---
'zele': patch
---

`attachment get` on Gmail now saves files with their real filename, and skips files that are already downloaded. Gmail attachment IDs are now the stable MIME part ID (like `1` or `0.2`) instead of Gmail's attachment ID, which changes on every fetch.
