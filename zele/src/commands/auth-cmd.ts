// Auth commands: login, login imap, login microsoft, login zele, logout, logout zele, whoami.
// Manages authentication for zele (Google OAuth, Microsoft OAuth, IMAP/SMTP, zele.sh).
// Supports multiple accounts: login adds accounts, logout removes one.

import type { ZeleCli } from '../cli-types.js'
import fs from 'node:fs'
import { z } from 'zod'
import * as errore from 'errore'
import { isAgent, type GokeExecutionContext } from 'goke'
import * as clack from '@clack/prompts'
import { login, loginWithRefreshToken, loginImap, loginMicrosoft, logout, listAccounts, getAuthStatuses, getZeleShSession, listZeleShAccounts, removeZeleShSession } from '../auth.js'
import { runZeleLogin } from './inbox.js'
import { resolveZeleApiUrl } from '../zele-sh-client.js'
import { closeDb } from '../db.js'
import * as out from '../output.js'
import { handleCommandError } from '../output.js'
import type { BrowserAuthOptions } from '../oauth-callback-server.js'

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

async function runBrowserOAuth(
  ctx: GokeExecutionContext,
  run: (options?: BrowserAuthOptions) => Promise<{ email: string } | Error>,
) {
  const execute = async (options?: BrowserAuthOptions) => {
    const result = await run(options)
    if (result instanceof Error) handleCommandError(result)
    out.success(`Authenticated as ${result.email}`)
    await closeDb()
  }

  if (ctx.daemon.isDaemon) {
    await execute({
      openBrowser: false,
      allowManualCodeEntry: false,
      showInstructions: false,
      onAuthorizationUrl: (url) => {
        ctx.daemon.publishStartupMessage(`Open this URL to authorize:\n${url}\n`, { stream: 'stderr' })
        ctx.daemon.ready()
      },
    })
    return
  }

  if (isAgent || !process.stdout.isTTY) {
    await ctx.daemon.start({
      timeoutMs: LOGIN_TIMEOUT_MS,
      waitForStartup: true,
      startupTimeoutMs: 30_000,
    })
    out.hint('Login running in background.')
    out.hint('After approving in the browser, verify with: zele whoami')
    return
  }

  await execute()
}

