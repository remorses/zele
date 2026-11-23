// Browser OAuth for Google and Microsoft login. Two ways to receive the code:
//
// - waitForOAuthCode (RFC 8252 loopback): listens on 127.0.0.1 on a random port and
//   waits for ?code=&state= there or in a pasted redirect URL. Third-party Google
//   clients and Microsoft.
// - waitForZeleShOAuthCode (zele's Web client): zele.sh is the OAuth web client. Google
//   redirects to zele.sh, which keeps the code for this state; the CLI polls for it, then
//   exchanges it through zele.sh (which adds the client secret) with its PKCE verifier.
//   Works when the browser runs on another machine.

import http from 'node:http'
import readline from 'node:readline'
import { createHash, randomBytes } from 'node:crypto'
import { colors as pc, openInBrowser } from 'goke'
import * as errore from 'errore'
import type { Credentials } from 'google-auth-library'
import { GoogleTokenError, abortableSleep } from './api-utils.js'

// Bun's console.error paints TTY output red, so login instructions looked like errors.
export function printStderr(line: string): void {
  process.stderr.write(line + '\n')
}

/** Browser logins give up after this. Also the timeout of the background login daemon. */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** How often the CLI asks zele.sh whether the browser login finished. */
const RELAY_POLL_INTERVAL_MS = 2_000

/** Consecutive failed polls (network errors or 5xx) before login gives up. */
const MAX_RELAY_POLL_FAILURES = 5

const HTTP_SERVER_ERROR = 500
const HTTP_TOO_MANY_REQUESTS = 429

/** The callback server only listens here, never on other interfaces. */
const LOOPBACK_HOST = '127.0.0.1'

/** Host and port in the redirect URI. Port 0 picks a random free port. */
export interface LoopbackRedirect {
  host: '127.0.0.1' | 'localhost'
  port: number
}

/** RFC 8252 default. Google Desktop clients and Microsoft's Thunderbird client accept any port here. */
export const RANDOM_LOOPBACK_REDIRECT: LoopbackRedirect = { host: LOOPBACK_HOST, port: 0 }

export interface BrowserAuthOptions {
  openBrowser?: boolean
  allowManualCodeEntry?: boolean
  showInstructions?: boolean
  /** Gets the URL to open, and for the zele.sh flow the confirm code the browser shows. */
  onAuthorizationUrl?: (url: string, confirmCode?: string) => void
}

/** A failing browser opener must not abort login: the URL is already printed or published. */
async function openBrowserOrHint({ url, showInstructions }: { url: string; showInstructions: boolean }) {
  const opened = await errore.tryAsync({
    try: () => openInBrowser(url),
    catch: (err) => new Error('Could not open a browser', { cause: err }),
  })
  if (opened instanceof Error && showInstructions) printStderr(pc.yellow('Could not open a browser. Open the URL above.'))
}

