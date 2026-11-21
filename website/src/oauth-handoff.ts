// Google login relay for the zele CLI's own Web OAuth client.
//
//   zele CLI ──open auth URL (state, PKCE challenge)──► Google consent
//   Google ──302 /oauth/google/callback?code&state──► this Worker ──► OAuthHandoff DO (one per state)
//   zele CLI ──POST /api/v1/oauth/google/poll {state} every 2s──► code or error, returned once
//
// zele.sh only holds the one-time code for a few minutes. It cannot use it: the
// token exchange needs the PKCE verifier, which never leaves the user's computer.

import { DurableObject, env } from 'cloudflare:workers'
import { Spiceflow, json } from 'spiceflow'
import { z } from 'zod'

/** Unpolled results delete themselves after this. Matches the CLI login timeout. */
const HANDOFF_TTL_MS = 10 * 60 * 1000

/** The CLI sends 32 random bytes as base64url (43 chars). */
const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, 'Invalid state')

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

async function getHandoff(state: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state))
  const name = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return env.OAUTH_HANDOFF.get(env.OAUTH_HANDOFF.idFromName(name))
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
function callbackPage({ title, message, status }: { title: string; message: string; status: number }) {
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
      h1 { font-size: 1.6rem; font-weight: 650; margin: 0 0 0.75rem; letter-spacing: -0.02em; }
      p { color: #444; margin: 0; }
      @media (prefers-color-scheme: dark) { body { background: #0f0f10; color: #eee; } p { color: #aaa; } }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  })
}

export const oauthHandoffApp = new Spiceflow()
  .route({
    method: 'GET',
    path: '/oauth/google/callback',
    async handler({ request }) {
      const params = request.parsedUrl.searchParams
      const state = stateSchema.safeParse(params.get('state'))
      if (!state.success) {
        return callbackPage({ title: 'Invalid login link', message: 'This page needs the link Google redirects to. Run zele login again.', status: 400 })
      }
      const code = params.get('code')
      const error = params.get('error')
      if (!code && !error) {
        return callbackPage({ title: 'No authorization code', message: 'Google sent no code. Run zele login again.', status: 400 })
      }
      const handoff = await getHandoff(state.data)
      if (code) {
        await handoff.complete({ code })
        return callbackPage({ title: 'Login complete', message: 'You can close this tab and go back to the terminal.', status: 200 })
      }
      await handoff.complete({ error: error!, errorDescription: params.get('error_description') })
      return callbackPage({ title: 'Login not completed', message: `Google returned: ${error}. Go back to the terminal.`, status: 400 })
    },
  })
  .route({
    method: 'POST',
    path: '/api/v1/oauth/google/poll',
    request: z.object({ state: z.string() }),
    async handler({ request }) {
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
