// Google OAuth web client for the zele CLI. zele.sh holds the client secret;
// the CLI holds the PKCE verifier. Neither side can redeem the authorization code alone.
//
//   zele CLI ──opens /oauth/google/start?state&code_challenge──► confirm page (code ABC-123)
//   browser ──"Continue to Google"──► Google consent
//   Google ──302 /oauth/google/callback?code&state──► OAuthHandoff DO (one per state, 10 min)
//   zele CLI ──POST /api/v1/oauth/google/poll {state}──► code or error, returned once
//   zele CLI ──POST /api/v1/oauth/google/token {code, codeVerifier}──► + client secret ──► Google
//   zele CLI ──POST /api/v1/oauth/google/refresh {refreshToken}─────► + client secret ──► Google
//
// Tokens pass through the token and refresh routes in transit. They are never
// stored or logged: no console calls here, and Google errors are reduced to
// error/error_description.

import { DurableObject, env } from 'cloudflare:workers'
import { Spiceflow, json } from 'spiceflow'
import { z } from 'zod'

/** Unpolled results delete themselves after this. Matches the CLI login timeout. */
const HANDOFF_TTL_MS = 10 * 60 * 1000
const GOOGLE_TOKEN_TIMEOUT_MS = 15_000
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_BAD_GATEWAY = 502

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** Web client "zele-web" in Google Cloud project zele-sh. The secret is the Worker secret ZELE_WEB_CLIENT_SECRET. */
const GOOGLE_CLIENT_ID = '701207960653-cfdhpbiuu7erfp04j5icc3921lvm2lcr.apps.googleusercontent.com'
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/calendar',
]

/** The CLI sends 32 random bytes as base64url (43 chars). */
const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, 'Invalid state')
/** base64url(sha256(verifier)), RFC 7636. */
const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid code challenge')
const verifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/, 'Invalid code verifier')

export type HandoffResult = { code: string } | { error: string; errorDescription: string | null }

export type PollResponse =
  | { status: 'pending' }
  | { status: 'code'; code: string }
  | { status: 'error'; error: string; errorDescription: string | null }

const RESULT_KEY = 'result'

/** One object per login, addressed by sha256(state) so the raw state never becomes an object name. */
export class OAuthHandoff extends DurableObject<Env> {
  async complete(result: HandoffResult): Promise<void> {
    this.ctx.storage.kv.put(RESULT_KEY, result)
    await this.ctx.storage.setAlarm(Date.now() + HANDOFF_TTL_MS)
  }

