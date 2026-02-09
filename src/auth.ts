// OAuth2 authentication module for gtui.
// Handles browser-based OAuth flow, token persistence in ~/.gtui/tokens.json,
// and automatic token refresh on expiry.
// Refactored from the original index.ts demo into a reusable module.

import http from 'node:http'
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { OAuth2Client } from 'google-auth-library'
import fkill from 'fkill'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GTUI_DIR = path.join(os.homedir(), '.gtui')
const TOKENS_FILE = path.join(GTUI_DIR, 'tokens.json')

const CLIENT_ID =
  process.env.GTUI_CLIENT_ID ??
  '406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com'

const CLIENT_SECRET =
  process.env.GTUI_CLIENT_SECRET ?? 'kSmqreRr0qwBWJgbf5Y-PjSU'

const REDIRECT_PORT = 8089
const SCOPES = [
  'https://mail.google.com/',                       // Gmail (full)
  'https://www.googleapis.com/auth/calendar',       // Calendar (full)
  'https://www.googleapis.com/auth/drive',          // Drive (full)
  'https://www.googleapis.com/auth/contacts',       // Contacts
  'https://www.googleapis.com/auth/tasks',          // Tasks
  'https://www.googleapis.com/auth/userinfo.email', // Email identity
]

// ---------------------------------------------------------------------------
// OAuth2 client
// ---------------------------------------------------------------------------

export function createOAuth2Client(): OAuth2Client {
  return new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: `http://localhost:${REDIRECT_PORT}`,
  })
}

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

function ensureDir() {
  if (!fs.existsSync(GTUI_DIR)) {
    fs.mkdirSync(GTUI_DIR, { recursive: true })
  }
}

export function loadTokens(): object | null {
  if (fs.existsSync(TOKENS_FILE)) {
    const data = fs.readFileSync(TOKENS_FILE, 'utf-8')
    return JSON.parse(data)
  }
  return null
}

export function saveTokens(tokens: object): void {
  ensureDir()
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2))
}

export function clearTokens(): void {
  if (fs.existsSync(TOKENS_FILE)) {
    fs.unlinkSync(TOKENS_FILE)
  }
}

// ---------------------------------------------------------------------------
// Browser OAuth flow
// ---------------------------------------------------------------------------

// Extract authorization code from a pasted redirect URL or raw code string.
// Accepts either the full redirect URL (http://localhost:8089/?code=XXX&scope=...)
// or just the raw authorization code.
function extractCodeFromInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Try parsing as a URL with ?code= parameter
  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    if (code) return code
  } catch {
    // Not a URL — fall through
  }

  // Accept raw code (typically starts with "4/" for Google OAuth)
  if (trimmed.length > 10 && !trimmed.includes(' ')) {
    return trimmed
  }

  return null
}

// Race two auth methods:
// 1. Localhost HTTP server (works when CLI runs on same machine as browser)
// 2. Manual paste (works when CLI runs on a remote/headless machine)
// Whichever completes first wins, the other is cleaned up.
async function getAuthCodeFromBrowser(oauth2Client: OAuth2Client): Promise<string> {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })

  // Kill any stale process on the redirect port before starting our server
  await fkill(`:${REDIRECT_PORT}`, { force: true, silent: true }).catch(() => {})

  process.stderr.write('\n1. Open this URL to authorize:\n\n')
  process.stderr.write('   ' + authUrl + '\n\n')
  process.stderr.write('2. If running locally, the browser will redirect automatically.\n')
  process.stderr.write('   If running remotely, the redirect page won\'t load — that\'s fine.\n')
  process.stderr.write('   Just copy the URL from your browser\'s address bar and paste it below.\n\n')

  return new Promise((resolve, reject) => {
    let resolved = false
    let server: http.Server | null = null
    let rl: readline.Interface | null = null

    function finish(code: string) {
      if (resolved) return
      resolved = true

      // Clean up both listeners
      server?.close()
      if (rl) {
        rl.close()
        // Unpipe stdin so the process can exit cleanly
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

    // --- Method 1: Localhost HTTP server ---
    server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`)
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

    server.listen(REDIRECT_PORT)

    // --- Method 2: Stdin paste ---
    if (process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      rl.question('Paste redirect URL here (or wait for auto-redirect): ', (answer) => {
        const code = extractCodeFromInput(answer)
        if (code) {
          finish(code)
        } else {
          process.stderr.write('Could not extract authorization code from input.\n')
          process.stderr.write('Waiting for browser redirect...\n')
        }
      })
    }
  })
}

// ---------------------------------------------------------------------------
// Main authenticate function
// ---------------------------------------------------------------------------

export async function authenticate(): Promise<OAuth2Client> {
  const oauth2Client = createOAuth2Client()

  const existingTokens = loadTokens()
  if (existingTokens) {
    oauth2Client.setCredentials(existingTokens)

    // Refresh if expired
    const tokenInfo = oauth2Client.credentials
    if (tokenInfo.expiry_date && tokenInfo.expiry_date < Date.now()) {
      process.stderr.write('Token expired, refreshing...\n')
      const { credentials } = await oauth2Client.refreshAccessToken()
      oauth2Client.setCredentials(credentials)
      saveTokens(credentials)
    }

    return oauth2Client
  }

  // No tokens — start OAuth flow
  const code = await getAuthCodeFromBrowser(oauth2Client)
  process.stderr.write('Got authorization code, exchanging for tokens...\n')

  const { tokens } = await oauth2Client.getToken(code)
  oauth2Client.setCredentials(tokens)
  saveTokens(tokens)

  return oauth2Client
}

// ---------------------------------------------------------------------------
// Auth status
// ---------------------------------------------------------------------------

export interface AuthStatus {
  authenticated: boolean
  email?: string
  expiresAt?: Date
  tokensFile: string
}

export function getAuthStatus(): AuthStatus {
  const tokens = loadTokens() as Record<string, unknown> | null
  if (!tokens) {
    return { authenticated: false, tokensFile: TOKENS_FILE }
  }

  const expiryDate = tokens.expiry_date as number | undefined
  return {
    authenticated: true,
    expiresAt: expiryDate ? new Date(expiryDate) : undefined,
    tokensFile: TOKENS_FILE,
  }
}
