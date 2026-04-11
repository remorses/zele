// Auth commands: login, login imap, logout, whoami.
// Manages authentication for zele (Google OAuth and IMAP/SMTP credentials).
// Supports multiple accounts: login adds accounts, logout removes one.

import type { ZeleCli } from '../cli.js'
import { z } from 'zod'
import pc from 'picocolors'
import { login, loginImap, logout, listAccounts, getAuthStatuses } from '../auth.js'
import { closePrisma } from '../db.js'
import * as out from '../output.js'
import { handleCommandError } from '../output.js'

export function registerAuthCommands(cli: ZeleCli) {
  cli
    .command('login', 'Authenticate with Google (opens browser) or show IMAP/SMTP login instructions')
    .action(async () => {
      // In a TTY, ask if they want Google or Other
      if (process.stdin.isTTY) {
        const readline = await import('node:readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr })

        console.error(pc.bold('\nChoose authentication method:\n'))
        console.error('  ' + pc.cyan('1') + ' Google (opens browser for OAuth)')
        console.error('  ' + pc.cyan('2') + ' Other (IMAP/SMTP with password)\n')

        const answer = await new Promise<string>((resolve) => {
          rl.question('Enter choice [1]: ', resolve)
        })
        rl.close()

        const choice = answer.trim() || '1'

        if (choice === '2') {
          console.error(pc.bold('\nTo add an IMAP/SMTP account, run:\n'))
          console.error(pc.dim('  # Fastmail'))
          console.error(`  zele login imap \\`)
          console.error(`    --email you@fastmail.com \\`)
          console.error(`    --imap-host imap.fastmail.com --imap-port 993 \\`)
          console.error(`    --smtp-host smtp.fastmail.com --smtp-port 465 \\`)
          console.error(`    --password "your-app-password"`)
          console.error()
          console.error(pc.dim('  # Gmail (app password)'))
          console.error(`  zele login imap \\`)
          console.error(`    --email you@gmail.com \\`)
          console.error(`    --imap-host imap.gmail.com --imap-port 993 \\`)
          console.error(`    --smtp-host smtp.gmail.com --smtp-port 465 \\`)
          console.error(`    --password "your-app-password"`)
          console.error()
          console.error(pc.dim('  # Outlook/Hotmail'))
          console.error(`  zele login imap \\`)
          console.error(`    --email you@outlook.com \\`)
          console.error(`    --imap-host outlook.office365.com --imap-port 993 \\`)
          console.error(`    --smtp-host smtp-mail.outlook.com --smtp-port 587 \\`)
          console.error(`    --password "your-password"`)
          console.error()
          console.error(pc.dim('  # Generic (any IMAP/SMTP provider)'))
          console.error(`  zele login imap \\`)
          console.error(`    --email you@example.com \\`)
          console.error(`    --imap-host imap.example.com --imap-port 993 \\`)
          console.error(`    --smtp-host smtp.example.com --smtp-port 465 \\`)
          console.error(`    --password "your-password"`)
          console.error()
          console.error(pc.dim('Omit --smtp-host for read-only (IMAP only, no sending).'))
          console.error(pc.dim('Use --imap-user/--smtp-user if the login username differs from your email.'))
          return
        }
      }

      // Default: Google OAuth flow
      const result = await login()
      if (result instanceof Error) handleCommandError(result)
      const { email } = result
      out.success(`Authenticated as ${email}`)
      await closePrisma()
      process.exit(0)
    })

  cli
    .command('login imap', 'Add an IMAP/SMTP email account (non-interactive, designed for agents)')
    .option('--email <email>', z.string().describe('Email address'))
    .option('--imap-host <imapHost>', z.string().describe('IMAP server hostname'))
    .option('--imap-port <imapPort>', z.string().describe('IMAP server port (default: 993)'))
    .option('--smtp-host <smtpHost>', z.string().describe('SMTP server hostname (optional, enables sending)'))
    .option('--smtp-port <smtpPort>', z.string().describe('SMTP server port (default: 465)'))
    .option('--password <password>', z.string().describe('Password (shared for IMAP and SMTP unless overridden)'))
    .option('--imap-user <imapUser>', z.string().describe('IMAP username (defaults to --email)'))
    .option('--imap-password <imapPassword>', z.string().describe('IMAP password (overrides --password)'))
    .option('--smtp-user <smtpUser>', z.string().describe('SMTP username (defaults to --email)'))
    .option('--smtp-password <smtpPassword>', z.string().describe('SMTP password (overrides --password)'))
    .option('--no-tls', 'Disable TLS (not recommended)')
    .action(async (options) => {
      if (!options.email) {
        out.error('--email is required')
        process.exit(1)
      }
      if (!options.imapHost) {
        out.error('--imap-host is required')
        process.exit(1)
      }
      if (!options.password && !options.imapPassword) {
        out.error('--password or --imap-password is required')
        process.exit(1)
      }

      out.hint('Testing IMAP connection...')

      const result = await loginImap({
        email: options.email,
        imapHost: options.imapHost,
        imapPort: options.imapPort ? Number(options.imapPort) : undefined,
        smtpHost: options.smtpHost,
        smtpPort: options.smtpPort ? Number(options.smtpPort) : undefined,
        password: options.password,
        imapUser: options.imapUser,
        imapPassword: options.imapPassword,
        smtpUser: options.smtpUser,
        smtpPassword: options.smtpPassword,
        tls: options.noTls !== true,
      })
      if (result instanceof Error) handleCommandError(result)

      const caps = options.smtpHost ? 'IMAP + SMTP' : 'IMAP only'
      out.success(`Authenticated ${result.email} (${caps})`)
      await closePrisma()
      process.exit(0)
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
          console.error(`  ${e}`)
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

      const logoutResult = await logout(targetEmail)
      if (logoutResult instanceof Error) handleCommandError(logoutResult)
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
          type: s.accountType,
          capabilities: s.capabilities.join(', '),
          status: 'Authenticated',
          ...(s.expiresAt ? { expires: s.expiresAt.toISOString() } : {}),
        })),
        { summary: `${statuses.length} account(s)` },
      )
    })
}
