// Profile command: show account info.
// Displays email address, message/thread counts, and aliases as YAML.
// Cache is handled by the client — commands just call methods and use data.
// Multi-account: shows all accounts or filtered by --account.

import type { ZeleCli } from '../cli.js'
import { getClients } from '../auth.js'
import type { GmailClient } from '../gmail-client.js'
import { AuthError } from '../api-utils.js'
import * as out from '../output.js'

export function registerProfileCommands(cli: ZeleCli) {
  cli
    .command('profile', 'Show account info')
    .action(async (options) => {
      const clients = await getClients(options.account)

      // Fetch all accounts concurrently
      const allResults = await Promise.all(
        clients.map(async ({ client, accountType }) => {
          const profile = await client.getProfile()
          if (profile instanceof Error) return profile

          if (accountType === 'google') {
            // Google accounts have aliases
            const aliases = await (client as GmailClient).getEmailAliases()
            if (aliases instanceof Error) return aliases
            return { profile, aliases, accountType }
          }

          return { profile, aliases: [{ email: profile.emailAddress, primary: true }], accountType }
        }),
      )

      const results = allResults.filter((r): r is Exclude<typeof r, Error> => {
          if (r instanceof AuthError) { out.error(`${r.message}. Try: zele login`); return false }
          if (r instanceof Error) { out.error(`Failed to fetch profile: ${r.message}`); return false }
          return true
        })

      for (const { profile, aliases, accountType } of results) {
        const data: Record<string, unknown> = {
          email: profile.emailAddress,
          type: accountType,
        }
        if (accountType === 'google') {
          data.messages_total = profile.messagesTotal
          data.threads_total = profile.threadsTotal
          data.history_id = profile.historyId
        }
        data.aliases = aliases.map((a) => ({
          email: a.email,
          name: a.name ?? null,
          primary: a.primary,
        }))
        out.printYaml(data)
      }
    })
}
