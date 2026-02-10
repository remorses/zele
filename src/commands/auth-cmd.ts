// Auth commands: login, logout, whoami.
// Manages OAuth2 authentication for zele.
// Supports multiple accounts: login adds accounts, logout removes one.

import type { Goke } from 'goke'
import { login, logout, listAccounts, getAuthStatuses } from '../auth.js'
import { closePrisma } from '../db.js'
import * as out from '../output.js'

export function registerAuthCommands(cli: Goke) {
  cli
    .command('login', 'Authenticate with Google (opens browser). Run in background via tmux for remote/headless environments. The command prints an authorization URL — show it to the user, ask them to complete consent in their browser, then paste back the localhost redirect URL containing the auth code.')
    .action(async () => {
      const { email } = await login()
      out.success(`Authenticated as ${email}`)
      await closePrisma()
    })

  cli
    .command('logout [email]', 'Remove stored credentials for an account')
    .option('--force', 'Skip confirmation')
    .action(async (email, options) => {
      const accounts = await listAccounts()

      if (accounts.length === 0) {
        out.hint('No accounts currently authenticated')
        return
      }

      const emails = [...new Set(accounts.map((a) => a.email))]

      // If no email specified and multiple accounts: error with list
      if (!email && emails.length > 1) {
        out.error('Multiple accounts logged in. Specify which to remove:')
        for (const e of emails) {
          process.stderr.write(`  ${e}\n`)
        }
        process.exit(1)
      }

      // If no email and only one account, use that one
      const targetEmail = email ?? emails[0]!

      if (!emails.includes(targetEmail)) {
        out.error(`Account not found: ${targetEmail}`)
        out.hint(`Logged in accounts: ${emails.join(', ')}`)
        process.exit(1)
      }

      if (!options.force) {
        if (!process.stdin.isTTY) {
          out.error('Use --force to logout non-interactively')
          process.exit(1)
        }

        const readline = await import('node:readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Remove credentials for ${targetEmail}? [y/N] `, resolve)
        })
        rl.close()

        if (answer.toLowerCase() !== 'y') {
          out.hint('Cancelled')
          return
        }
      }

      await logout(targetEmail)
      out.success(`Credentials removed for ${targetEmail}`)
    })

  cli
    .command('whoami', 'Show authenticated accounts')
    .action(async () => {
      const statuses = await getAuthStatuses()

      if (statuses.length === 0) {
        out.hint('Not authenticated. Run: zele login')
        return
      }

      out.printList(
        statuses.map((s) => ({
          email: s.email,
          app_id: s.appId,
          status: 'Authenticated',
          expires: s.expiresAt?.toISOString() ?? 'unknown',
        })),
      )

      out.hint(`${statuses.length} account(s)`)
    })
}
