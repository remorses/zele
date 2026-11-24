---
title: Google OAuth verification
description: Scopes zele requests from its own Google Cloud project (zele-sh), how login works with zele.sh as the OAuth web client, why each scope is needed, and the Gmail API methods each scope covers.
---

# Google OAuth verification

zele's own OAuth app lives in the Google Cloud project **zele** (`zele-sh`, owner `t.de.rossi.01@gmail.com`). The client `zele-web` is a **Web application** client (`701207960653-cfdhpbiu...`), branding is verified. Registered redirect URIs: `https://zele.sh/oauth/google/callback` and `https://preview.zele.sh/oauth/google/callback`. The secret is in Sigillo (project `01M4DYDQ7R71RABP4437D4XFVT`, env `dev`, `ZELE_WEB_CLIENT_SECRET`) and set as the Worker secret `ZELE_WEB_CLIENT_SECRET` on zele.sh and preview.zele.sh. It is **never** in the CLI or the npm package: a search of `zele/` for the `GOC` + `SPX-` secret prefix must find nothing.

The Thunderbird client stays the default until the scopes pass review. Do not advertise the zele client in the README or in CLI hints before that. Try it with:

```bash
ZELE_GOOGLE_CLIENT=zele zele login --method google
```

## Login flow

Every login uses PKCE S256 and a random state ([RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636)). The flow depends on the client (`redirect` in `OAUTH_CLIENTS`, `zele/src/auth.ts`).

### zele client: zele.sh is the OAuth web client

zele.sh holds the client secret and the scopes; the CLI holds the PKCE verifier. Neither side can redeem the authorization code alone. The browser can run on any machine and nothing is pasted.

```
zele login (CLI)                     browser (any device)           zele.sh Worker
────────────────                     ────────────────────           ──────────────
state, PKCE verifier + challenge
print/open /oauth/google/start ───►  confirm page "ABC-123"  ◄────  code from sha256(state)
print "check code ABC-123"           Continue to Google ─────────►  Google consent
                                     Google 302 /callback ───────►  OAuthHandoff DO
                                     "Login complete"               keeps code ≤ 10 min
POST /poll {state} every 2s ─────────────────────────────────────►  pending, or code once
POST /token {code, verifier} ────────────────────────────────────►  + secret ──► Google
tokens  ◄─────────────────────── in transit, not stored ◄─────────  Google's JSON body
saved in ~/.zele/sqlite.db
on expiry: POST /refresh {refreshToken} ─────────────────────────►  + secret ──► Google
```

Routes: `/oauth/google/start`, `/oauth/google/callback`, and `/api/v1/oauth/google/{poll,token,refresh}`.

- `GET /oauth/google/start` validates state and challenge and builds Google's authorize URL with constants (client id, scopes, `access_type=offline`, `prompt=consent`, S256, `redirect_uri=${BETTER_AUTH_URL}/oauth/google/callback`). It stores nothing.
- The confirm code (first 6 base32 chars of sha256(state), `ABC-DEF`) is printed by the CLI and shown on the start page, so a user can spot a login link someone else started.
- `/start` also sets the cookie `__Host-zele_oauth=<sha256(state)>` (10 min, `SameSite=Lax`). The callback rejects a code without a matching cookie, so a raw Google authorize URL sent by someone else (skipping the confirm page) cannot complete a login.
- Start and callback pages send `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'`.
- The `OAuthHandoff` Durable Object (`idFromName(sha256(state))`) returns the code once and deletes itself with an alarm 10 minutes after the callback.
- The token and refresh routes forward Google's JSON body as-is. They store and log nothing; on failure they return only `error` and `error_description`.
- Tokens transit zele.sh (token and refresh routes), so Google may require a CASA security assessment for the restricted Gmail scopes.
- Worker request logs (observability) record the callback URL, which contains the one-time code. The code is single-use and useless without the verifier.
- Rate limits per `cf-connecting-ip`: poll 120/min, token and refresh 30/min, start and callback 20/min.
- In the CLI, zele-client accounts keep no `refresh_token` on the `OAuth2Client`, so google-auth-library calls `refreshHandler` on expiry. It refreshes through zele.sh, saves the new access token, and maps `invalid_grant` to `AuthError` ("Run: zele login").
- `ZELE_API_URL=https://preview.zele.sh` uses the preview Worker (its callback is also registered).
- Code: `website/src/oauth-handoff.ts`; `waitForZeleShOAuthCode`, `exchangeZeleShGoogleCode`, `refreshZeleShGoogleToken` in `zele/src/oauth-callback-server.ts`; `createGoogleAuth` in `zele/src/auth.ts`.

### Third-party clients and Microsoft: loopback

Thunderbird, GNOME and KDE are Desktop clients, so they redirect to the user's own computer ([RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)):

```
zele login (CLI)                                      browser (same machine)
────────────────                                      ──────────────────────
listen on http://127.0.0.1:<random port>
state + PKCE challenge in auth URL ─────────────────►  Google consent
                                                       Google 302 ?code&state
loopback server checks state, gets code  ◄───────────  GET http://127.0.0.1:<port>/
code + verifier + client secret + redirect_uri ──►  Google token endpoint
```

