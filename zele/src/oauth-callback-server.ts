// Browser OAuth for Google and Microsoft login (RFC 8252 loopback redirect).
// Listens on 127.0.0.1 on a random port, prints and opens the authorize URL, and
// waits for ?code=&state= on the loopback server or a pasted redirect URL.

import http from 'node:http'
import readline from 'node:readline'
import { createHash, randomBytes } from 'node:crypto'
import { colors as pc, openInBrowser } from 'goke'
import * as errore from 'errore'

/** Browser logins give up after this. Also the timeout of the background login daemon. */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** Google and Microsoft desktop clients accept any port on this loopback address. */
const LOOPBACK_HOST = '127.0.0.1'

export interface BrowserAuthOptions {
  openBrowser?: boolean
  allowManualCodeEntry?: boolean
  showInstructions?: boolean
  onAuthorizationUrl?: (url: string) => void
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
  loginCommand: string
  provider: string
  openBrowser?: boolean
  allowManualCodeEntry?: boolean
  showInstructions?: boolean
  onAuthorizationUrl?: (url: string) => void
}): Promise<{ code: string; redirectUri: string } | Error> {
  const allowManualCodeEntry = opts.allowManualCodeEntry ?? true
  const showInstructions = opts.showInstructions ?? true
  const state = randomBytes(32).toString('base64url')

  const server = http.createServer()
  const listenError = await new Promise<Error | null>((resolve) => {
    server.once('error', (err) => resolve(new Error(`Failed to start local auth callback server on ${LOOPBACK_HOST}`, { cause: err })))
    server.listen(0, LOOPBACK_HOST, () => resolve(null))
  })
  if (listenError) return listenError
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    return new Error('Local auth callback server has no TCP port')
  }
  const redirectUri = `http://${LOOPBACK_HOST}:${address.port}`
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
    console.error('\n' + pc.bold('1.') + ' Open this URL to authorize:\n')
    console.error('   ' + pc.cyan(pc.underline(authUrl)) + '\n')
    console.error(pc.bold('2.') + ' If running locally, the browser will redirect automatically.')
    console.error(pc.dim('   If running remotely, the redirect page won\'t load — that\'s fine.'))
    console.error(pc.dim('   Just copy the URL from your browser\'s address bar and paste it below.') + '\n')
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
            console.error(pc.yellow(pasted.message))
            if (!resolved) ask()
            return
          }
          done(pasted)
        })
      }
      ask()
    }
  })

  if (opts.openBrowser ?? true) await openInBrowser(authUrl)

  const code = await result
  if (code instanceof Error) return code
  return { code, redirectUri }
}
