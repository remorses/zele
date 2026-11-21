// Microsoft OAuth for Outlook.com / Hotmail / Microsoft 365 IMAP+SMTP.
// Consumer Outlook IMAP only accepts AUTH=XOAUTH2 (LOGIN is disabled).
// Client ID is Thunderbird's public desktop app, same pattern as Google login.

import * as errore from 'errore'

export const MICROSOFT_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753'
export const MICROSOFT_AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
export const MICROSOFT_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
export const MICROSOFT_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access',
  'openid',
  'email',
]

export interface MicrosoftOAuthTokens {
  accessToken: string
  refreshToken: string
  expiry: number
  clientId: string
  idToken?: string
}

export function buildMicrosoftAuthUrl(opts: {
  challenge: string
  redirectUri: string
  state: string
  loginHint?: string
}): string {
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    scope: MICROSOFT_SCOPES.join(' '),
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    response_mode: 'query',
    prompt: 'select_account',
  })
  if (opts.loginHint) params.set('login_hint', opts.loginHint)
  return `${MICROSOFT_AUTH_ENDPOINT}?${params}`
}

export function emailFromIdToken(idToken: string): string | undefined {
  const payload = idToken.split('.')[1]
  if (!payload) return
  const parsed = errore.tryFn((): { preferred_username?: string; email?: string; upn?: string } =>
    JSON.parse(Buffer.from(payload, 'base64url').toString()),
  )
  if (parsed instanceof Error) return
  const value = parsed.preferred_username ?? parsed.email ?? parsed.upn
  return typeof value === 'string' ? value : undefined
}

export function resolveMicrosoftAccountEmail(opts: {
  tokenEmail?: string
  requestedEmail?: string
}): string | Error {
  const token = opts.tokenEmail?.trim()
  const requested = opts.requestedEmail?.trim()
  if (token && requested && token.toLowerCase() !== requested.toLowerCase()) {
    return new Error(`Signed in as ${token}, but --email was ${requested}. Re-run and pick the right account.`)
  }
  const email = token ?? requested
  if (!email) return new Error('Could not determine Microsoft account email from the token. Pass --email.')
  return email
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  error?: string
  error_description?: string
}

export function tokensFromResponse(json: TokenResponse, fallbackRefreshToken?: string): MicrosoftOAuthTokens | Error {
  if (json.error) {
    return new Error(json.error_description ?? json.error)
  }
  if (!json.access_token) {
    return new Error('Microsoft token response missing access token')
  }
  const refreshToken = json.refresh_token ?? fallbackRefreshToken
  if (!refreshToken) {
    return new Error('Microsoft token response missing refresh token')
  }
  return {
    accessToken: json.access_token,
    refreshToken,
    expiry: Date.now() + (json.expires_in ?? 3600) * 1000,
    clientId: MICROSOFT_CLIENT_ID,
    idToken: json.id_token,
  }
}

async function postToken(body: Record<string, string>): Promise<MicrosoftOAuthTokens | Error> {
  const res = await errore.tryAsync({
    try: () =>
      fetch(MICROSOFT_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      }),
    catch: (err) => new Error('Microsoft token request failed', { cause: err }),
  })
  if (res instanceof Error) return res

  const json = await errore.tryAsync({
    try: async (): Promise<TokenResponse> => await res.json(),
    catch: (err) => new Error('Microsoft token response was not JSON', { cause: err }),
  })
  if (json instanceof Error) return json
  return tokensFromResponse(json, body.refresh_token)
}

export async function exchangeMicrosoftCode(opts: {
  code: string
  verifier: string
  redirectUri: string
}): Promise<MicrosoftOAuthTokens | Error> {
  return postToken({
    client_id: MICROSOFT_CLIENT_ID,
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
    scope: MICROSOFT_SCOPES.join(' '),
  })
}

export async function refreshMicrosoftToken(refreshToken: string): Promise<MicrosoftOAuthTokens | Error> {
  return postToken({
    client_id: MICROSOFT_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: MICROSOFT_SCOPES.join(' '),
  })
}
