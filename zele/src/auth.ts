// Authentication module for zele.
// Multi-account support: tokens are stored in the Drizzle-managed SQLite DB
// (accounts table) keyed by (email, app_id). Supports Google browser OAuth,
// Microsoft Outlook XOAUTH2, IMAP/SMTP passwords, per-account token refresh,
// and helpers to get authenticated GmailClient / ImapSmtpClient instances.
// app_id is the OAuth client ID used during login (Google) or `imap_smtp`.

import { OAuth2Client } from 'googleapis-common'
import { CodeChallengeMethod } from 'google-auth-library'

type GoogleTokens = {
  access_token?: string | null
  refresh_token?: string | null
  expiry_date?: number | null
  token_type?: string | null
  id_token?: string | null
  scope?: string
}
import { colors as pc } from 'goke'
import * as orm from 'drizzle-orm'
import { getDb, schema } from './db.js'
import { GmailClient } from './gmail-client.js'
import { CalendarClient } from './calendar-client.js'
import * as errore from 'errore'
import {
  AccountRequiredError,
  AuthError,
  GoogleTokenError,
  isNotFoundError,
  mapConcurrent,
  NotFoundError,
  ThreadInManyAccountsError,
  UnsupportedError,
  ZeleShSignedOutError,
} from './api-utils.js'
import { isGmailId } from './gmail-link.js'
import { ImapSmtpClient, imapTlsOptions, tlsSocketOptions } from './imap-smtp-client.js'
import { DEFAULT_ZELE_API_URL, ZeleShApi, ZeleShClient, resolveZeleApiUrl } from './zele-sh-client.js'
import {
  createPkce,
  exchangeZeleShGoogleCode,
  printStderr,
  refreshZeleShGoogleToken,
  waitForOAuthCode,
  waitForZeleShOAuthCode,
  type BrowserAuthOptions,
} from './oauth-callback-server.js'
import {
  buildMicrosoftAuthUrl,
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
// Google OAuth clients
//
// Every login sends PKCE S256 and a random state.
//
// - redirect 'loopback': third-party Desktop clients. Google redirects to 127.0.0.1
//   on any port (waitForOAuthCode). Their secrets are embedded, like Thunderbird does:
//   Google does not treat Desktop client secrets as confidential.
//   https://developers.google.com/identity/protocols/oauth2/native-app
// - redirect 'zele.sh': zele's Web client. zele.sh is the OAuth web client: it holds
//   the client secret and the scopes (website/src/oauth-handoff.ts). The CLI polls it
//   for the code and exchanges and refreshes tokens through it. Works across machines.
//   The secret must never be in this package.
//
// Pick one with ZELE_GOOGLE_CLIENT=<name>. Default is thunderbird until Google
// approves the zele client's restricted scopes (docs/google-oauth-verification.md).
// ---------------------------------------------------------------------------

type GoogleOAuthClient =
  | { redirect: 'loopback'; clientId: string; clientSecret: string; scopes: string[] }
  | { redirect: 'zele.sh'; clientId: string }

/** Scopes the third-party clients can grant. They cannot grant gmail.settings.basic. */
const THIRD_PARTY_CLIENT_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
]

const OAUTH_CLIENTS: Record<string, GoogleOAuthClient> = {
  // Mozilla Thunderbird — largest user base, highest Google quota.
  // Source: searchfox.org/comm-central/source/mailnews/base/src/OAuth2Providers.sys.mjs
  thunderbird: {
    redirect: 'loopback',
    clientId: '406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com',
    clientSecret: 'kSmqreRr0qwBWJgbf5Y-PjSU',
    scopes: THIRD_PARTY_CLIENT_SCOPES,
  },
  // GNOME Online Accounts — used by Evolution, GNOME Calendar, Nautilus (Drive).
  // Source: github.com/GNOME/gnome-online-accounts/blob/master/meson_options.txt
  gnome: {
    redirect: 'loopback',
    clientId: '44438659992-7kgjeitenc16ssihbtdjbgguch7ju55s.apps.googleusercontent.com',
    clientSecret: '-gMLuQyDiI0XrQS_vx_mhuYF',
    scopes: THIRD_PARTY_CLIENT_SCOPES,
  },
  // KDE KAccounts — used by KMail, KOrganizer, Kontact.
  // Source: github.com/KDE/kaccounts-providers google.provider.in
  kde: {
    redirect: 'loopback',
    clientId: '317066460457-pkpkedrvt2ldq6g2hj1egfka2n7vpuoo.apps.googleusercontent.com',
    clientSecret: 'Y8eFAaWfcanV3amZdDvtbYUq',
    scopes: THIRD_PARTY_CLIENT_SCOPES,
  },
  // zele's own Web client "zele-web" in Google Cloud project zele-sh. Unverified for now.
  zele: {
    redirect: 'zele.sh',
    clientId: '701207960653-cfdhpbiuu7erfp04j5icc3921lvm2lcr.apps.googleusercontent.com',
  },
}

