import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import * as errore from 'errore'
import { codeFromRedirectUrl, createPkce, waitForOAuthCode } from './oauth-callback-server.js'

const execFileAsync = promisify(execFile)
const cleanupPids: number[] = []
const cleanupDirs: string[] = []

afterEach(() => {
  for (const pid of cleanupPids.splice(0)) {
    errore.tryFn(() => process.kill(pid, 'SIGTERM'))
  }
  for (const directory of cleanupDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
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
