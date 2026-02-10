// OAuth2 authentication module for zele.
// Multi-account support: tokens are stored in the Prisma-managed SQLite DB
// (accounts table) keyed by (email, app_id). Supports login (browser OAuth),
// per-account token refresh, and helpers to get authenticated GmailClient
// instances for one or all accounts.
// app_id is the Google OAuth client ID used during login, enabling future
// support for multiple OAuth apps per email.

import http from 'node:http'
import readline from 'node:readline'
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
  'https://mail.google.com/',                       // Gmail (full)
  'https://www.googleapis.com/auth/calendar',       // Calendar (full)
  'https://www.googleapis.com/auth/userinfo.email', // Email identity
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

async function getAuthCodeFromBrowser(oauth2Client: OAuth2Client, port: number): Promise<string> {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })

  await errore.tryAsync({
    try: () => fkill(`:${port}`, { force: true, silent: true }),
    catch: (err) => new Error(String(err), { cause: err }),
  })

  process.stderr.write('\n' + pc.bold('1.') + ' Open this URL to authorize:\n\n')
  process.stderr.write('   ' + pc.cyan(pc.underline(authUrl)) + '\n\n')
  process.stderr.write(pc.bold('2.') + ' If running locally, the browser will redirect automatically.\n')
  process.stderr.write(pc.dim('   If running remotely, the redirect page won\'t load — that\'s fine.') + '\n')
  process.stderr.write(pc.dim('   Just copy the URL from your browser\'s address bar and paste it below.') + '\n\n')

  return new Promise((resolve, reject) => {
    let resolved = false
    let server: http.Server | null = null
    let rl: readline.Interface | null = null

    function finish(code: string) {
      if (resolved) return
      resolved = true
      server?.close()
      if (rl) {
        rl.close()
        process.stdin.unref()
      }
      resolve(code)
    }

    function fail(err: Error) {
      if (resolved) return
      resolved = true
      server?.close()
      rl?.close()
      reject(err)
    }

    server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<h1>Error: ${error}</h1>`)
        fail(new Error(error))
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h1>Success! You can close this window.</h1>')
        finish(code)
        return
      }

      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end('<h1>No authorization code received</h1>')
    })

    server.listen(port)

    if (process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      rl.question(pc.dim('Paste redirect URL here (or wait for auto-redirect): '), (answer) => {
        const code = extractCodeFromInput(answer)
        if (code) {
          finish(code)
        } else {
          process.stderr.write(pc.yellow('Could not extract authorization code from input.') + '\n')
          process.stderr.write(pc.dim('Waiting for browser redirect...') + '\n')
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
 * Returns the account identifier and an authenticated GmailClient.
 */
export async function login(appId?: string): Promise<{ email: string; appId: string; client: GmailClient }> {
  const resolved = resolveOAuthClient(appId)
  const oauth2Client = createOAuth2Client(appId)

  const code = await getAuthCodeFromBrowser(oauth2Client, resolved.redirectPort)
  process.stderr.write(pc.dim('Got authorization code, exchanging for tokens...') + '\n')

  const { tokens } = await oauth2Client.getToken(code)
  oauth2Client.setCredentials(tokens)

  // Discover email
  const client = new GmailClient({ auth: oauth2Client })
  const profile = errore.unwrap(await client.getProfile(), 'Login: failed to get profile')
  const email = profile.emailAddress

  // Upsert account in DB
  const prisma = await getPrisma()
  await prisma.account.upsert({
    where: { email_appId: { email, appId: resolved.clientId } },
    create: { email, appId: resolved.clientId, accountStatus: 'active', tokens: JSON.stringify(tokens), createdAt: new Date(), updatedAt: new Date() },
    update: { tokens: JSON.stringify(tokens), updatedAt: new Date() },
  })

  return { email, appId: resolved.clientId, client }
}

// ---------------------------------------------------------------------------
// Logout: remove account from DB
// ---------------------------------------------------------------------------

export async function logout(email: string): Promise<void> {
  const prisma = await getPrisma()
  // Delete all app_id entries for this email (logout removes all credentials for the email)
  await prisma.account.deleteMany({ where: { email } })
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
    process.stderr.write(pc.dim(`Token expired for ${account.email}, refreshing...`) + '\n')
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