  /** Returns the result once. deleteAll also clears the alarm (compat date >= 2026-02-24). */
  async take(): Promise<HandoffResult | null> {
    const result = this.ctx.storage.kv.get<HandoffResult>(RESULT_KEY)
    if (result === undefined) return null
    await this.ctx.storage.deleteAll()
    return result
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

async function stateHash(state: string): Promise<string> {
  return [...(await sha256(state))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function getHandoff(state: string) {
  return env.OAUTH_HANDOFF.get(env.OAUTH_HANDOFF.idFromName(await stateHash(state)))
}

/**
 * Set by /start, required by the callback: a raw Google authorize URL sent by an
 * attacker skips the confirm page, so its callback has no cookie and is rejected.
 * SameSite=Lax cookies are sent on Google's top-level redirect back here.
 */
const LOGIN_COOKIE = '__Host-zele_oauth'
const LOGIN_COOKIE_MAX_AGE_S = 600

function loginCookie(value: string, maxAgeS: number): string {
  return `${LOGIN_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`
}

function readLoginCookie(request: Request): string | null {
  const cookies = request.headers.get('cookie')?.split(';') ?? []
  const match = cookies.map((c) => c.trim()).find((c) => c.startsWith(`${LOGIN_COOKIE}=`))
  return match ? match.slice(LOGIN_COOKIE.length + 1) : null
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** First 6 base32 chars of sha256(state) as "ABC-DEF". Same as confirmCodeForState in zele/src/oauth-callback-server.ts. */
async function confirmCodeForState(state: string): Promise<string> {
  const b = await sha256(state)
  const top40Bits = b[0]! * 2 ** 32 + b[1]! * 2 ** 24 + b[2]! * 2 ** 16 + b[3]! * 2 ** 8 + b[4]!
  const chars = Array.from({ length: 6 }, (_, i) => BASE32[Math.floor(top40Bits / 2 ** (35 - 5 * i)) % 32]).join('')
  return `${chars.slice(0, 3)}-${chars.slice(3)}`
}

async function rateLimit(limiter: RateLimit, request: Request): Promise<void> {
  const { success } = await limiter.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' })
  if (!success) throw json({ message: 'Too many requests. Wait a minute and retry.' }, { status: HTTP_TOO_MANY_REQUESTS })
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Never renders the code. The page loads nothing external, so the URL is not leaked via Referer. */
function page({ title, message, status, confirmCode, action, setCookie }: {
  title: string
  message: string
  status: number
  confirmCode?: string
  action?: { href: string; label: string }
  setCookie?: string
}) {
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100vh; margin: 0;
        display: flex; align-items: center; justify-content: center; padding: 1.25rem; box-sizing: border-box;
        background: #fff; color: #111; line-height: 1.6; text-align: center; }
      main { max-width: 32rem; }
      h1 { font-size: 1.6rem; font-weight: 650; margin: 0 0 0.75rem; letter-spacing: -0.02em; }
      p { color: #444; margin: 0; }
      .code { font-family: 'SF Mono', Consolas, Menlo, monospace; font-size: 2rem; font-weight: 600; letter-spacing: 0.12em;
        margin: 1.25rem 0; padding: 0.5rem 1rem; border: 1px solid #ddd; border-radius: 12px; display: inline-block; }
      .button { display: inline-block; margin-top: 1.5rem; padding: 0.7rem 1.4rem; border-radius: 10px; background: #111; color: #fff;
        text-decoration: none; font-weight: 600; }
      @media (prefers-color-scheme: dark) {
        body { background: #0f0f10; color: #eee; } p { color: #aaa; } .code { border-color: #333; }
        .button { background: #eee; color: #111; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${confirmCode ? `<div class="code">${escapeHtml(confirmCode)}</div>` : ''}
      ${action ? `<div><a class="button" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></div>` : ''}
    </main>
  </body>
</html>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      // The Continue link is a plain navigation, which CSP does not restrict.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      ...(setCookie ? { 'set-cookie': setCookie } : {}),
    },
  })
}

/** Sends a token request with the client secret. Success: Google's body as-is. Failure: only error and error_description. */
async function googleTokenRequest(params: Record<string, string>): Promise<Response> {
  const headers = { 'cache-control': 'no-store' }
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: env.ZELE_WEB_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
  }).catch(() => null)
  if (!res) return json({ error: 'server_error', error_description: 'Google token endpoint unreachable' }, { status: HTTP_BAD_GATEWAY, headers })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (res.ok && body) return json(body, { headers })
  return json(
    {
      error: typeof body?.error === 'string' ? body.error : 'server_error',
      error_description: typeof body?.error_description === 'string' ? body.error_description : `Google returned HTTP ${res.status}`,
    },
    { status: res.ok ? HTTP_BAD_GATEWAY : res.status, headers },
  )
}

export const oauthHandoffApp = new Spiceflow()
  .route({
    method: 'GET',
    path: '/oauth/google/start',
    async handler({ request }) {
      await rateLimit(env.OAUTH_PAGE_LIMITER, request)
      const params = request.parsedUrl.searchParams
      const state = stateSchema.safeParse(params.get('state'))
      const challenge = challengeSchema.safeParse(params.get('code_challenge'))
      if (!state.success || !challenge.success) {
        return page({ title: 'Invalid login link', message: 'Open the link printed by zele login.', status: 400 })
      }
      const authorize = new URL(GOOGLE_AUTHORIZE_URL)
      authorize.search = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: `${env.BETTER_AUTH_URL}/oauth/google/callback`,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state: state.data,
        code_challenge: challenge.data,
        code_challenge_method: 'S256',
      }).toString()
      return page({
        title: 'Sign in to zele with Google',
        message: 'Continue only if your terminal shows this same code. If you did not run zele login, close this page.',
        confirmCode: await confirmCodeForState(state.data),
        action: { href: authorize.toString(), label: 'Continue to Google' },
        status: 200,
        setCookie: loginCookie(await stateHash(state.data), LOGIN_COOKIE_MAX_AGE_S),
      })
    },
  })
  .route({
    method: 'GET',
    path: '/oauth/google/callback',
    async handler({ request }) {
      await rateLimit(env.OAUTH_PAGE_LIMITER, request)
      const params = request.parsedUrl.searchParams
      const state = stateSchema.safeParse(params.get('state'))
      if (!state.success) {
        return page({ title: 'Invalid login link', message: 'This page needs the link Google redirects to. Run zele login again.', status: 400 })
      }
      const code = params.get('code')
      const error = params.get('error')
      if (!code && !error) {
        return page({ title: 'No authorization code', message: 'Google sent no code. Run zele login again.', status: 400 })
      }
      if (readLoginCookie(request) !== (await stateHash(state.data))) {
        return page({
          title: 'Login not started here',
          message: 'This sign-in did not start from the zele.sh page with the confirm code. Open the link printed by zele login in this browser.',
          status: 403,
        })
      }
      const handoff = await getHandoff(state.data)
      const clearCookie = loginCookie('', 0)
      if (code) {
        await handoff.complete({ code })
        return page({ title: 'Login complete', message: 'You can close this tab and go back to the terminal.', status: 200, setCookie: clearCookie })
      }
      await handoff.complete({ error: error!, errorDescription: params.get('error_description') })
      return page({ title: 'Login not completed', message: `Google returned: ${error}. Go back to the terminal.`, status: 400, setCookie: clearCookie })
    },
  })
  .route({
    method: 'POST',
    path: '/api/v1/oauth/google/poll',
    request: z.object({ state: z.string() }),
    async handler({ request }) {
      await rateLimit(env.OAUTH_POLL_LIMITER, request)
      const state = stateSchema.safeParse((await request.json()).state)
      if (!state.success) throw json({ message: 'Invalid state. Run: zele login' }, { status: 400 })
      const result = await (await getHandoff(state.data)).take()
      const body: PollResponse = !result
        ? { status: 'pending' }
        : 'code' in result
          ? { status: 'code', code: result.code }
          : { status: 'error', error: result.error, errorDescription: result.errorDescription }
      return json(body, { headers: { 'cache-control': 'no-store' } })
    },
  })
  .route({
    method: 'POST',
    path: '/api/v1/oauth/google/token',
    request: z.object({ code: z.string().min(1).max(2048), codeVerifier: verifierSchema }),
    async handler({ request }) {
      await rateLimit(env.OAUTH_TOKEN_LIMITER, request)
      const { code, codeVerifier } = await request.json()
      return googleTokenRequest({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: `${env.BETTER_AUTH_URL}/oauth/google/callback`,
      })
    },
  })
  .route({
    method: 'POST',
    path: '/api/v1/oauth/google/refresh',
    request: z.object({ refreshToken: z.string().min(1).max(2048) }),
    async handler({ request }) {
      await rateLimit(env.OAUTH_TOKEN_LIMITER, request)
      const { refreshToken } = await request.json()
      return googleTokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
    },
  })
