// Auth commands: login, login imap, logout, whoami.
// Manages authentication for zele (Google OAuth and IMAP/SMTP credentials).
// Supports multiple accounts: login adds accounts, logout removes one.

import type { ZeleCli } from '../cli-types.js'
import { z } from 'zod'
import { colors as pc, isAgent } from 'goke'
import * as clack from '@clack/prompts'
import { login, loginImap, logout, listAccounts, getAuthStatuses } from '../auth.js'
import { closePrisma } from '../db.js'
import * as out from '../output.js'
import { handleCommandError } from '../output.js'

export function registerAuthCommands(cli: ZeleCli) {
  cli
    .command('login', 'Authenticate with Google (opens browser) or show IMAP/SMTP login instructions')
    .option(
      '--method <method>',
      z.enum(['google', 'imap']).optional().describe('Authentication method (google or imap)'),
    )
    .action(async (options) => {
      let method = options.method

      if (!method) {
        if (isAgent || !process.stdin.isTTY) {
          out.error('Run non-interactively with: zele login --method google|imap')
          process.exit(1)
        }

        const choice = await clack.select({
          message: 'Choose authentication method',
          options: [
            { value: 'google', label: 'Google', hint: 'opens browser for OAuth' },
            { value: 'imap', label: 'Other', hint: 'IMAP/SMTP with password' },
          ],
        })

        if (clack.isCancel(choice)) {
          out.hint('Cancelled')
          process.exit(0)
        }

        method = choice
      }

      if (method === 'imap') {
        out.hint('Run: zele login imap')
        out.hint('It will guide you through setup interactively, or pass all flags for non-interactive use.')
        return
      }

      // Google OAuth flow — needs an interactive terminal and must stay alive
      // while the user approves the browser login.
      if (!process.stdout.isTTY) {
        out.error(
          'zele login needs an interactive terminal and must stay alive while you approve the browser login.\n\n' +
          'Run it in a background terminal session like tuistory or tmux, then wait for the URL/code:\n\n' +
          '  bunx tuistory launch "zele login --method google" -s zele-login\n' +
          '  bunx tuistory -s zele-login wait "/code:|https?:\\\\/\\\\//i" --timeout 15000\n\n' +
          'The login command exits by itself after successful browser approval.',
        )
        process.exit(1)
      }

      const result = await login()
      if (result instanceof Error) handleCommandError(result)
      const { email } = result
      out.success(`Authenticated as ${email}`)
      await closePrisma()
      process.exit(0)
    })

  cli
    .command('login imap', 'Add an IMAP/SMTP email account')
    .option('--email [email]', z.string().optional().describe('Email address'))
    .option('--imap-host [imapHost]', z.string().optional().describe('IMAP server hostname'))
    .option('--imap-port [imapPort]', z.string().optional().describe('IMAP server port (default: 993)'))
    .option('--smtp-host [smtpHost]', z.string().optional().describe('SMTP server hostname (optional, enables sending)'))
    .option('--smtp-port [smtpPort]', z.string().optional().describe('SMTP server port (default: 465)'))
    .option('--password [password]', z.string().optional().describe('Password (shared for IMAP and SMTP unless overridden)'))
    .option('--imap-user [imapUser]', z.string().optional().describe('IMAP username (defaults to --email)'))
    .option('--imap-password [imapPassword]', z.string().optional().describe('IMAP password (overrides --password)'))
    .option('--smtp-user [smtpUser]', z.string().optional().describe('SMTP username (defaults to --email)'))
    .option('--smtp-password [smtpPassword]', z.string().optional().describe('SMTP password (overrides --password)'))
    .option('--no-tls', 'Disable TLS (not recommended)')
    .action(async (options) => {
      const interactive = !isAgent && process.stdin.isTTY

      // --- email ---
      let email = options.email
      if (!email) {
        if (!interactive) {
          out.error('Missing --email. Usage: zele login imap --email you@example.com --imap-host imap.example.com --password "pwd"')
          process.exit(1)
        }
        const v = await clack.text({
          message: 'Email address',
          placeholder: 'you@example.com',
          validate: (value) => value?.trim() ? undefined : 'Email address is required',
        })
        if (clack.isCancel(v)) process.exit(0)
        email = v
      }

      // --- provider preset ---
      let imapHost = options.imapHost
      let imapPort = options.imapPort
      let smtpHost = options.smtpHost
      let smtpPort = options.smtpPort

      if (!imapHost && interactive) {
        const provider = await clack.select({
          message: 'Email provider',
          options: [
            { value: 'fastmail', label: 'Fastmail', hint: 'imap.fastmail.com' },
            { value: 'gmail', label: 'Gmail', hint: 'imap.gmail.com (app password required)' },
            { value: 'outlook', label: 'Outlook / Hotmail', hint: 'outlook.office365.com' },
            { value: 'custom', label: 'Custom', hint: 'enter IMAP/SMTP hosts manually' },
          ],
        })
        if (clack.isCancel(provider)) process.exit(0)

        const presets: Record<string, { imapHost: string; imapPort: string; smtpHost: string; smtpPort: string }> = {
          fastmail: { imapHost: 'imap.fastmail.com', imapPort: '993', smtpHost: 'smtp.fastmail.com', smtpPort: '465' },
          gmail: { imapHost: 'imap.gmail.com', imapPort: '993', smtpHost: 'smtp.gmail.com', smtpPort: '465' },
          outlook: { imapHost: 'outlook.office365.com', imapPort: '993', smtpHost: 'smtp-mail.outlook.com', smtpPort: '587' },
        }

        if (provider !== 'custom') {
          const preset = presets[provider]!
          imapHost = preset.imapHost
          imapPort = preset.imapPort
          smtpHost = preset.smtpHost
          smtpPort = preset.smtpPort
        } else {
          const ih = await clack.text({
            message: 'IMAP hostname',
            placeholder: 'imap.example.com',
            validate: (value) => value?.trim() ? undefined : 'IMAP hostname is required',
          })
          if (clack.isCancel(ih)) process.exit(0)
          imapHost = ih

          const ip = await clack.text({
            message: 'IMAP port',
            defaultValue: '993',
            validate: (value) => {
              const n = Number(value)
              return Number.isInteger(n) && n > 0 ? undefined : 'Must be a positive integer'
            },
          })
          if (clack.isCancel(ip)) process.exit(0)
          imapPort = ip

          const sh = await clack.text({ message: 'SMTP hostname (leave empty for read-only)', placeholder: 'smtp.example.com' })
          if (clack.isCancel(sh)) process.exit(0)
          smtpHost = sh || undefined

          if (smtpHost) {
            const sp = await clack.text({
              message: 'SMTP port',
              defaultValue: '465',
              validate: (value) => {
                const n = Number(value)
                return Number.isInteger(n) && n > 0 ? undefined : 'Must be a positive integer'
              },
            })
            if (clack.isCancel(sp)) process.exit(0)
            smtpPort = sp
          }
        }
      }

      if (!imapHost) {
        if (!interactive) {
          out.error('Missing --imap-host. Usage: zele login imap --email you@example.com --imap-host imap.example.com --password "pwd"')
          process.exit(1)
        }
      }

      // --- password ---
      let password = options.password
      if (!password && !options.imapPassword) {
        if (!interactive) {
          out.error('Missing --password. Usage: zele login imap --email you@example.com --imap-host imap.example.com --password "pwd"')
          process.exit(1)
        }
        const v = await clack.password({
          message: 'App password',
          validate: (value) => value?.trim() ? undefined : 'Password is required',
        })
        if (clack.isCancel(v)) process.exit(0)
        password = v
      }

      out.hint('Testing IMAP connection...')

      const result = await loginImap({
        email,
        imapHost: imapHost!,
        imapPort: imapPort ? Number(imapPort) : undefined,
        smtpHost,
        smtpPort: smtpPort ? Number(smtpPort) : undefined,
        password,
        imapUser: options.imapUser,
        imapPassword: options.imapPassword,
        smtpUser: options.smtpUser,
        smtpPassword: options.smtpPassword,
        tls: options.noTls !== true,
      })
      if (result instanceof Error) handleCommandError(result)

      const caps = smtpHost ? 'IMAP + SMTP' : 'IMAP only'
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

      // If no email specified and multiple accounts: prompt or error
      if (!email && emails.length > 1) {
        if (isAgent || !process.stdin.isTTY) {
          out.error('Multiple accounts logged in. Specify which to remove:')
          for (const e of emails) {
            console.error(`  ${e}`)
          }
          process.exit(1)
        }

        const choice = await clack.select({
          message: 'Which account to remove?',
          options: emails.map((e) => ({ value: e, label: e })),
        })
        if (clack.isCancel(choice)) {
          out.hint('Cancelled')
          return
        }
        email = choice
      }

      // If no email and only one account, use that one
      const targetEmail = email ?? emails[0]!

      if (!emails.includes(targetEmail)) {
        out.error(`Account not found: ${targetEmail}`)
        out.hint(`Logged in accounts: ${emails.join(', ')}`)
        process.exit(1)
      }

      if (!options.force) {
        if (isAgent || !process.stdin.isTTY) {
          out.error('Use --force to logout non-interactively')
          process.exit(1)
        }

        const confirmed = await clack.confirm({
          message: `Remove credentials for ${targetEmail}?`,
          initialValue: false,
        })

        if (clack.isCancel(confirmed) || !confirmed) {
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
