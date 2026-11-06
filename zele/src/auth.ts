// Authentication module for zele.
// Multi-account support: tokens are stored in the Drizzle-managed SQLite DB
// (accounts table) keyed by (email, app_id). Supports Google browser OAuth,
// Microsoft Outlook XOAUTH2, IMAP/SMTP passwords, per-account token refresh,
// and helpers to get authenticated GmailClient / ImapSmtpClient instances.
// app_id is the OAuth client ID used during login (Google) or `imap_smtp`.

import { OAuth2Client } from 'googleapis-common'

type GoogleTokens = {
  access_token?: string | null
  refresh_token?: string | null
  expiry_date?: number | null
  token_type?: string | null
  id_token?: string | null
  scope?: string
  /** Token endpoint of a refresh broker that holds the client secret (see loginWithRefreshToken). */
  token_url?: string
}
import { colors as pc } from 'goke'
import * as orm from 'drizzle-orm'
import { getDb, schema } from './db.js'
import { GmailClient } from './gmail-client.js'
import { CalendarClient } from './calendar-client.js'
import * as errore from 'errore'
import { AuthError, UnsupportedError, ZeleShSignedOutError } from './api-utils.js'
import { ImapSmtpClient, imapTlsOptions, tlsSocketOptions } from './imap-smtp-client.js'
import { ZeleShApi, ZeleShClient } from './zele-sh-client.js'
import { waitForOAuthCode, type BrowserAuthOptions } from './oauth-callback-server.js'
import {
  MICROSOFT_REDIRECT_PORT,
  buildMicrosoftAuthUrl,
  createPkce,
  emailFromIdToken,
  exchangeMicrosoftCode,
  refreshMicrosoftToken,
  resolveMicrosoftAccountEmail,
  type MicrosoftOAuthTokens,
} from './microsoft-oauth.js'

// ---------------------------------------------------------------------------
// Account types
// ---------------------------------------------------------------------------

export type AccountType = 'google' | 'imap_smtp' | 'zele_sh'

export const IMAP_SMTP_APP_ID = 'imap_smtp' as const
export const ZELE_SH_APP_ID = 'zele_sh' as const

/** Stored in the `tokens` column for zele_sh accounts. The bearer token lives in ZeleShSession. */
export interface ZeleShAccountTokens {
  apiUrl: string
}

export interface ImapCredentials {
  host: string
  port: number
  user: string
  password?: string
  tls: boolean
  /** PEM contents of a CA cert to trust (e.g. Proton Bridge cert.pem). */
  ca?: string
  /** Skip TLS certificate verification. Unsafe; prefer a custom CA. */
  insecure?: boolean
}

export interface SmtpCredentials {
  host: string
  port: number
  user: string
  password?: string
  tls: boolean
  ca?: string
  insecure?: boolean
}

/** Stored in the `tokens` column for imap_smtp accounts. */
export interface ImapSmtpCredentials {
  imap?: ImapCredentials
  smtp?: SmtpCredentials
  oauth?: MicrosoftOAuthTokens
}

/** Capabilities an account can have. */
export type AccountCapability = 'gmail' | 'calendar' | 'smtp' | 'imap' | 'receive'

export function parseCapabilities(raw: string): AccountCapability[] {
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean) as AccountCapability[]
}

export function hasCapability(capabilities: string | AccountCapability[], cap: AccountCapability): boolean {
  const list = typeof capabilities === 'string' ? parseCapabilities(capabilities) : capabilities
  return list.includes(cap)
}

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
  'https://mail.google.com/',                       // Gmail (full — covers settings, filters, etc.)
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
export function createOAuth2Client(appId?: string, tokenUrl?: string): OAuth2Client {
  const { clientId, clientSecret, redirectPort } = resolveOAuthClient(appId)

  return new OAuth2Client({
    clientId,
    // A broker refreshes with its own secret; ours would leak to it.
    clientSecret: tokenUrl ? undefined : clientSecret,
    redirectUri: `http://localhost:${redirectPort}`,
    ...(tokenUrl ? { endpoints: { oauth2TokenUrl: tokenUrl } } : {}),
  })
}

// ---------------------------------------------------------------------------
// Account identifier — used throughout the codebase to scope data
// to a specific (email, app_id) pair.
// ---------------------------------------------------------------------------

export interface AccountId {
  email: string
  appId: string
  accountType: AccountType
  capabilities: AccountCapability[]
}

// ---------------------------------------------------------------------------
// Browser OAuth flow
// ---------------------------------------------------------------------------

