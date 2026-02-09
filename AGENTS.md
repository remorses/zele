## development

to run the cli locally use `tsx src/cli.ts`

## goke typing

do not add manual type annotations to `.action(async ...)` parameters in goke commands; rely on goke option inference.

## database

zele uses a single SQLite database at `~/.zele/zele.db` as the source of truth for CLI state.

all persistent state is stored in this DB via Prisma models:
- `accounts`: OAuth tokens per email account
- `thread_lists` + `threads`: cached mail list/read payloads
- `labels` + `label_counts`: cached label metadata and unread counters
- `profiles`: cached account profile data
- `sync_states`: misc per-account sync metadata (for example history IDs)

## changelog

keep `CHANGELOG.md` updated when making user-facing changes. bump the version in `package.json` and `src/cli.ts` together.

## migrations

`src/db.ts` runs `src/schema.sql` on startup (idempotent migration) so new tables/indexes are applied automatically on each CLI process start.
