---
'zele': patch
---

Gmail commands use fewer API quota units. Output is the same.

- `mail list` and `mail search` reuse cached threads at any age while their history ID is unchanged. Before, every thread was downloaded again after 30 minutes.
- When a cached thread changed, zele fetches only its labels and new messages (40 units instead of 120). Messages never change, so their bodies come from the cache. This also applies to `mail read`, `mail forward`, `attachment list` and the TUI.
- `mail reply`, `mail send --thread-id`, `mail unsubscribe` and `mail read --raw` read only message headers (40 units instead of 120).
- `mail star`, `unstar`, `archive`, `spam`, `read-mark`, `unread-mark`, `label` and the read mark after a reply change labels per thread (10 units per thread instead of 40 per thread plus 50).
- `mail trash-spam` no longer downloads every spam thread before trashing it.
- `attachment get` and `draft update` download each message once instead of once per attachment.