async function getAuthCodeFromBrowser(
  oauth2Client: OAuth2Client,
  port: number,
  options?: BrowserAuthOptions,
): Promise<string | Error> {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })
  return waitForOAuthCode({
    authUrl,
    port,
    loginCommand: 'zele login',
    provider: 'Google',
    openBrowser: options?.openBrowser,
    allowManualCodeEntry: options?.allowManualCodeEntry,
    showInstructions: options?.showInstructions,
    onAuthorizationUrl: options?.onAuthorizationUrl,
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

  const saved = saveGoogleAccount(email, resolved.clientId, tokens)
  if (saved instanceof Error) return saved

  return { email, appId: resolved.clientId, client }
}

function saveGoogleAccount(email: string, appId: string, tokens: GoogleTokens): void | Error {
  const db = getDb()
  const googleCapabilities = 'gmail,calendar,smtp'
  const now = new Date()
  return errore.try({
    try: () => {
      db.insert(schema.account)
        .values({
          email,
          appId,
          accountType: 'google',
          capabilities: googleCapabilities,
          accountStatus: 'active',
          tokens: JSON.stringify(tokens),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.account.email, schema.account.appId],
          set: { tokens: JSON.stringify(tokens), capabilities: googleCapabilities, updatedAt: now },
        })
        .run()
    },
    catch: (err) => new Error(`Failed to save account ${email}`, { cause: err }),
  })
}

/**
 * Add a Google account from a refresh token obtained elsewhere (e.g. a web app
 * that ran the consent flow on a server). `tokenUrl` is that server's token
 * endpoint: it holds the client secret, so this machine refreshes through it
 * and never sees the secret. Verifies the token with a real API call first.
 */
export async function loginWithRefreshToken(
  refreshToken: string,
  clientId: string,
  tokenUrl: string,
): Promise<{ email: string; appId: string } | Error> {
  const oauth2Client = createOAuth2Client(clientId, tokenUrl)
  oauth2Client.setCredentials({ refresh_token: refreshToken })
  const refreshed = await errore.tryAsync({
    try: () => oauth2Client.refreshAccessToken(),
    catch: (err) => new Error('Failed to refresh the access token', { cause: err }),
  })
  if (refreshed instanceof Error) return refreshed

  const tokens: GoogleTokens = { ...refreshed.credentials, refresh_token: refreshToken, token_url: tokenUrl }
  oauth2Client.setCredentials(tokens)
  const profile = await new GmailClient({ auth: oauth2Client }).getProfile()
  if (profile instanceof Error) return profile

  const saved = saveGoogleAccount(profile.emailAddress, clientId, tokens)
  if (saved instanceof Error) return saved
  // The imported token replaces this address's sign-ins on other OAuth apps, so
  // the account isn't listed (and synced) twice.
  const db = getDb()
  db.delete(schema.account)
    .where(orm.and(orm.eq(schema.account.email, profile.emailAddress), orm.ne(schema.account.appId, clientId)))
    .run()
  return { email: profile.emailAddress, appId: clientId }
}

// ---------------------------------------------------------------------------
// Login: IMAP/SMTP credentials → save to DB
// ---------------------------------------------------------------------------

export interface LoginImapOptions {
  email: string
  imapHost: string
  imapPort?: number
  smtpHost?: string
  smtpPort?: number
  password?: string
  imapUser?: string
  imapPassword?: string
  smtpUser?: string
  smtpPassword?: string
  tls?: boolean
  smtpTls?: boolean
  ca?: string
  insecure?: boolean
}

/**
 * Login with IMAP/SMTP credentials. Tests connections before saving.
 * Returns an error value if validation or connection test fails.
 */