export function registerAuthCommands(cli: ZeleCli) {
  cli
    .command('login', 'Authenticate with Google, Outlook, IMAP/SMTP, or zele.sh')
    .option(
      '--method [method]',
      z.enum(['google', 'imap', 'microsoft', 'zele']).optional().describe('Authentication method (google, microsoft, imap, zele)'),
    )
    .example('zele login --method google')
    .example('zele login --method microsoft')
    .example('zele login --method zele')
    .example('zele login imap')
    .action(async (options, ctx) => {
      let method = options.method

      if (!method) {
        if (isAgent || !process.stdin.isTTY) {
          out.error('Run non-interactively with: zele login --method google|imap|microsoft|zele')
          process.exit(1)
        }

        const choice = await clack.select({
          message: 'Choose authentication method',
          options: [
            { value: 'google', label: 'Google', hint: 'opens browser for OAuth' },
            { value: 'microsoft', label: 'Outlook / Hotmail', hint: 'opens browser for Microsoft OAuth' },
            { value: 'zele', label: 'zele.sh inbox', hint: 'free permanent @zele.sh address, owned by your Gmail' },
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

      if (method === 'microsoft') {
        await runBrowserOAuth(ctx, (authOptions) => loginMicrosoft(authOptions))
        return
      }

      if (method === 'zele') {
        await runZeleLogin({})
        return
      }

      await runBrowserOAuth(ctx, (authOptions) => login(undefined, authOptions))
    })

  cli
    .command('login imap', 'Add an IMAP/SMTP email account')
    .example('zele login imap --email you@fastmail.com --imap-host imap.fastmail.com --password "pwd"')
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
    .option('--smtp-tls', 'Force implicit TLS for SMTP (default: only on port 465; use for Proton Bridge SSL)')
    .option('--ca [ca]', z.string().optional().describe('Path to a PEM CA cert to trust (e.g. Proton Bridge cert.pem)'))
    .option('--insecure', 'Skip TLS certificate verification (unsafe; prefer --ca)')
    .option('--no-tls', 'Disable implicit TLS for IMAP; STARTTLS is attempted when advertised')
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
            { value: 'outlook', label: 'Outlook / Hotmail', hint: 'use zele login microsoft (password IMAP is disabled)' },
            { value: 'custom', label: 'Custom', hint: 'enter IMAP/SMTP hosts manually' },
          ],
        })
        if (clack.isCancel(provider)) process.exit(0)

        if (provider === 'outlook') {
          out.hint('Outlook password IMAP is disabled. Starting Microsoft OAuth...')
          const result = await loginMicrosoft({ email })
          if (result instanceof Error) handleCommandError(result)
          out.success(`Authenticated as ${result.email}`)
          await closeDb()
          process.exit(0)
        }

        const presets = {
          fastmail: { imapHost: 'imap.fastmail.com', imapPort: '993', smtpHost: 'smtp.fastmail.com', smtpPort: '465' },
          gmail: { imapHost: 'imap.gmail.com', imapPort: '993', smtpHost: 'smtp.gmail.com', smtpPort: '465' },
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

      let ca: string | undefined
      if (options.ca) {
        const caPath = options.ca
        const caResult = errore.try({
          try: () => fs.readFileSync(caPath, 'utf8'),
          catch: (err) => new Error(`Failed to read --ca file: ${caPath}`, { cause: err }),
        })
        if (caResult instanceof Error) handleCommandError(caResult)
        ca = caResult
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
        smtpTls: options.smtpTls,
        ca,
        insecure: options.insecure,
      })
      if (result instanceof Error) handleCommandError(result)

      const caps = smtpHost ? 'IMAP + SMTP' : 'IMAP only'
      out.success(`Authenticated ${result.email} (${caps})`)
      await closeDb()
      process.exit(0)
    })

  cli
    .command(
      'login google-token',
      'Add a Google account from a refresh token read on stdin (no browser). Used by apps that run the Google consent on their server: the machine refreshes through that server (--token-url), which keeps the client secret',
    )
    .option('--client-id <clientId>', z.string().describe('OAuth client ID the refresh token was issued to'))
    .option('--token-url <tokenUrl>', z.string().url().describe('Token endpoint that refreshes for this client (holds the secret)'))
    .example("printf '%s' \"$REFRESH_TOKEN\" | zele login google-token --client-id 123.apps.googleusercontent.com --token-url https://example.com/oauth/google/token")
    .action(async (options) => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk)
      const refreshToken = Buffer.concat(chunks).toString('utf-8').trim()
      if (!refreshToken || !options.clientId || !options.tokenUrl) {
        out.error('Usage: printf %s "$REFRESH_TOKEN" | zele login google-token --client-id <id> --token-url <url>')
        process.exit(1)
      }
      const result = await loginWithRefreshToken(refreshToken, options.clientId, options.tokenUrl)
      if (result instanceof Error) handleCommandError(result)
      out.success(`Authenticated as ${result.email}`)
      await closeDb()
    })

  cli
    .command('login microsoft', 'Add an Outlook / Hotmail / Microsoft 365 account via OAuth')
    .option('--email [email]', z.string().optional().describe('Email address (login hint)'))
    .example('zele login microsoft')
    .example('zele login microsoft --email you@outlook.com')
    .action(async (options, ctx) => {
      await runBrowserOAuth(ctx, (authOptions) => loginMicrosoft({ ...authOptions, email: options.email }))
    })

  cli
    .command(
      'login zele',
      'Sign in to zele.sh and add your receive-only @zele.sh inboxes. The owner must be a @gmail.com address: a code is emailed to it and read automatically when that Gmail is already a zele account',
    )
    .option('--owner [email]', z.string().optional().describe('Your @gmail.com address that owns the inboxes (pick one of your zele Gmail accounts so the code is read automatically)'))
    .option('--code [code]', z.string().optional().describe('Sign-in code from the zele.sh email (skips auto-read)'))
    .option('--name [name]', z.string().optional().describe('Also create name@zele.sh after sign-in'))
    .option('--api-url [apiUrl]', z.string().optional().describe('zele.sh server URL (default: https://zele.sh, env: ZELE_API_URL)'))
    .example('zele login zele')
    .example('zele login zele --owner you@gmail.com')
    .example('zele login zele --owner you@gmail.com --name tommy')
    .example('zele login zele --owner you@gmail.com --code 482913')
    .action(async (options) => {
      await runZeleLogin(options)
    })

  cli
    .command('logout zele', 'Sign out of zele.sh and remove all @zele.sh accounts from this machine. Inboxes and mail stay on the server')
    .option('--force', 'Skip confirmation')
    .option('--api-url [apiUrl]', z.string().optional().describe('zele.sh server URL (default: https://zele.sh, env: ZELE_API_URL)'))
    .action(async (options) => {
      const apiUrl = resolveZeleApiUrl(options.apiUrl)
      const session = getZeleShSession(apiUrl)
      if (!session) {
        out.hint(`Not signed in to ${apiUrl}`)
        return
      }
      const inboxes = listZeleShAccounts(apiUrl)
      if (!options.force) {
        if (isAgent || !process.stdin.isTTY) {
          out.error('Use --force to logout non-interactively: zele logout zele --force')
          process.exit(1)
        }
        const confirmed = await clack.confirm({
          message: `Sign out ${session.ownerEmail} and remove ${inboxes.length} @zele.sh account(s) from this machine?`,
          initialValue: false,
        })
        if (clack.isCancel(confirmed) || !confirmed) return
      }
      const removed = await removeZeleShSession(apiUrl)
      if (removed instanceof Error) handleCommandError(removed)
      out.success(`Signed out of zele.sh (${session.ownerEmail}), removed ${inboxes.length} inbox account(s)`)
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
          ...(s.owner ? { owner: s.owner } : {}),
          status: 'Authenticated',
          expires: s.expiresAt?.toISOString(),
        })),
        { summary: `${statuses.length} account(s)` },
      )
    })
}
