// OAuth2 authentication module for zele.
// Multi-account support: tokens are stored in the Prisma-managed SQLite DB
// (accounts table) keyed by (email, app_id). Supports login (browser OAuth),
// per-account token refresh, and helpers to get authenticated GmailClient
// instances for one or all accounts.
// app_id is the Google OAuth client ID used during login, enabling future
// support for multiple OAuth apps per email.

import http from 'node:http'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { OAuth2Client, type Credentials } from 'google-auth-library'
import fkill from 'fkill'
import pc from 'picocolors'
import { getPrisma } from './db.js'
import { GmailClient } from './gmail-client.js'
import { CalendarClient } from './calendar-client.js'
import * as errore from 'errore'
import { AuthError } from './api-utils.js'

// ---------------------------------------------------------------------------
// Known open-source Google OAuth clients (Desktop app type).
// All support localhost + OOB redirects. All have Gmail, Calendar, Drive,
// Contacts, Tasks, and other Google API scopes enabled.
// None support device code flow (requires "TVs and Limited Input" client type,
// which Google restricts — Gmail scopes are blocked from device code entirely).
// Source: public open-source repos, tested 2026-02-09.
// ---------------------------------------------------------------------------
const OAUTH_CLIENTS: Record<string, { clientId: string; clientSecret: string; redirectPort: number }> = {
  // Mozilla Thunderbird — largest user base, highest Google quota.
  // Source: searchfox.org/comm-central/source/mailnews/base/src/OAuth2Providers.sys.mjs
  thunderbird: {
    clientId: '406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com',
    clientSecret: 'kSmqreRr0qwBWJgbf5Y-PjSU',
    redirectPort: 8089,
  },
  // GNOME Online Accounts — used by Evolution, GNOME Calendar, Nautilus (Drive).
  // Source: github.com/GNOME/gnome-online-accounts/blob/master/meson_options.txt
  gnome: {
    clientId: '44438659992-7kgjeitenc16ssihbtdjbgguch7ju55s.apps.googleusercontent.com',
    clientSecret: '-gMLuQyDiI0XrQS_vx_mhuYF',
    redirectPort: 8089,
  },
  // KDE KAccounts — used by KMail, KOrganizer, Kontact.
  // Source: github.com/KDE/kaccounts-providers google.provider.in
  kde: {
    clientId: '317066460457-pkpkedrvt2ldq6g2hj1egfka2n7vpuoo.apps.googleusercontent.com',
    clientSecret: 'Y8eFAaWfcanV3amZdDvtbYUq',
    redirectPort: 8089,
  },
}

const ACTIVE_CLIENT = OAUTH_CLIENTS.thunderbird!

const CLIENT_ID =
  process.env.ZELE_CLIENT_ID ?? ACTIVE_CLIENT.clientId

const CLIENT_SECRET =
  process.env.ZELE_CLIENT_SECRET ?? ACTIVE_CLIENT.clientSecret

const SCOPES = [
  'https://mail.google.com/',                                  // Gmail (full)
  'https://www.googleapis.com/auth/gmail.settings.basic',      // Gmail settings (filters)
  'https://www.googleapis.com/auth/calendar',                  // Calendar (full)
  'https://www.googleapis.com/auth/userinfo.email',            // Email identity
]

// ---------------------------------------------------------------------------
// OAuth client resolution
// ---------------------------------------------------------------------------

/**
 * Resolve OAuth credentials and redirect port for a given appId.
 * Looks up the matching entry in OAUTH_CLIENTS by client ID.
 * Falls back to the active client / env vars.
 */
function resolveOAuthClient(appId?: string) {
  let clientId = CLIENT_ID
  let clientSecret = CLIENT_SECRET
  let redirectPort = ACTIVE_CLIENT.redirectPort

  if (appId) {
    // Look up by client ID value in OAUTH_CLIENTS
    const entry = Object.values(OAUTH_CLIENTS).find((c) => c.clientId === appId)
    if (entry) {
      clientId = entry.clientId
      clientSecret = entry.clientSecret
      redirectPort = entry.redirectPort
    } else {
      // Unknown app ID — use it directly (custom client scenario).
      // The caller must have set ZELE_CLIENT_SECRET or the token must
      // already have a refresh_token that works without the secret.
      clientId = appId
    }
  }

  return { clientId, clientSecret, redirectPort }
}