/** PKCE S256 pair (RFC 7636). The verifier never leaves this process. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Authorization code from a pasted redirect URL. Rejects URLs from another login (state mismatch). */
export function codeFromRedirectUrl({ input, state }: { input: string; state: string }): string | Error {
  const url = errore.tryFn(() => new URL(input.trim()))
  if (url instanceof Error) return new Error('Paste the full redirect URL from the browser address bar.')
  if (url.searchParams.get('state') !== state) return new Error('This URL is from another login attempt (state does not match).')
  const error = url.searchParams.get('error')
  if (error) return new Error(`Authorization failed: ${url.searchParams.get('error_description') ?? error}`)
  const code = url.searchParams.get('code')
  if (!code) return new Error('This URL has no authorization code.')
  return code
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

export async function waitForOAuthCode(opts: {
  /** Builds the authorize URL. Must send `state` and redirect to `redirectUri`. */
  buildAuthUrl: (params: { redirectUri: string; state: string }) => string
  /** Defaults to RANDOM_LOOPBACK_REDIRECT. A fixed port is for clients with one registered redirect URI. */
  redirect?: LoopbackRedirect
  loginCommand: string
  provider: string
  openBrowser?: boolean
  allowManualCodeEntry?: boolean
  showInstructions?: boolean
  onAuthorizationUrl?: (url: string) => void
}): Promise<{ code: string; redirectUri: string } | Error> {
  const allowManualCodeEntry = opts.allowManualCodeEntry ?? true
  const showInstructions = opts.showInstructions ?? true
  const redirect = opts.redirect ?? RANDOM_LOOPBACK_REDIRECT
  const state = randomBytes(32).toString('base64url')

  // Browsers try 127.0.0.1 when localhost on ::1 refuses, so a localhost redirect still reaches this server.
  const server = http.createServer()
  const listenError = await new Promise<Error | null>((resolve) => {
    server.once('error', (err) => resolve(new Error(`Failed to start local auth callback server on ${LOOPBACK_HOST}:${redirect.port}`, { cause: err })))
    server.listen(redirect.port, LOOPBACK_HOST, () => resolve(null))
  })
  if (listenError) return listenError
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    return new Error('Local auth callback server has no TCP port')
  }
  const redirectUri = `http://${redirect.host}:${address.port}`
  // buildAuthUrl calls the provider SDK and onAuthorizationUrl publishes the URL; a throw must not leak the server.
  const authUrl = errore.tryFn({
    try: () => {
      const url = opts.buildAuthUrl({ redirectUri, state })
      opts.onAuthorizationUrl?.(url)
      return url
    },
    catch: (err) => new Error(`Failed to start ${opts.provider} login`, { cause: err }),
  })
  if (authUrl instanceof Error) {
    server.close()
    return authUrl
  }

  if (showInstructions) {
    printStderr('\n' + pc.bold('1.') + ' Open this URL to authorize:\n')
    printStderr('   ' + pc.cyan(pc.underline(authUrl)) + '\n')
    printStderr(pc.bold('2.') + ' If running locally, the browser will redirect automatically.')
    printStderr(pc.dim('   If running remotely, the redirect page won\'t load — that\'s fine.'))
    printStderr(pc.dim('   Just copy the URL from your browser\'s address bar and paste it below.') + '\n')
  }

  const result = new Promise<string | Error>((resolve) => {
    let resolved = false
    let rl: readline.Interface | null = null
    const timer = setTimeout(
      () => done(new Error(`Login was not finished within ${LOGIN_TIMEOUT_MS / 60_000} minutes. Run: ${opts.loginCommand}`)),
      LOGIN_TIMEOUT_MS,
    )

    function done(value: string | Error) {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      server.close()
      server.closeAllConnections()
      if (rl) {
        rl.close()
        process.stdin.unref()
      }
      resolve(value)
    }

    server.on('error', (err) => done(new Error('Local auth callback server failed', { cause: err })))
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (!code && !error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(
          authCallbackHtml({
            title: 'No authorization code received',
            message: 'This page was opened without the OAuth "code" parameter.',
            status: 'neutral',
            sectionTitle: 'What to do',
            commands: [
              { comment: 'Restart login and try again', command: opts.loginCommand },
              {
                comment: 'If the browser can’t reach this computer, that’s fine',
                command: '# Copy the redirect URL from the address bar and paste it into the terminal',
              },
            ],
          }),
        )
        return
      }

      // A redirect from another login attempt or another site: ignore it and keep waiting.
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(
          authCallbackHtml({
            title: 'Login request does not match',
            message: 'This redirect belongs to another login attempt. Use the URL printed by the running login.',
            status: 'error',
            sectionTitle: 'Try again',
            commands: [{ comment: 'Start login again', command: opts.loginCommand }],
          }),
        )
        return
      }

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(
          authCallbackHtml({
            title: 'Authorization failed',
            message: `${opts.provider} returned: ${error}`,
            status: 'error',
            sectionTitle: 'Try again',
            commands: [{ comment: 'Start login again', command: opts.loginCommand }],
          }),
        )
        done(new Error(`${opts.provider} login failed: ${url.searchParams.get('error_description') ?? error}. Run: ${opts.loginCommand}`))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        authCallbackHtml({
          title: 'Login complete',
          message: 'You can close this tab and go back to the terminal.',
          status: 'success',
          sectionTitle: 'Next steps',
          commands: [
            { comment: 'Plan: open the TUI to read your emails', command: 'zele' },
            { comment: 'Plan: list your latest threads', command: 'zele mail list' },
            { comment: 'Plan: search mail', command: 'zele mail search "from:github"' },
          ],
        }),
      )
      done(code!)
    })

    if (allowManualCodeEntry && process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      // In raw mode readline eats Ctrl-C, so the process would keep waiting. Cancel the login instead.
      rl.on('SIGINT', () => done(new Error(`Login cancelled. Run: ${opts.loginCommand}`)))
      const ask = () => {
        rl?.question(pc.dim('Paste redirect URL here (or wait for auto-redirect): '), (answer) => {
          const pasted = codeFromRedirectUrl({ input: answer, state })
          if (pasted instanceof Error) {
            printStderr(pc.yellow(pasted.message))
            if (!resolved) ask()
            return
          }
          done(pasted)
        })
      }
      ask()
    }
  })

  if (opts.openBrowser ?? true) await openBrowserOrHint({ url: authUrl, showInstructions })

  const code = await result
  if (code instanceof Error) return code
  return { code, redirectUri }
}

