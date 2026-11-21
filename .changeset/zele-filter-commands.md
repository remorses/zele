---
'zele': minor
---

New `mail filter create` and `mail filter delete` commands.

```bash
zele mail filter create --from news@example.com --add-label Newsletters --archive
zele mail filter create --subject "invoice" --star --mark-read
zele mail filter delete <filter-id>
```

Criteria: `--from`, `--to`, `--subject`, `--query`. Actions: `--add-label` (one label, created if missing; Gmail allows one per filter), `--remove-label` (repeatable, must exist), `--archive`, `--mark-read`, `--star`. Gmail accepts filter changes only with the `gmail.settings.basic` scope, which the default Google login cannot grant yet. zele checks the token's scopes first (asking Google when the saved token has none), so the command fails before it creates any label, with a link to the Gmail filter settings.