const DEFAULT_GOOGLE_CLIENT = 'thunderbird'

/** zele.sh token exchange and refresh give up after this. */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000

/** Client used for new logins: ZELE_GOOGLE_CLIENT, else thunderbird. */
function selectGoogleClient(): GoogleOAuthClient | Error {
  const name = process.env.ZELE_GOOGLE_CLIENT || DEFAULT_GOOGLE_CLIENT
  if (!Object.hasOwn(OAUTH_CLIENTS, name)) {
    return new Error(`Unknown ZELE_GOOGLE_CLIENT "${name}". Use one of: ${Object.keys(OAUTH_CLIENTS).join(', ')}`)
  }
  return OAUTH_CLIENTS[name]!
}

/** Codes and tokens of the zele client only go to these, never to another ZELE_API_URL. */
const GOOGLE_RELAY_URLS = [DEFAULT_ZELE_API_URL, 'https://preview.zele.sh']

/** ZELE_API_URL when it is zele.sh or its preview, else https://zele.sh. */
function googleRelayUrl(): string {
  const url = resolveZeleApiUrl()
  return GOOGLE_RELAY_URLS.includes(url) ? url : DEFAULT_ZELE_API_URL
}

/** Client a stored account logged in with. The account's appId is the client id. */
function googleClientForAppId(appId: string): GoogleOAuthClient | undefined {
  return Object.values(OAUTH_CLIENTS).find((c) => c.clientId === appId)
}

/**
 * OAuth2Client with stored tokens. zele.sh clients get no refresh_token on the client:
 * google-auth-library then calls refreshHandler on expiry instead of refreshing with
 * Google directly, which would need the client secret only zele.sh has.
 */
export function createGoogleAuth({ client, tokens, email, onRefresh, apiUrl = googleRelayUrl() }: {
  client: GoogleOAuthClient
  tokens: GoogleTokens
  email: string
  onRefresh?: (tokens: GoogleTokens) => void
  /** zele.sh relay for refresh. Defaults to googleRelayUrl(); tests pass a local relay. */
  apiUrl?: string
}): OAuth2Client {
  if (client.redirect === 'loopback') {
    const oauth2Client = new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret })
    oauth2Client.setCredentials(tokens)
    return oauth2Client
  }

  const oauth2Client = new OAuth2Client({ clientId: client.clientId })
  const { refresh_token: refreshToken, ...accessOnly } = tokens
  oauth2Client.setCredentials(accessOnly)

  // refreshHandler is a google-auth-library callback, so failures are thrown. gmailBoundary
  // passes the AuthError through. One refresh at a time: parallel Gmail calls share it.
  const refresh = async () => {
    const refreshed = refreshToken
      ? await refreshZeleShGoogleToken({ apiUrl, refreshToken, signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS) })
      : new GoogleTokenError({ oauthError: 'invalid_grant', description: 'no refresh token stored' })
    if (refreshed instanceof GoogleTokenError && refreshed.oauthError === 'invalid_grant') {
      throw new AuthError({ email, reason: 'Google sign-in expired or was revoked. Run: zele login', cause: refreshed })
    }
    if (refreshed instanceof Error) throw refreshed
    onRefresh?.({ ...tokens, ...refreshed })
    // setCredentials replaces all credentials, so keep scope for GmailClient's scope checks.
    return { access_token: refreshed.access_token, expiry_date: refreshed.expiry_date, scope: refreshed.scope ?? tokens.scope }
  }
  let inflight: ReturnType<typeof refresh> | null = null
  oauth2Client.refreshHandler = () => {
    inflight ??= refresh().finally(() => {
      inflight = null
    })
    return inflight
  }
  return oauth2Client
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
// Login: browser OAuth → save tokens to DB
// ---------------------------------------------------------------------------

/**
 * Run the full browser OAuth flow and save the account to the DB.
 * Replaces Google rows of the same email from other clients, so one email is one account.
 * Returns either a successful login payload or an Error value.
 */