export async function loginImap(
  options: LoginImapOptions,
): Promise<{ email: string; appId: string } | Error> {
  const {
    email,
    imapHost,
    imapPort = 993,
    smtpHost,
    smtpPort = 465,
    password,
    imapUser,
    imapPassword,
    smtpUser,
    smtpPassword,
    tls = true,
    smtpTls,
    ca,
    insecure,
  } = options

  const imapPass = imapPassword ?? password
  if (!imapPass) {
    return new Error('IMAP password is required (--password or --imap-password)')
  }

  const credentials: ImapSmtpCredentials = {
    imap: {
      host: imapHost,
      port: imapPort,
      user: imapUser ?? email,
      password: imapPass,
      tls,
      ca,
      insecure,
    },
  }

  // Test IMAP connection
  const { ImapFlow } = await import('imapflow')
  const imapTls = imapTlsOptions({ ca, insecure }, imapHost)
  const testClient = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: tls,
    auth: { user: imapUser ?? email, pass: imapPass },
    logger: false,
    tls: imapTls,
  })

  const imapTest = await errore.tryAsync({
    try: async () => {
      await testClient.connect()
      await testClient.logout()
    },
    catch: (err) => new AuthError({ email, reason: `IMAP connection failed: ${String(err)}` }),
  })
  if (imapTest instanceof Error) return imapTest

  // Configure SMTP if provided
  const capabilities: AccountCapability[] = ['imap']

  if (smtpHost) {
    const smtpPass = smtpPassword ?? password
    if (!smtpPass) {
      return new Error('SMTP password is required when --smtp-host is provided (--password or --smtp-password)')
    }

    const smtpTlsEnabled = smtpTls ?? smtpPort === 465
    credentials.smtp = {
      host: smtpHost,
      port: smtpPort,
      user: smtpUser ?? email,
      password: smtpPass,
      tls: smtpTlsEnabled,
      ca,
      insecure,
    }

    // Test SMTP connection
    const nodemailer = await import('nodemailer')
    const smtpTlsOptions = tlsSocketOptions({ ca, insecure })
    const transporter = nodemailer.default.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpTlsEnabled,
      tls: smtpTlsOptions,
      auth: { user: smtpUser ?? email, pass: smtpPass },
    })

    const smtpTest = await errore.tryAsync({
      try: () => transporter.verify(),
      catch: (err) => new AuthError({ email, reason: `SMTP connection failed: ${String(err)}` }),
    })
    if (smtpTest instanceof Error) return smtpTest

    capabilities.push('smtp')
  }

  // Save to DB
  const db = getDb()
  const now = new Date()
  const upsertResult = await errore.tryAsync({
    try: async () => {
      db.insert(schema.account)
        .values({
          email,
          appId: IMAP_SMTP_APP_ID,
          accountType: 'imap_smtp',
          capabilities: capabilities.join(','),
          accountStatus: 'active',
          tokens: JSON.stringify(credentials),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.account.email, schema.account.appId],
          set: {
            capabilities: capabilities.join(','),
            tokens: JSON.stringify(credentials),
            updatedAt: now,
          },
        })
        .run()
    },
    catch: (err) => new Error(`Failed to save account ${email}`, { cause: err }),
  })
  if (upsertResult instanceof Error) return upsertResult

  return { email, appId: IMAP_SMTP_APP_ID }
}

const OUTLOOK_IMAP_HOST = 'outlook.office365.com'
const OUTLOOK_SMTP_HOST = 'smtp-mail.outlook.com'

/**
 * Login to Outlook.com / Hotmail / Microsoft 365 via OAuth (XOAUTH2).
 * Password IMAP is disabled on those servers.
 */
