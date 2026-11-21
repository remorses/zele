import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import * as errore from 'errore'
import { GoogleTokenError } from './api-utils.js'
import {
  codeFromRedirectUrl,
  confirmCodeForState,
  createPkce,
  exchangeZeleShGoogleCode,
  refreshZeleShGoogleToken,
  waitForOAuthCode,
  waitForZeleShOAuthCode,
} from './oauth-callback-server.js'

const execFileAsync = promisify(execFile)
const cleanupPids: number[] = []
const cleanupDirs: string[] = []
const cleanupServers: http.Server[] = []

afterEach(() => {
  for (const pid of cleanupPids.splice(0)) {
    errore.tryFn(() => process.kill(pid, 'SIGTERM'))
  }
  for (const directory of cleanupDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
  for (const server of cleanupServers.splice(0)) server.close()
})

test('agent login prints the OAuth URL before returning', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zele-agent-login-'))
  cleanupDirs.push(home)

  const result = await execFileAsync('bun', ['src/cli.ts', 'login', '--method', 'microsoft'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOME: home, AI_AGENT: 'opencode' },
    timeout: 15_000,
  })

  expect(result.stderr).toContain('Open this URL to authorize:')
  expect(result.stderr).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?')
  expect(result.stderr).toContain('Login running in background.')

  const pidFile = path.join(home, '.config', 'goke', 'daemons', 'zele--login.pid.json')
  const daemon = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { pid: number }
  cleanupPids.push(daemon.pid)
  expect(errore.tryFn(() => process.kill(daemon.pid, 0))).toBe(true)
})

test('createPkce challenge is S256 of the verifier', () => {
  const { verifier, challenge } = createPkce()
  expect(verifier.length).toBeGreaterThanOrEqual(43)
  expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
})