- Desktop clients accept any port on the loopback address. Thunderbird does the same.
- Browser on another machine: the 127.0.0.1 page does not load. The user pastes the redirect URL from the address bar; zele checks its `state` the same way.
- Google does not treat Desktop client secrets as confidential, so these third-party secrets are embedded, like Thunderbird does.
- Code: `waitForOAuthCode` in `zele/src/oauth-callback-server.ts`.

### Both flows

- Logging in with one client deletes the Google rows of the same email from other clients (`login` in `zele/src/auth.ts`).
- Accounts saved with the old `zele` Desktop client (`701207960653-cd08in62...`, never published) fail with the existing "Run: zele login" message and are replaced by the next login.

## Scopes

| Scope | Level | Why zele needs it |
| --- | --- | --- |
| `gmail.modify` | restricted | Read, search and send mail, manage drafts and labels, archive, mark read, star, trash and untrash. zele never deletes mail permanently. |
| `gmail.settings.basic` | restricted | `zele mail filter create/delete` manage Gmail filters. `filters.create` and `filters.delete` accept only this scope. |
| `calendar.events` | sensitive | `zele cal events`, `get`, `create`, `update`, `delete`, `respond` and `freebusy` through the Calendar REST API (`GoogleCalendarApiClient`). |
| `calendar.calendarlist.readonly` | non-sensitive | `zele cal list`, and the calendar time zone used to read `--from tomorrow 10:00`. |

Not requested:

- `https://mail.google.com/`: only needed for permanent delete or Gmail IMAP/SMTP. zele uses neither.
- `userinfo.email`: login reads the address from `users.getProfile`, which `gmail.modify` covers.
- `calendar`: only Google CalDAV needs it. The zele client uses the Calendar REST API instead. The third-party clients still grant `calendar`, so their accounts keep using CalDAV (`CalDavCalendarClient`); `createCalendarClient` in `auth.ts` picks by the granted scopes.
- `calendar.events.owned` or `calendar.app.created`: they cannot answer invitations from other people (`events.patch` on an event the user does not own).

## Reasons for the review form

**gmail.modify.** zele is a local command line email client. Users read their inbox, search, open threads and attachments, write and send replies, and manage drafts. They also archive, star, label, mark read and move threads to trash. Read-only or compose-only scopes cannot change labels or trash threads, so `gmail.modify` is the narrowest scope that covers these features. zele never permanently deletes mail.

**gmail.settings.basic.** The `zele mail filter` command lists, creates and deletes Gmail filters so users can sort incoming mail from the terminal. Gmail only allows `filters.create` and `filters.delete` with this scope. zele also lists send-as aliases so replies go out from the right address.

**calendar.events.** `zele cal` lists and reads events, creates, edits and deletes events (with attendees and Google Meet links), and answers invitations (accept, decline, maybe). `calendar.events.readonly` cannot write. `calendar.events.owned` and `calendar.app.created` cannot answer invitations from other people, because those events belong to the organizer. zele never changes, shares or deletes calendars, so it does not request `calendar`.

**calendar.calendarlist.readonly.** `zele cal list` shows the calendars in the user's Google Calendar, and every time the user types, like `--from tomorrow 10:00`, is read in the calendar's time zone from `calendarList.get`. `calendar.events` cannot list calendars.

**Data handling.** zele runs on the user's computer, and every Gmail and Calendar API call goes directly from there to Google. OAuth tokens and cached mail are stored only in `~/.zele/sqlite.db` on that machine. zele.sh is the OAuth web client: it redirects the user to Google, keeps the one-time authorization code for up to 10 minutes until the CLI collects it, and adds the client secret when the CLI exchanges the code (with its PKCE verifier) or refreshes the access token. Tokens pass through zele.sh in transit and are not stored or logged. No mail or calendar content reaches zele.sh. Privacy policy: https://zele.sh/privacy

## Gmail methods and accepted scopes

Checked against the Gmail API reference (`Authorization scopes` section of each method page).

| Method | Covered by |
| --- | --- |
| `users.getProfile`, `history.list`, `threads.list/get`, `messages.get`, `messages.attachments.get` | `gmail.modify` |
| `drafts.list/get/create/update/delete/send` | `gmail.modify` |
| `messages.send` | `gmail.modify` |
| `labels.list/get/create/patch/delete` | `gmail.modify` |
| `threads.modify/trash/untrash`, `messages.batchModify` | `gmail.modify` |
| `settings.filters.list`, `settings.sendAs.list` | `gmail.modify` or `gmail.settings.basic` |
| `settings.filters.create/delete` | `gmail.settings.basic` only |

The zele client needs the **Google Calendar API** enabled in project zele-sh. Google CalDAV (`apidata.googleusercontent.com/caldav/v2/`, third-party clients only) needs the **CalDAV API** enabled in the calling project.

A live read-only test with only these three scopes returned 200 for every Gmail read above and 207 for CalDAV `PROPFIND` and `REPORT` (2026-11-19).