export async function loginMicrosoft(
  options?: BrowserAuthOptions & { email?: string },
): Promise<{ email: string; appId: string } | Error> {
  const { verifier, challenge } = createPkce()
  const redirectUri = `http://localhost:${MICROSOFT_REDIRECT_PORT}`
  const authUrl = buildMicrosoftAuthUrl({
    challenge,
    redirectUri,
    loginHint: options?.email,
  })

  const code = await waitForOAuthCode({
    authUrl,
    port: MICROSOFT_REDIRECT_PORT,
    loginCommand: 'zele login microsoft',
    provider: 'Microsoft',
    openBrowser: options?.openBrowser,
    allowManualCodeEntry: options?.allowManualCodeEntry,
    showInstructions: options?.showInstructions,
    onAuthorizationUrl: options?.onAuthorizationUrl,
  })
  if (code instanceof Error) return code

  if (options?.showInstructions ?? true) {
    console.error(pc.dim('Got authorization code, exchanging for tokens...'))
  }

  const oauth = await exchangeMicrosoftCode({ code, verifier, redirectUri })
  if (oauth instanceof Error) return oauth

  const email = resolveMicrosoftAccountEmail({
    tokenEmail: oauth.idToken ? emailFromIdToken(oauth.idToken) : undefined,
    requestedEmail: options?.email,
  })
  if (email instanceof Error) return email

  const credentials: ImapSmtpCredentials = {
    imap: {
      host: OUTLOOK_IMAP_HOST,
      port: 993,
      user: email,
      tls: true,
    },
    smtp: {
      host: OUTLOOK_SMTP_HOST,
      port: 587,
      user: email,
      tls: false,
    },
    oauth,
  }

  const { ImapFlow } = await import('imapflow')
  const testClient = new ImapFlow({
    host: OUTLOOK_IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: email, accessToken: oauth.accessToken },
    logger: false,
  })
  const imapTest = await errore.tryAsync({
    try: async () => {
      await testClient.connect()
      await testClient.logout()
    },
    catch: (err) => new AuthError({ email, reason: `IMAP XOAUTH2 failed: ${String(err)}` }),
  })
  if (imapTest instanceof Error) return imapTest

  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.default.createTransport({
    host: OUTLOOK_SMTP_HOST,
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { type: 'OAuth2', user: email, accessToken: oauth.accessToken, expires: oauth.expiry },
  })
  const smtpTest = await errore.tryAsync({
    try: () => transporter.verify(),
    catch: (err) => new AuthError({ email, reason: `SMTP XOAUTH2 failed: ${String(err)}` }),
  })
  if (smtpTest instanceof Error) return smtpTest

  const db = getDb()
  const now = new Date()
  const upsertResult = await errore.tryAsync({
    try: async () => {
      db.insert(schema.account)
        .values({
          email,
          appId: IMAP_SMTP_APP_ID,
          accountType: 'imap_smtp',
          capabilities: 'imap,smtp',
          accountStatus: 'active',
          tokens: JSON.stringify(credentials),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.account.email, schema.account.appId],
          set: {
            capabilities: 'imap,smtp',
            tokens: JSON.stringify(credentials),
            updatedAt: now,
          },
        })
        .run()
    },
    catch: (err) => new Error(`Failed to save account ${email}`, { cause: err }),
  })
  if (upsertResult instanceof Error) return upsertResult

  return { email, appId: IMAP_SMTP_APP_ID }
}

export async function loadImapCredentials(account: AccountId): Promise<ImapSmtpCredentials | AuthError> {
  const db = getDb()
  const row = db.query.account.findFirst({
    where: { email: account.email, appId: account.appId },
  }).sync()
  if (!row) {
    return new AuthError({ email: account.email, reason: 'No account found. Run: zele login' })
  }
  const stored: ImapSmtpCredentials = JSON.parse(row.tokens)
  if (!stored.oauth || stored.oauth.expiry > Date.now() + 60_000) return stored
  const refreshed = await refreshMicrosoftToken(stored.oauth.refreshToken)
  if (refreshed instanceof Error) {
    return new AuthError({ email: account.email, reason: `${refreshed.message}. Try: zele login microsoft` })
  }
  const next = { ...stored, oauth: refreshed }
  const save = await errore.tryAsync({
    try: async () => {
      db.update(schema.account)
        .set({ tokens: JSON.stringify(next), updatedAt: new Date() })
        .where(orm.and(orm.eq(schema.account.email, account.email), orm.eq(schema.account.appId, account.appId)))
        .run()
    },
    catch: (err) => new AuthError({ email: account.email, reason: `Failed to save refreshed token: ${String(err)}` }),
  })
  if (save instanceof Error) return save
  return next
}

// ---------------------------------------------------------------------------
// Logout: remove account from DB
// ---------------------------------------------------------------------------

export async function logout(email: string): Promise<void | Error> {
  const db = getDb()
  const result = await errore.tryAsync({
    try: async () => {
      db.delete(schema.account).where(orm.eq(schema.account.email, email)).run()
    },
    catch: (err) => new Error(`Failed to remove credentials for ${email}`, { cause: err }),
  })
  if (result instanceof Error) return result
}

// ---------------------------------------------------------------------------
// Account listing
// ---------------------------------------------------------------------------

export async function listAccounts(): Promise<AccountId[]> {
  const rows = getDb().query.account.findMany({
    columns: { tokens: false },
  }).sync()
  return rows.map((r) => ({
    email: r.email,
    appId: r.appId,
    accountType: r.accountType as AccountType,
    capabilities: parseCapabilities(r.capabilities),
  }))
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
  const db = getDb()
  const row = db.query.account.findFirst({
    where: { email: account.email, appId: account.appId },
  }).sync()
  if (!row) {
    throw new Error(`No account found for ${account.email}. Run: zele login`)
  }

  const tokens: GoogleTokens = JSON.parse(row.tokens)
  const oauth2Client = createOAuth2Client(account.appId, tokens.token_url)
  oauth2Client.setCredentials(tokens)

  // Refresh if expired — merge to preserve refresh_token which Google
  // often omits from refresh responses
  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    console.error(pc.dim(`Token expired for ${account.email}, refreshing...`))
    const { credentials } = await oauth2Client.refreshAccessToken()
    const merged = { ...tokens, ...credentials }
    oauth2Client.setCredentials(merged)
    db.update(schema.account)
      .set({ tokens: JSON.stringify(merged), updatedAt: new Date() })
      .where(orm.and(orm.eq(schema.account.email, account.email), orm.eq(schema.account.appId, account.appId)))
      .run()
  }

  return oauth2Client
}

