// Microsoft OAuth helpers used for Outlook IMAP XOAUTH2.
// No network. Token parsing uses a hand-built JWT payload.

import { describe, expect, test } from 'vitest'
import {
  MICROSOFT_CLIENT_ID,
  MICROSOFT_SCOPES,
  buildMicrosoftAuthUrl,
  emailFromIdToken,
  resolveMicrosoftAccountEmail,
  tokensFromResponse,
} from './microsoft-oauth.js'

function b64url(json: object) {
  return Buffer.from(JSON.stringify(json)).toString('base64url')
}

describe('buildMicrosoftAuthUrl', () => {
  test('includes Thunderbird client, IMAP SMTP scopes, state and PKCE', () => {
    const url = new URL(
      buildMicrosoftAuthUrl({
        challenge: 'abc',
        redirectUri: 'http://127.0.0.1:53682',
        state: 'state-123',
        loginHint: 'atrox@outlook.it',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(url.searchParams.get('client_id')).toBe(MICROSOFT_CLIENT_ID)
    expect(url.searchParams.get('code_challenge')).toBe('abc')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53682')
    expect(url.searchParams.get('state')).toBe('state-123')
    expect(url.searchParams.get('login_hint')).toBe('atrox@outlook.it')
    const scope = url.searchParams.get('scope') ?? ''
    for (const item of MICROSOFT_SCOPES) {
      expect(scope).toContain(item)
    }
  })
})

describe('emailFromIdToken', () => {
  test('reads preferred_username', () => {
    const token = `e30.${b64url({ preferred_username: 'atrox@outlook.it' })}.sig`
    expect(emailFromIdToken(token)).toBe('atrox@outlook.it')
  })

  test('falls back to email then upn', () => {
    expect(emailFromIdToken(`e30.${b64url({ email: 'a@b.com' })}.sig`)).toBe('a@b.com')
    expect(emailFromIdToken(`e30.${b64url({ upn: 'c@d.com' })}.sig`)).toBe('c@d.com')
  })
})

describe('resolveMicrosoftAccountEmail', () => {
  test('prefers id_token over --email', () => {
    expect(resolveMicrosoftAccountEmail({
      tokenEmail: 'atrox@outlook.it',
      requestedEmail: 'atrox@outlook.it',
    })).toBe('atrox@outlook.it')
  })

  test('rejects a picker mismatch', () => {
    const result = resolveMicrosoftAccountEmail({
      tokenEmail: 'b@outlook.com',
      requestedEmail: 'a@outlook.it',
    })
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).toContain('b@outlook.com')
    expect(String(result)).toContain('a@outlook.it')
  })

  test('falls back to --email when id_token has no email', () => {
    expect(resolveMicrosoftAccountEmail({ requestedEmail: 'atrox@outlook.it' })).toBe('atrox@outlook.it')
  })
})

describe('tokensFromResponse', () => {
  test('reads error_description', () => {
    const result = tokensFromResponse({ error: 'invalid_grant', error_description: 'AADSTS70008: expired' })
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).toContain('AADSTS70008')
  })

  test('requires access_token', () => {
    const result = tokensFromResponse({ refresh_token: 'r' })
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).toContain('access token')
  })

  test('uses fallback refresh token when Microsoft omits it', () => {
    const result = tokensFromResponse({ access_token: 'a', expires_in: 3600 }, 'old-refresh')
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.accessToken).toBe('a')
    expect(result.refreshToken).toBe('old-refresh')
  })

  test('happy path', () => {
    const result = tokensFromResponse({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 10,
      id_token: 'id',
    })
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.accessToken).toBe('a')
    expect(result.refreshToken).toBe('r')
    expect(result.idToken).toBe('id')
    expect(result.clientId).toBe(MICROSOFT_CLIENT_ID)
    expect(result.expiry).toBeGreaterThan(Date.now())
  })
})