test('loopback server ignores redirects with another state and returns the matching code', async () => {
  const listening = Promise.withResolvers<{ redirectUri: string; state: string }>()
  const pending = waitForOAuthCode({
    buildAuthUrl: (params) => {
      listening.resolve(params)
      return 'https://accounts.example/auth'
    },
    loginCommand: 'zele login',
    provider: 'Google',
    openBrowser: false,
    allowManualCodeEntry: false,
    showInstructions: false,
  })
  const params = await listening.promise
  expect(params.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

  const forged = await fetch(`${params.redirectUri}/?code=forged&state=wrong`)
  expect(forged.status).toBe(400)
  const real = await fetch(`${params.redirectUri}/?code=real-code&state=${params.state}`)
  expect(real.status).toBe(200)
  expect(await pending).toEqual({ code: 'real-code', redirectUri: params.redirectUri })
})

test('a throwing authorization URL callback returns an error and closes the server', async () => {
  let redirectUri = ''
  const result = await waitForOAuthCode({
    buildAuthUrl: (params) => {
      redirectUri = params.redirectUri
      return 'https://accounts.example/auth'
    },
    onAuthorizationUrl: () => {
      throw new Error('publish failed')
    },
    loginCommand: 'zele login',
    provider: 'Google',
    openBrowser: false,
    allowManualCodeEntry: false,
    showInstructions: false,
  })
  expect(result instanceof Error && result.message).toMatchInlineSnapshot(`"Failed to start Google login"`)
  expect(await fetch(redirectUri).then(() => 'open', () => 'closed')).toBe('closed')
})

describe('zele.sh Google login', () => {
  const ACCESS_TOKEN_LIFETIME_S = 3599

  /** Local stand-in for zele.sh: scripted poll answers, and token routes that check PKCE like Google. */
  async function startRelay({ polls, challenge = '' }: { polls: object[]; challenge?: string }) {
    const polledStates: string[] = []
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string>
      const reply = (status: number, data: object) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      if (req.url === '/api/v1/oauth/google/poll') {
        polledStates.push(body.state!)
        return reply(200, polls[Math.min(polledStates.length, polls.length) - 1]!)
      }
      if (req.url === '/api/v1/oauth/google/token') {
        const verified = createHash('sha256').update(body.codeVerifier!).digest('base64url') === challenge
        if (body.code !== 'relayed-code' || !verified) return reply(400, { error: 'invalid_grant', error_description: 'Bad Request' })
        return reply(200, { access_token: 'access-1', expires_in: ACCESS_TOKEN_LIFETIME_S, refresh_token: 'refresh-1', scope: 'gmail.modify', token_type: 'Bearer' })
      }
      if (req.url === '/api/v1/oauth/google/refresh') {
        if (body.refreshToken === 'revoked') return reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
        return reply(200, { access_token: 'access-2', expires_in: ACCESS_TOKEN_LIFETIME_S, token_type: 'Bearer' })
      }
      reply(404, { message: 'not found' })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    cleanupServers.push(server)
    return { apiUrl: `http://127.0.0.1:${port}`, polledStates }
  }

  const withoutExpiry = (value: object) => ('expiry_date' in value ? { ...value, expiry_date: typeof value.expiry_date } : value)

  test('start URL, poll until the code arrives, then exchange it with the verifier', async () => {
    const pkce = createPkce()
    const relay = await startRelay({ polls: [{ status: 'pending' }, { status: 'pending' }, { status: 'code', code: 'relayed-code' }], challenge: pkce.challenge })
    let startUrl = ''
    let shownCode = ''
    const grant = await waitForZeleShOAuthCode({
      apiUrl: relay.apiUrl,
      challenge: pkce.challenge,
      onAuthorizationUrl: (url, code) => {
        startUrl = url
        shownCode = code ?? ''
      },
      loginCommand: 'zele login',
      openBrowser: false,
      showInstructions: false,
      pollIntervalMs: 1,
    })
    expect(grant).toEqual({ code: 'relayed-code' })

    const start = new URL(startUrl)
    const state = start.searchParams.get('state')!
    expect(start.origin + start.pathname).toBe(`${relay.apiUrl}/oauth/google/start`)
    expect(start.searchParams.get('code_challenge')).toBe(pkce.challenge)
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(shownCode).toBe(confirmCodeForState(state))
    expect(relay.polledStates).toEqual([state, state, state])

    const signal = AbortSignal.timeout(5_000)
    const tokens = await exchangeZeleShGoogleCode({ apiUrl: relay.apiUrl, code: 'relayed-code', codeVerifier: pkce.verifier, signal })
    expect(tokens instanceof Error ? tokens : withoutExpiry(tokens)).toMatchInlineSnapshot(`
      {
        "access_token": "access-1",
        "expiry_date": "number",
        "refresh_token": "refresh-1",
        "scope": "gmail.modify",
        "token_type": "Bearer",
      }
    `)
    const wrongVerifier = await exchangeZeleShGoogleCode({ apiUrl: relay.apiUrl, code: 'relayed-code', codeVerifier: createPkce().verifier, signal })
    expect(wrongVerifier instanceof Error && wrongVerifier.message).toMatchInlineSnapshot(`"Google token request failed (invalid_grant): Bad Request"`)
  })

  test('returns a clear error when Google denied access', async () => {
    const relay = await startRelay({ polls: [{ status: 'pending' }, { status: 'error', error: 'access_denied', errorDescription: null }] })
    const result = await waitForZeleShOAuthCode({
      apiUrl: relay.apiUrl,
      challenge: createPkce().challenge,
      loginCommand: 'zele login',
      openBrowser: false,
      showInstructions: false,
      pollIntervalMs: 1,
    })
    expect(result instanceof Error && result.message).toMatchInlineSnapshot(`"Google login was denied in the browser (access_denied). Run: zele login"`)
  })

  test('refresh keeps no refresh_token key and reports invalid_grant', async () => {
    const relay = await startRelay({ polls: [] })
    const signal = AbortSignal.timeout(5_000)
    const refreshed = await refreshZeleShGoogleToken({ apiUrl: relay.apiUrl, refreshToken: 'refresh-1', signal })
    expect(refreshed instanceof Error ? refreshed : withoutExpiry(refreshed)).toMatchInlineSnapshot(`
      {
        "access_token": "access-2",
        "expiry_date": "number",
        "token_type": "Bearer",
      }
    `)
    const revoked = await refreshZeleShGoogleToken({ apiUrl: relay.apiUrl, refreshToken: 'revoked', signal })
    expect(revoked instanceof GoogleTokenError && revoked.oauthError).toBe('invalid_grant')
  })

  test('confirm code matches the website derivation', () => {
    // website/src/oauth-handoff.ts must print the same code for this state (checked on preview.zele.sh).
    expect(confirmCodeForState('a'.repeat(43))).toMatchInlineSnapshot(`"M3J-U7O"`)
  })
})

describe('codeFromRedirectUrl', () => {
  const state = 'state-123'
  const message = (value: string | Error) => (value instanceof Error ? value.message : value)

  test('reads the code when the state matches', () => {
    expect(codeFromRedirectUrl({ input: ' http://127.0.0.1:53682/?state=state-123&code=abc123 ', state })).toBe('abc123')
  })

  test('rejects bare codes, other logins, OAuth errors and missing codes', () => {
    expect(message(codeFromRedirectUrl({ input: 'abc123def456', state }))).toMatchInlineSnapshot(`"Paste the full redirect URL from the browser address bar."`)
    expect(message(codeFromRedirectUrl({ input: 'http://127.0.0.1:1/?state=other&code=abc', state }))).toMatchInlineSnapshot(`"This URL is from another login attempt (state does not match)."`)
    expect(message(codeFromRedirectUrl({ input: 'http://127.0.0.1:1/?state=state-123&error=access_denied', state }))).toMatchInlineSnapshot(`"Authorization failed: access_denied"`)
    expect(message(codeFromRedirectUrl({ input: 'http://127.0.0.1:1/?state=state-123', state }))).toMatchInlineSnapshot(`"This URL has no authorization code."`)
  })
})