/** Entry returned by getClients — client is GmailClient for Google accounts, ImapSmtpClient for IMAP/SMTP. */
export interface ClientEntry {
  email: string
  appId: string
  accountType: AccountType
  capabilities: AccountCapability[]
  client: GmailClient | ImapSmtpClient | ZeleShClient
}

/**
 * Get authenticated client instances for all accounts (or filtered by email list).
 * Returns GmailClient for Google accounts and ImapSmtpClient for IMAP/SMTP accounts.
 * If no accounts are registered, throws with a helpful message.
 */
export async function getClients(
  accounts?: string[],
): Promise<ClientEntry[]> {
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
    filtered.map(async (account): Promise<ClientEntry> => {
      if (account.accountType === 'zele_sh') {
        return {
          email: account.email,
          appId: account.appId,
          accountType: 'zele_sh',
          capabilities: account.capabilities,
          client: new ZeleShClient({ account, loadApi: () => loadZeleShApi(account) }),
        }
      }

      if (account.accountType === 'imap_smtp') {
        return {
          email: account.email,
          appId: account.appId,
          accountType: 'imap_smtp',
          capabilities: account.capabilities,
          client: new ImapSmtpClient({
            account,
            loadCredentials: () => loadImapCredentials(account),
          }),
        }
      }

      // Google account
      const auth = await authenticateAccount(account)
      return {
        email: account.email,
        appId: account.appId,
        accountType: 'google',
        capabilities: account.capabilities,
        client: new GmailClient({ auth, account }),
      }
    }),
  )

  return results
}

/**
 * Get a single authenticated client. Errors if multiple accounts exist
 * and no --account filter was provided.
 */
export async function getClient(
  accounts?: string[],
): Promise<ClientEntry> {
  const clients = await getClients(accounts)
  if (clients.length === 1) {
    return clients[0]!
  }

  const emails = clients.map((c) => c.email).join('\n  ')
  throw new Error(
    `Multiple accounts matched. Specify --account:\n  ${emails}`,
  )
}

/**
 * Get a single authenticated GmailClient. Errors if account is not a Google account.
 * Use this for commands that require Gmail-specific features.
 */
export async function getGmailClient(
  accounts?: string[],
): Promise<{ email: string; appId: string; client: GmailClient }> {
  const entry = await getClient(accounts)
  if (entry.accountType !== 'google') {
    throw new UnsupportedError({
      feature: 'This command',
      accountType: 'IMAP/SMTP',
      hint: 'It requires a Google account.',
    })
  }
  return { email: entry.email, appId: entry.appId, client: entry.client as GmailClient }
}

// ---------------------------------------------------------------------------
// Calendar client helpers
// ---------------------------------------------------------------------------

/**
 * Get authenticated CalendarClient instances for Google accounts only.
 * IMAP/SMTP accounts are silently skipped (calendar requires Google OAuth).
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

  // Only Google accounts support calendar
  const googleAccounts = filtered.filter((a) => a.accountType === 'google')
  if (googleAccounts.length === 0) {
    throw new UnsupportedError({
      feature: 'Calendar',
      accountType: 'IMAP/SMTP',
      hint: 'Calendar requires a Google account.',
    })
  }

  const results = await Promise.all(
    googleAccounts.map(async (account) => {
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
  accountType: AccountType
  capabilities: AccountCapability[]
  expiresAt?: Date
  /** zele.sh inboxes: the @gmail.com address that owns them. */
  owner?: string
}