// ---------------------------------------------------------------------------
// OAuth2 client factory
// ---------------------------------------------------------------------------

/**
 * Create an OAuth2Client. If appId is provided, looks up the matching
 * client credentials from OAUTH_CLIENTS by client ID. Falls back to
 * the active client / env vars.
 */
export function createOAuth2Client(appId?: string): OAuth2Client {
  const { clientId, clientSecret, redirectPort } = resolveOAuthClient(appId)

  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri: `http://localhost:${redirectPort}`,
  })
}

// ---------------------------------------------------------------------------
// Account identifier — used throughout the codebase to scope data
// to a specific (email, app_id) pair.
// ---------------------------------------------------------------------------

export interface AccountId {
  email: string
  appId: string
}

// ---------------------------------------------------------------------------
// Browser OAuth flow
// ---------------------------------------------------------------------------

function extractCodeFromInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const url = errore.tryFn(() => new URL(trimmed))
  if (!(url instanceof Error)) {
    const code = url.searchParams.get('code')
    if (code) return code
  }

  if (trimmed.length > 10 && !trimmed.includes(' ')) {
    return trimmed
  }

  return null
}

interface BrowserAuthOptions {
  openBrowser?: boolean
  allowManualCodeEntry?: boolean
  showInstructions?: boolean
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function authCallbackHtml(options: {
  title: string
  message: string
  status: 'success' | 'error' | 'neutral'
  sectionTitle: string
  commands: Array<{ comment: string; command: string }>
}): string {
  const statusLabel = options.status === 'success'
    ? 'OK'
    : options.status === 'error'
      ? 'ERROR'
      : 'INFO'

  const commandsHtml = options.commands
    .map((c) =>
      `<span class="comment"># ${escapeHtml(c.comment)}</span>\n${escapeHtml(c.command)}`,
    )
    .join('\n\n')

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(options.title)}</title>
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      :root {
        --bg: #fff;
        --fg: #111;
        --muted: #444;
        --panel: #fafafa;
        --chip: #f5f5f5;
        --border: #eee;
        --comment: #888;
        --accent: #2563eb;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
          'Helvetica Neue', Arial, sans-serif;
        background: radial-gradient(1200px 600px at 50% -10%, rgba(37, 99, 235, 0.08), transparent 60%),
          var(--bg);
        color: var(--fg);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.25rem;
        line-height: 1.6;
      }
      .container {
        max-width: 560px;
        width: 100%;
        text-align: center;
      }
      .status {
        display: inline-flex;
        gap: 0.5rem;
        align-items: center;
        justify-content: center;
        font-family: 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 0.75rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--muted);
        background: var(--chip);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 0.25rem 0.6rem;
        margin: 0 auto 0.9rem;
        width: fit-content;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--accent);
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 650;
        margin-bottom: 0.75rem;
        letter-spacing: -0.02em;
      }
      p {
        color: var(--muted);
        margin-bottom: 1.25rem;
      }
      .section {
        margin-top: 1.75rem;
        padding-top: 1.75rem;
        border-top: 1px solid var(--border);
      }
      .section-title {
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #888;
        margin-bottom: 1rem;
      }
      pre {
        font-family: 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 0.8125rem;
        background: var(--panel);
        margin-left: -1rem;
        margin-right: -1rem;
        padding: 0.85rem 1rem;
        overflow-x: auto;
        line-height: 1.75;
        text-align: left;
        border-radius: 12px;
        border: 1px solid var(--border);
      }
      code {
        font-family: inherit;
      }
      .comment {
        color: var(--comment);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0f0f10;
          --fg: #eee;
          --muted: #aaa;
          --panel: #171718;
          --chip: #1b1b1c;
          --border: #2a2a2b;
          --comment: #666;
          --accent: #60a5fa;
        }
        body {
          background: radial-gradient(1200px 600px at 50% -10%, rgba(96, 165, 250, 0.16), transparent 60%),
            var(--bg);
        }
        .section-title {
          color: #777;
        }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="status"><span class="dot"></span>${escapeHtml(statusLabel)}</div>
      <h1>${escapeHtml(options.title)}</h1>
      <p>${escapeHtml(options.message)}</p>
      <div class="section">
        <div class="section-title">${escapeHtml(options.sectionTitle)}</div>
        <pre><code>${commandsHtml}</code></pre>
      </div>
    </div>
  </body>
