---
'zele': minor
---

Align CLI with goke framework conventions and add interactive prompts for a better onboarding experience.

**goke compliance:**
- Replace `picocolors` with `colors` from goke (one fewer dependency)
- Add shell completions via `zele completions install` (zsh and bash)
- Add `isAgent` detection from goke to all interactive guards; AI agents (Claude, Cursor, Codex, etc.) now skip prompts automatically
- Google OAuth login fails fast in non-TTY with tuistory instructions instead of hanging
- Destructive commands (`cal delete`, `draft delete`, `label delete`) now require `--force` in non-TTY/agent mode instead of silently proceeding
- Upgrade goke 6.6.0 → 6.12.3

**Interactive prompts:**
- `zele login imap` is now fully interactive in TTY mode: prompts for email, shows a provider preset selector (Fastmail, Gmail, Outlook, Custom) that auto-fills IMAP/SMTP hosts and ports, and prompts for password with masked input. All flags still work for non-interactive/agent use.
- `zele cal respond` prompts for accept/decline/tentative when `--status` is omitted
- `zele logout` shows an account selector when multiple accounts are logged in
- All prompts include input validation (no empty emails, valid port numbers, etc.)
