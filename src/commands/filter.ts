// Filter commands: list, create, delete Gmail filters.
// Multi-account support via getClients/getClient like label.ts.

import type { ZeleCli } from '../cli.js'
import { getClients } from '../auth.js'
import { AuthError, UnsupportedError, isScopeError } from '../api-utils.js'
import type { GmailClient } from '../gmail-client.js'
import * as out from '../output.js'
import { handleCommandError } from '../output.js'

export function registerFilterCommands(cli: ZeleCli) {
  // =========================================================================
  // filter list
  // =========================================================================

  cli
    .command('mail filter list', 'List all Gmail filters')
    .action(async (options) => {
      const clients = await getClients(options.account)
      const googleClients = clients.filter((c) => c.accountType === 'google')
      if (googleClients.length === 0) {
        handleCommandError(new UnsupportedError({ feature: 'Filters', accountType: 'IMAP/SMTP', hint: 'Filters are a Gmail-specific feature.' }))
      }

      const results = await Promise.all(
        googleClients.map(async ({ email, client }) => {
          const res = await (client as GmailClient).listFilters()
          if (res instanceof Error) return res
          return { email, filters: res.parsed }
        }),
      )

      const allResults = results.filter((r): r is Exclude<typeof r, Error> => {
        if (r instanceof AuthError) {
          if (isScopeError(r)) {
            out.error(`Missing required OAuth scopes. Run: zele login to grant updated permissions`)
          } else {
            out.error(`${r.message}. Try: zele login`)
          }
          return false
        }
        if (r instanceof Error) { out.error(`Failed to fetch filters: ${r.message}`); return false }
        return true
      })

      const merged = allResults.flatMap(({ email, filters }) =>
        filters.map((f) => ({ ...f, account: email })),
      )

      if (merged.length === 0) {
        out.hint('No filters found')
        return
      }

      const showAccount = clients.length > 1
      for (const f of merged) {
        out.printYaml({
          ...(showAccount ? { account: f.account } : {}),
          id: f.id,
          criteria: f.criteria,
          action: f.action,
        })
      }

      out.hint(`${merged.length} filter(s)`)
    })

  // TODO: add `mail filter create` and `mail filter delete` commands once
  // gmail.settings.basic scope is added to the GCP OAuth consent screen.
  // The https://mail.google.com/ scope covers reading filters but Google
  // enforces the narrower scope for write operations (create/delete).
  // The gmail-client.ts methods (createFilter, deleteFilter, resolveLabel)
  // are already implemented and ready to use.
}