</html>`
}

function openUrlInBrowser(url: string): Error | void {
  const command = process.platform === 'darwin'
    ? { bin: 'open', args: [url] }
    : process.platform === 'win32'
      ? { bin: 'cmd', args: ['/c', 'start', '', url] }
      : { bin: 'xdg-open', args: [url] }

  const child = errore.tryFn(() =>
    spawn(command.bin, command.args, {
      detached: true,
      stdio: 'ignore',
    }),
  )
  if (child instanceof Error) {
    return new Error(`Failed to open browser with ${command.bin}`, { cause: child })
  }

  child.unref()
}

async function getAuthCodeFromBrowser(
  oauth2Client: OAuth2Client,
  port: number,
  options?: BrowserAuthOptions,
): Promise<string | Error> {
  const openBrowser = options?.openBrowser ?? true
  const allowManualCodeEntry = options?.allowManualCodeEntry ?? true
  const showInstructions = options?.showInstructions ?? true

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })

  await errore.tryAsync({
    try: () => fkill(`:${port}`, { force: true, silent: true }),
    catch: (err) => new Error(String(err), { cause: err }),
  })

  if (showInstructions) {
    console.error('\n' + pc.bold('1.') + ' Open this URL to authorize:\n')
    console.error('   ' + pc.cyan(pc.underline(authUrl)) + '\n')
    console.error(pc.bold('2.') + ' If running locally, the browser will redirect automatically.')
    console.error(pc.dim('   If running remotely, the redirect page won\'t load — that\'s fine.'))
    console.error(pc.dim('   Just copy the URL from your browser\'s address bar and paste it below.') + '\n')
  }

  if (openBrowser) {
    const openResult = openUrlInBrowser(authUrl)
    if (openResult instanceof Error && showInstructions) {
      console.error(pc.yellow(`Could not auto-open browser: ${openResult.message}`))
      console.error(pc.dim('Open the URL above manually.'))
    }
  }

  return new Promise((resolve) => {
    let resolved = false
    let server: http.Server | null = null
    let rl: readline.Interface | null = null

    function closeServer() {
      if (server) {
        server.closeAllConnections()
        server.close()
      }
    }

    function finish(code: string) {
      if (resolved) return
      resolved = true
      closeServer()
      if (rl) {
        rl.close()
        process.stdin.unref()
      }
      resolve(code)
    }

    function fail(err: Error) {
      if (resolved) return
      resolved = true
      closeServer()
      rl?.close()
      resolve(err)
    }

    server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(
          authCallbackHtml({
            title: 'Authorization failed',
            message: `Google returned: ${error}`,
            status: 'error',
            sectionTitle: 'Try again',
            commands: [
              { comment: 'Start login again', command: 'zele login' },
              {
                comment: 'If running remotely, copy the full redirect URL',
                command: '# ...and paste it into the terminal prompt',
              },
            ],
          }),
        )
        fail(new Error(error))
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          authCallbackHtml({
            title: 'Login complete',
            message: 'You can close this tab and go back to the terminal.',
            status: 'success',
            sectionTitle: 'Next steps',
            commands: [
              { comment: 'Plan: verify the account is saved', command: 'zele whoami' },
              { comment: 'Plan: list your latest threads', command: 'zele mail list' },
              { comment: 'Plan: search with Gmail query syntax', command: 'zele mail search "from:github"' },
            ],
          }),
        )
        finish(code)
        return
      }

      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(
        authCallbackHtml({
          title: 'No authorization code received',
          message: 'This page was opened without the OAuth "code" parameter.',
          status: 'neutral',
          sectionTitle: 'What to do',
          commands: [
            { comment: 'Restart login and try again', command: 'zele login' },
            {
              comment: 'If the browser can’t reach localhost, that’s fine',
              command: '# Copy the redirect URL from the address bar and paste it into the terminal',
            },
          ],
        }),
      )
    })

    server.listen(port)
    server.on('error', (err) => {
      fail(new Error(`Failed to start local auth callback server on port ${port}`, { cause: err }))
    })

    if (allowManualCodeEntry && process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      rl.question(pc.dim('Paste redirect URL here (or wait for auto-redirect): '), (answer) => {
        const code = extractCodeFromInput(answer)
        if (code) {
          finish(code)
        } else {
          console.error(pc.yellow('Could not extract authorization code from input.'))
          console.error(pc.dim('Waiting for browser redirect...'))
        }
      })
    }
  })
}

// ---------------------------------------------------------------------------
// Login: browser OAuth → save tokens to DB
// ---------------------------------------------------------------------------

/**
 * Run the full browser OAuth flow and save the account to the DB.
 * Returns either a successful login payload or an Error value.
 */
export async function login(
  appId?: string,
  options?: BrowserAuthOptions,
): Promise<{ email: string; appId: string; client: GmailClient } | Error> {
  const resolved = resolveOAuthClient(appId)
  const oauth2Client = createOAuth2Client(appId)

  const code = await getAuthCodeFromBrowser(oauth2Client, resolved.redirectPort, options)
  if (code instanceof Error) return code

  if (options?.showInstructions ?? true) {
    console.error(pc.dim('Got authorization code, exchanging for tokens...'))
  }

  const tokenResponse = await errore.tryAsync({
    try: () => oauth2Client.getToken(code),
    catch: (err) => new Error('Failed to exchange authorization code for tokens', { cause: err }),
  })
  if (tokenResponse instanceof Error) return tokenResponse

  const { tokens } = tokenResponse
  oauth2Client.setCredentials(tokens)

  // Discover email
  const client = new GmailClient({ auth: oauth2Client })
  const profile = await client.getProfile()
  if (profile instanceof Error) return profile
  const email = profile.emailAddress

  // Upsert account in DB
  const prisma = await getPrisma()
  const upsertResult = await errore.tryAsync({
    try: () =>
      prisma.account.upsert({
        where: { email_appId: { email, appId: resolved.clientId } },
        create: {
          email,
          appId: resolved.clientId,
          accountStatus: 'active',
          tokens: JSON.stringify(tokens),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        update: { tokens: JSON.stringify(tokens), updatedAt: new Date() },
      }),
    catch: (err) => new Error(`Failed to save account ${email}`, { cause: err }),
  })
  if (upsertResult instanceof Error) return upsertResult

  return { email, appId: resolved.clientId, client }
}

// ---------------------------------------------------------------------------
// Logout: remove account from DB
// ---------------------------------------------------------------------------

export async function logout(email: string): Promise<void | Error> {
  const prisma = await getPrisma()
  // Delete all app_id entries for this email (logout removes all credentials for the email)
  const result = await errore.tryAsync({
    try: () => prisma.account.deleteMany({ where: { email } }),
    catch: (err) => new Error(`Failed to remove credentials for ${email}`, { cause: err }),
  })
  if (result instanceof Error) return result
}

// ---------------------------------------------------------------------------
// Account listing
// ---------------------------------------------------------------------------

export async function listAccounts(): Promise<AccountId[]> {
  const prisma = await getPrisma()
  const rows = await prisma.account.findMany({ select: { email: true, appId: true } })
  return rows.map((r) => ({ email: r.email, appId: r.appId }))
}

// ---------------------------------------------------------------------------
// Get authenticated clients
// ---------------------------------------------------------------------------

/**
 * Create an authenticated OAuth2Client for a known account.
 * Loads tokens from DB, refreshes if expired, saves refreshed tokens back.
 * Uses the stored app_id to create the OAuth2 client with the correct credentials.
 */
async function authenticateAccount(account: AccountId): Promise<OAuth2Client> {
  const prisma = await getPrisma()
  const row = await prisma.account.findUnique({
    where: { email_appId: { email: account.email, appId: account.appId } },
  })
  if (!row) {
    throw new Error(`No account found for ${account.email}. Run: zele login`)
  }

  const tokens: Credentials = JSON.parse(row.tokens)
  const oauth2Client = createOAuth2Client(account.appId)
  oauth2Client.setCredentials(tokens)

  // Refresh if expired — merge to preserve refresh_token which Google
  // often omits from refresh responses
  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    console.error(pc.dim(`Token expired for ${account.email}, refreshing...`))
    const { credentials } = await oauth2Client.refreshAccessToken()
    const merged = { ...tokens, ...credentials }
    oauth2Client.setCredentials(merged)
    await prisma.account.update({
      where: { email_appId: { email: account.email, appId: account.appId } },
      data: { tokens: JSON.stringify(merged), updatedAt: new Date() },
    })
  }

  return oauth2Client
}

/**
 * Get authenticated GmailClient instances for all accounts (or filtered by email list).
 * If no accounts are registered, throws with a helpful message.
 */
export async function getClients(
  accounts?: string[],
): Promise<Array<{ email: string; appId: string; client: GmailClient }>> {
  const allAccounts = await listAccounts()
  if (allAccounts.length === 0) {
    throw new Error('No accounts registered. Run: zele login')
  }

  const filtered = accounts && accounts.length > 0
    ? allAccounts.filter((a) => accounts.includes(a.email))
    : allAccounts

  if (filtered.length === 0) {
    const available = allAccounts.map((a) => a.email).join(', ')
    throw new Error(`No matching accounts. Available: ${available}`)
  }

  const results = await Promise.all(
    filtered.map(async (account) => {
      const auth = await authenticateAccount(account)
      return { email: account.email, appId: account.appId, client: new GmailClient({ auth, account }) }
    }),
  )

  return results
}

/**
 * Get a single authenticated GmailClient. Errors if multiple accounts exist
 * and no --account filter was provided.
 */
export async function getClient(
  accounts?: string[],
): Promise<{ email: string; appId: string; client: GmailClient }> {
  const clients = await getClients(accounts)
  if (clients.length === 1) {
    return clients[0]!
  }

  const emails = clients.map((c) => c.email).join('\n  ')
  throw new Error(
    `Multiple accounts matched. Specify --account:\n  ${emails}`,
  )
}

// ---------------------------------------------------------------------------
// Calendar client helpers
// ---------------------------------------------------------------------------

/**
 * Get authenticated CalendarClient instances for all accounts (or filtered by email list).
 */
export async function getCalendarClients(
  accounts?: string[],
): Promise<Array<{ email: string; appId: string; client: CalendarClient }>> {
  const allAccounts = await listAccounts()
  if (allAccounts.length === 0) {
    throw new Error('No accounts registered. Run: zele login')
  }

  const filtered = accounts && accounts.length > 0
    ? allAccounts.filter((a) => accounts.includes(a.email))
    : allAccounts

  if (filtered.length === 0) {
    const available = allAccounts.map((a) => a.email).join(', ')
    throw new Error(`No matching accounts. Available: ${available}`)
  }

  const results = await Promise.all(
    filtered.map(async (account) => {
      const auth = await authenticateAccount(account)
      const { token } = await auth.getAccessToken()
      if (!token) throw new Error(`Failed to get access token for ${account.email}`)
      return { email: account.email, appId: account.appId, client: new CalendarClient({ accessToken: token, email: account.email, appId: account.appId }) }
    }),
  )

  return results
}

/**
 * Get a single authenticated CalendarClient. Errors if multiple accounts exist
 * and no --account filter was provided.
 */
export async function getCalendarClient(
  accounts?: string[],
): Promise<{ email: string; appId: string; client: CalendarClient }> {
  const clients = await getCalendarClients(accounts)
  if (clients.length === 1) {
    return clients[0]!
  }

  const emails = clients.map((c) => c.email).join('\n  ')
  throw new Error(
    `Multiple accounts matched. Specify --account:\n  ${emails}`,
  )
}

// ---------------------------------------------------------------------------
// Auth status (for auth status command)
// ---------------------------------------------------------------------------

export interface AuthStatus {
  email: string
  appId: string
  expiresAt?: Date
}

export async function getAuthStatuses(): Promise<AuthStatus[]> {
  const prisma = await getPrisma()
  const rows = await prisma.account.findMany()

  return rows.map((row) => {
    const tokens: Credentials = JSON.parse(row.tokens)
    return {
      email: row.email,
      appId: row.appId,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    }
  })
}