export async function login(
  options?: BrowserAuthOptions,
): Promise<{ email: string; appId: string; client: GmailClient } | Error> {
  const googleClient = selectGoogleClient()
  if (googleClient instanceof Error) return googleClient
  const pkce = createPkce()

  const tokens = googleClient.redirect === 'zele.sh'
    ? await googleTokensViaZeleSh({ pkce, options })
    : await googleTokensViaLoopback({ client: googleClient, pkce, options })
  if (tokens instanceof Error) return tokens
  const oauth2Client = createGoogleAuth({ client: googleClient, tokens, email: 'unknown' })

  // Discover email
  const client = new GmailClient({ auth: oauth2Client })
  const profile = await client.getProfile()
  if (profile instanceof Error) return profile
  const email = profile.emailAddress

  // Upsert the account, then drop rows of this email from other Google clients:
  // getClient fails with "Multiple accounts matched" when one email has two rows.
  // Their caches go too (ON DELETE CASCADE). One immediate transaction, so two
  // concurrent logins of the same email cannot delete each other's row.
  const db = getDb()
  const googleCapabilities = 'gmail,calendar,smtp'
  const now = new Date()
  const upsertResult = errore.tryFn({
    try: () => db.transaction((tx) => {
      tx.insert(schema.account)
        .values({
          email,
          appId: googleClient.clientId,
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
      tx.delete(schema.account)
        .where(orm.and(
          orm.eq(schema.account.email, email),
          orm.eq(schema.account.accountType, 'google'),
          orm.ne(schema.account.appId, googleClient.clientId),
        ))
        .run()
    }, { behavior: 'immediate' }),
    catch: (err) => new Error(`Failed to save account ${email}`, { cause: err }),
  })
  if (upsertResult instanceof Error) return upsertResult

  return { email, appId: googleClient.clientId, client }
}

type Pkce = { verifier: string; challenge: string }

function printExchanging(options?: BrowserAuthOptions) {
  if (options?.showInstructions ?? true) printStderr(pc.dim('Got authorization code, exchanging for tokens...'))
}

/** zele client: zele.sh shows the consent link, relays the code, and adds the client secret to the exchange. */
async function googleTokensViaZeleSh({ pkce, options }: { pkce: Pkce; options?: BrowserAuthOptions }) {
  const apiUrl = googleRelayUrl()
  const grant = await waitForZeleShOAuthCode({
    apiUrl,
    challenge: pkce.challenge,
    loginCommand: 'zele login',
    openBrowser: options?.openBrowser,
    showInstructions: options?.showInstructions,
    onAuthorizationUrl: options?.onAuthorizationUrl,
  })
  if (grant instanceof Error) return grant
  printExchanging(options)
  return exchangeZeleShGoogleCode({
    apiUrl,
    code: grant.code,
    codeVerifier: pkce.verifier,
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  })
}

/** Third-party Desktop clients: loopback redirect, token exchange straight with Google. */
async function googleTokensViaLoopback({ client, pkce, options }: {
  client: Extract<GoogleOAuthClient, { redirect: 'loopback' }>
  pkce: Pkce
  options?: BrowserAuthOptions
}): Promise<GoogleTokens | Error> {
  const oauth2Client = new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret })
  const grant = await waitForOAuthCode({
    buildAuthUrl: ({ redirectUri, state }) =>
      oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: client.scopes,
        prompt: 'consent',
        redirect_uri: redirectUri,
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: CodeChallengeMethod.S256,
      }),
    loginCommand: 'zele login',
    provider: 'Google',
    openBrowser: options?.openBrowser,
    allowManualCodeEntry: options?.allowManualCodeEntry,
    showInstructions: options?.showInstructions,
    onAuthorizationUrl: options?.onAuthorizationUrl,
  })
  if (grant instanceof Error) return grant
  printExchanging(options)
  const res = await errore.tryAsync({
    try: () => oauth2Client.getToken({ code: grant.code, codeVerifier: pkce.verifier, redirect_uri: grant.redirectUri }),
    catch: (err) => new Error('Failed to exchange authorization code for tokens', { cause: err }),
  })
  if (res instanceof Error) return res
  return res.tokens
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
  const grant = await waitForOAuthCode({
    buildAuthUrl: ({ redirectUri, state }) =>
      buildMicrosoftAuthUrl({ challenge, redirectUri, state, loginHint: options?.email }),
    loginCommand: 'zele login microsoft',
    provider: 'Microsoft',
    openBrowser: options?.openBrowser,
    allowManualCodeEntry: options?.allowManualCodeEntry,
    showInstructions: options?.showInstructions,
    onAuthorizationUrl: options?.onAuthorizationUrl,
  })
  if (grant instanceof Error) return grant

  if (options?.showInstructions ?? true) {
    printStderr(pc.dim('Got authorization code, exchanging for tokens...'))
  }

  const oauth = await exchangeMicrosoftCode({ code: grant.code, verifier, redirectUri: grant.redirectUri })
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

  const googleClient = googleClientForAppId(account.appId)
  if (!googleClient) {
    // Saved by an older zele with ZELE_CLIENT_ID. Logging in again replaces the row; logout removes it.
    throw new AuthError({
      email: account.email,
      reason: `it was saved with a custom Google OAuth client (${account.appId}) that zele no longer supports. Run: zele login (replaces it) or zele logout ${account.email}`,
    })
  }
  const tokens: GoogleTokens = JSON.parse(row.tokens)
  const saveTokens = (next: GoogleTokens) => {
    db.update(schema.account)
      .set({ tokens: JSON.stringify(next), updatedAt: new Date() })
      .where(orm.and(orm.eq(schema.account.email, account.email), orm.eq(schema.account.appId, account.appId)))
      .run()
  }
  // zele.sh clients refresh lazily through refreshHandler, which saves the new token.
  if (googleClient.redirect === 'zele.sh') {
    return createGoogleAuth({ client: googleClient, tokens, email: account.email, onRefresh: saveTokens })
  }
  const oauth2Client = createGoogleAuth({ client: googleClient, tokens, email: account.email })

  // Refresh if expired — merge to preserve refresh_token which Google
  // often omits from refresh responses
  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    printStderr(pc.dim(`Token expired for ${account.email}, refreshing...`))
    const refreshed = await errore.tryAsync(() => oauth2Client.refreshAccessToken())
    // Keep the expired tokens: this account's API calls then fail with a typed
    // AuthError, instead of one bad account crashing commands for every account.
    if (refreshed instanceof Error) {
      printStderr(pc.dim(`Token refresh failed for ${account.email}: ${refreshed.message}`))
      return oauth2Client
    }
    const { credentials } = refreshed
    const merged = { ...tokens, ...credentials }
    oauth2Client.setCredentials(merged)
    saveTokens(merged)
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
 * Find the account that holds each thread, in the order given. With --account
 * or a single account, every thread goes to that account. Otherwise Gmail IDs
 * are looked up in each Google account. See pickThreadClient.
 */