export async function getAuthStatuses(): Promise<AuthStatus[]> {
  const rows = getDb().query.account.findMany().sync()

  return rows.map((row) => {
    const accountType = row.accountType as AccountType
    const capabilities = parseCapabilities(row.capabilities)
    if (accountType === 'google') {
      const tokens: GoogleTokens = JSON.parse(row.tokens)
      return {
        email: row.email,
        appId: row.appId,
        accountType,
        capabilities,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      }
    }
    if (accountType === 'zele_sh') {
      const { apiUrl }: ZeleShAccountTokens = JSON.parse(row.tokens)
      const session = getDb().query.zeleShSession.findFirst({ where: { apiUrl } }).sync()
      return { email: row.email, appId: row.appId, accountType, capabilities, owner: session?.ownerEmail }
    }
    const creds: ImapSmtpCredentials = JSON.parse(row.tokens)
    return {
      email: row.email,
      appId: row.appId,
      accountType,
      capabilities,
      expiresAt: creds.oauth ? new Date(creds.oauth.expiry) : undefined,
    }
  })
}

// ---------------------------------------------------------------------------
// zele.sh sessions and inbox accounts
// ---------------------------------------------------------------------------

export function getZeleShSession(apiUrl: string) {
  return getDb().query.zeleShSession.findFirst({ where: { apiUrl } }).sync() ?? null
}

export async function saveZeleShSession({ apiUrl, ownerEmail, token }: { apiUrl: string; ownerEmail: string; token: string }) {
  return errore.tryAsync({
    try: async () => {
      getDb()
        .insert(schema.zeleShSession)
        .values({ apiUrl, ownerEmail, token, createdAt: new Date() })
        .onConflictDoUpdate({ target: schema.zeleShSession.apiUrl, set: { ownerEmail, token, createdAt: new Date() } })
        .run()
    },
    catch: (err) => new Error(`Failed to save zele.sh session for ${ownerEmail}`, { cause: err }),
  })
}

/** Adds an @zele.sh inbox as a zele account. Idempotent. */
export async function saveZeleShAccount({ address, apiUrl }: { address: string; apiUrl: string }) {
  const now = new Date()
  const tokens: ZeleShAccountTokens = { apiUrl }
  return errore.tryAsync({
    try: async () => {
      getDb()
        .insert(schema.account)
        .values({
          email: address,
          appId: ZELE_SH_APP_ID,
          accountType: 'zele_sh',
          capabilities: 'receive',
          accountStatus: 'active',
          tokens: JSON.stringify(tokens),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.account.email, schema.account.appId],
          set: { tokens: JSON.stringify(tokens), updatedAt: now },
        })
        .run()
    },
    catch: (err) => new Error(`Failed to save account ${address}`, { cause: err }),
  })
}

/** zele.sh inbox accounts stored on this machine for one server URL. */
export function listZeleShAccounts(apiUrl: string): string[] {
  const rows = getDb().query.account.findMany({ where: { accountType: 'zele_sh', appId: ZELE_SH_APP_ID } }).sync()
  return rows.filter((r) => (JSON.parse(r.tokens) as ZeleShAccountTokens).apiUrl === apiUrl).map((r) => r.email)
}

export async function removeZeleShAccount(address: string) {
  return errore.tryAsync({
    try: async () => {
      getDb()
        .delete(schema.account)
        .where(orm.and(orm.eq(schema.account.email, address), orm.eq(schema.account.appId, ZELE_SH_APP_ID)))
        .run()
    },
    catch: (err) => new Error(`Failed to remove account ${address}`, { cause: err }),
  })
}

/** Removes the owner session and every local inbox account of that server. Server data stays. */
export async function removeZeleShSession(apiUrl: string) {
  for (const address of listZeleShAccounts(apiUrl)) {
    const removed = await removeZeleShAccount(address)
    if (removed instanceof Error) return removed
  }
  return errore.tryAsync({
    try: async () => {
      getDb().delete(schema.zeleShSession).where(orm.eq(schema.zeleShSession.apiUrl, apiUrl)).run()
    },
    catch: (err) => new Error(`Failed to remove zele.sh session for ${apiUrl}`, { cause: err }),
  })
}

/** Authenticated API for a zele.sh session, or AuthError with a login hint. */
export function zeleShApiFor(apiUrl: string): ZeleShApi | ZeleShSignedOutError {
  const session = getZeleShSession(apiUrl)
  if (!session) return new ZeleShSignedOutError({ apiUrl })
  return new ZeleShApi(apiUrl, session.token)
}

async function loadZeleShApi(account: AccountId): Promise<ZeleShApi | AuthError | ZeleShSignedOutError> {
  const row = getDb().query.account.findFirst({ where: { email: account.email, appId: account.appId } }).sync()
  if (!row) return new AuthError({ email: account.email, reason: 'No account found. Run: zele login zele' })
  const { apiUrl }: ZeleShAccountTokens = JSON.parse(row.tokens)
  return zeleShApiFor(apiUrl)
}