type RelayPollResponse =
  | { status: 'pending' }
  | { status: 'code'; code: string }
  | { status: 'error'; error: string; errorDescription: string | null }

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Short code the terminal and the zele.sh start page both show, so the user can tell
 * a login link they started from one someone sent them. First 6 base32 chars of
 * sha256(state) as "ABC-DEF". Same as confirmCodeForState in website/src/oauth-handoff.ts.
 */
export function confirmCodeForState(state: string): string {
  const b = createHash('sha256').update(state).digest()
  const top40Bits = b[0]! * 2 ** 32 + b[1]! * 2 ** 24 + b[2]! * 2 ** 16 + b[3]! * 2 ** 8 + b[4]!
  const chars = Array.from({ length: 6 }, (_, i) => BASE32[Math.floor(top40Bits / 2 ** (35 - 5 * i)) % 32]).join('')
  return `${chars.slice(0, 3)}-${chars.slice(3)}`
}

/**
 * Google login through zele.sh, the OAuth web client. The browser opens
 * `<apiUrl>/oauth/google/start` (confirm page, then Google); Google redirects to zele.sh,
 * and this polls `<apiUrl>/api/v1/oauth/google/poll` until it returns the code (once) or
 * Google's error. Exchange the code with exchangeZeleShGoogleCode. No local server, no paste.
 */
export async function waitForZeleShOAuthCode(opts: {
  /** https://zele.sh, or https://preview.zele.sh via ZELE_API_URL. */
  apiUrl: string
  /** PKCE S256 challenge. The verifier stays with the caller. */
  challenge: string
  loginCommand: string
  openBrowser?: boolean
  showInstructions?: boolean
  onAuthorizationUrl?: (url: string, confirmCode?: string) => void
  pollIntervalMs?: number
}): Promise<{ code: string } | Error> {
  const state = randomBytes(32).toString('base64url')
  const confirmCode = confirmCodeForState(state)
  const startUrl = `${opts.apiUrl}/oauth/google/start?${new URLSearchParams({ state, code_challenge: opts.challenge })}`
  const published = errore.tryFn({
    try: () => opts.onAuthorizationUrl?.(startUrl, confirmCode),
    catch: (err) => new Error('Failed to start Google login', { cause: err }),
  })
  if (published instanceof Error) return published

  if (opts.showInstructions ?? true) {
    printStderr('\n' + pc.bold('Open this URL to sign in:') + '\n')
    printStderr('   ' + pc.cyan(pc.underline(startUrl)) + '\n')
    printStderr(`Check that the browser shows code ${pc.bold(confirmCode)} before you continue to Google.`)
    printStderr(pc.dim('Any browser works, also on another computer or phone. Waiting for approval... (Ctrl-C cancels)') + '\n')
  }

  const cancel = new AbortController()
  const onSigint = () => cancel.abort()
  process.once('SIGINT', onSigint)
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS)])

  if (opts.openBrowser ?? true) await openBrowserOrHint({ url: startUrl, showInstructions: opts.showInstructions ?? true })
  const code = await pollZeleShRelay({
    apiUrl: opts.apiUrl,
    state,
    loginCommand: opts.loginCommand,
    intervalMs: opts.pollIntervalMs ?? RELAY_POLL_INTERVAL_MS,
    signal,
  })
  process.off('SIGINT', onSigint)

  if (code instanceof Error) return code
  if (code === null && cancel.signal.aborted) return new Error(`Login cancelled. Run: ${opts.loginCommand}`)
  if (code === null) return new Error(`Login was not finished within ${LOGIN_TIMEOUT_MS / 60_000} minutes. Run: ${opts.loginCommand}`)
  return { code }
}