export async function getClientsForThreads(
  accounts: string[] | undefined,
  threadIds: string[],
): Promise<Array<ClientEntry | Error>> {
  const clients = await getClients(accounts)
  // Wrapped so one failed lookup doesn't stop mapConcurrent: mail read reports each thread on its own.
  const picked = await mapConcurrent(threadIds, async (threadId) => ({
    entry: await pickThreadClient(clients, threadId),
  }))
  return picked.map(({ entry }) => entry)
}

/**
 * Pick the client whose mailbox has the thread. Only Gmail IDs can identify an
 * account: IMAP "FOLDER:UID" IDs repeat between mailboxes, so a lookup could
 * trash or reply to another account's message.
 */
export async function pickThreadClient<
  T extends {
    email: string
    accountType: AccountType
    client: { getThread(opts: { threadId: string; skipCache?: boolean; headersOnly?: boolean }): Promise<unknown> }
  },
>(clients: T[], threadId: string): Promise<T | Error> {
  if (clients.length === 1) return clients[0]!

  const google = isGmailId(threadId) ? clients.filter((c) => c.accountType === 'google') : []
  if (google.length === 0) {
    return new AccountRequiredError({ accounts: clients.map((c) => c.email).join(', ') })
  }
  if (google.length === 1) return google[0]!

  // skipCache: a cached copy does not prove the thread still exists in that mailbox.
  const results = await Promise.all(
    google.map((entry) => entry.client.getThread({ threadId, skipCache: true, headersOnly: true })),
  )
  const found = google.filter((_, i) => !(results[i] instanceof Error))
  if (found.length === 1) return found[0]!
  if (found.length > 1) {
    return new ThreadInManyAccountsError({ threadId, accounts: found.map((c) => c.email).join(', ') })
  }
  // A failure other than a 404 may be hiding the thread, so report it instead of "not found".
  const failure = results.find((r): r is Error => r instanceof Error && !isNotFoundError(r))
  if (failure) return failure
  return new NotFoundError({ resource: `thread ${threadId} (searched ${google.map((c) => c.email).join(', ')})` })
}

/** Find the account that holds one thread. See getClientsForThreads. */
export async function getClientForThread(
  accounts: string[] | undefined,
  threadId: string,
): Promise<ClientEntry | Error> {
  const [entry] = await getClientsForThreads(accounts, [threadId])
  return entry!
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