/** Returns the code, an Error, or null when the signal aborted (cancel or timeout). */
async function pollZeleShRelay({ apiUrl, state, loginCommand, intervalMs, signal }: {
  apiUrl: string
  state: string
  loginCommand: string
  intervalMs: number
  signal: AbortSignal
}): Promise<string | Error | null> {
  let failures = 0
  while (!signal.aborted) {
    const res = await errore.tryAsync({
      try: () => fetch(`${apiUrl}/api/v1/oauth/google/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state }),
        signal,
      }),
      catch: (err) => new Error(`Could not reach ${apiUrl} to finish login`, { cause: err }),
    })
    if (signal.aborted) return null

    // Network blips, rate limits and 5xx are retried; a persistent outage fails after a few polls.
    if (res instanceof Error || res.status >= HTTP_SERVER_ERROR || res.status === HTTP_TOO_MANY_REQUESTS) {
      failures += 1
      if (failures >= MAX_RELAY_POLL_FAILURES) {
        const reason = res instanceof Error ? res.message : `${apiUrl} returned HTTP ${res.status}`
        return new Error(`${reason}. Run: ${loginCommand}`, { cause: res instanceof Error ? res : undefined })
      }
      await abortableSleep(intervalMs, signal)
      continue
    }
    failures = 0

    const body = await errore.tryAsync({
      try: async () => (await res.json()) as RelayPollResponse & { message?: string },
      catch: (err) => new Error(`Invalid login relay response from ${apiUrl}`, { cause: err }),
    })
    if (signal.aborted) return null
    if (body instanceof Error) return body
    if (!res.ok) return new Error(`${body.message ?? `HTTP ${res.status}`}. Run: ${loginCommand}`)

    if (body.status === 'code') return body.code
    if (body.status === 'error' && body.error === 'access_denied') {
      return new Error(`Google login was denied in the browser (access_denied). Run: ${loginCommand}`)
    }
    if (body.status === 'error') return new Error(`Google login failed: ${body.errorDescription ?? body.error}. Run: ${loginCommand}`)
    await abortableSleep(intervalMs, signal)
  }
  return null
}

type GoogleTokenBody = {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  token_type?: string
  id_token?: string
  error?: string
  error_description?: string
  message?: string
}

/** zele.sh adds the client secret and forwards to Google's token endpoint. Tokens are not stored there. */
async function zeleShGoogleToken({ apiUrl, path, body, signal }: {
  apiUrl: string
  path: string
  body: Record<string, string>
  signal: AbortSignal
}): Promise<(Credentials & { access_token: string; expiry_date: number }) | GoogleTokenError> {
  const res = await errore.tryAsync({
    try: () => fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
    catch: (err) => new GoogleTokenError({ oauthError: 'network_error', description: `could not reach ${apiUrl}`, cause: err }),
  })
  if (res instanceof Error) return res
  const data = await errore.tryAsync({
    try: async () => (await res.json()) as GoogleTokenBody,
    catch: (err) => new GoogleTokenError({ oauthError: 'invalid_response', description: `${apiUrl} returned HTTP ${res.status}`, cause: err }),
  })
  if (data instanceof Error) return data
  if (!res.ok || !data.access_token || !data.expires_in) {
    return new GoogleTokenError({
      oauthError: data.error ?? `http_${res.status}`,
      description: data.error_description ?? data.message ?? `HTTP ${res.status}`,
    })
  }
  // Omit absent fields: a refresh response has no refresh_token, and merging an
  // undefined one over the stored tokens would drop it.
  return {
    access_token: data.access_token,
    expiry_date: Date.now() + data.expires_in * 1000,
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    ...(data.scope ? { scope: data.scope } : {}),
    ...(data.token_type ? { token_type: data.token_type } : {}),
    ...(data.id_token ? { id_token: data.id_token } : {}),
  }
}

export function exchangeZeleShGoogleCode({ apiUrl, code, codeVerifier, signal }: {
  apiUrl: string
  code: string
  codeVerifier: string
  signal: AbortSignal
}) {
  return zeleShGoogleToken({ apiUrl, path: '/api/v1/oauth/google/token', body: { code, codeVerifier }, signal })
}

export function refreshZeleShGoogleToken({ apiUrl, refreshToken, signal }: {
  apiUrl: string
  refreshToken: string
  signal: AbortSignal
}) {
  return zeleShGoogleToken({ apiUrl, path: '/api/v1/oauth/google/refresh', body: { refreshToken }, signal })
}
