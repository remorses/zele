---
title: Google OAuth verification
description: Scopes zele requests from its own Google Cloud project (zele-sh), why each one is needed, and the Gmail API methods each scope covers.
---

# Google OAuth verification

zele's own OAuth app lives in the Google Cloud project **zele** (`zele-sh`, owner `t.de.rossi.01@gmail.com`). The client `zele` is a **Desktop app** client (`701207960653-cd08in62...`), branding is verified. The secret is in Sigillo (project `01M4DYDQ7R71RABP4437D4XFVT`, env `dev`, `ZELE_CLIENT_SECRET`) and embedded in `zele/src/auth.ts`.

The Thunderbird client stays the default until the scopes pass review. Do not advertise the zele client in the README or in CLI hints before that. Try it with:

```bash
ZELE_GOOGLE_CLIENT=zele zele login --method google
```

## Login flow

zele is a **local client application**: the authorization code, tokens and Gmail or Calendar data never reach zele.sh, so no CASA audit is needed. All Google clients use the same installed-app flow ([RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252), [Google docs](https://developers.google.com/identity/protocols/oauth2/native-app)):

```
zele login (CLI)                                      browser (same machine)
────────────────                                      ──────────────────────
listen on http://127.0.0.1:<random port>
state = 32 random bytes, PKCE verifier + S256 challenge
print/open auth URL (redirect_uri, state, challenge) ──►  Google consent
                                                          Google 302 ?code&state
loopback server checks state, gets code  ◄──────────────  GET http://127.0.0.1:<port>/
code + verifier + client secret + redirect_uri ──►  Google token endpoint
tokens saved in ~/.zele/sqlite.db
```

- Desktop clients accept any port on the loopback address, so zele never needs a fixed port. Thunderbird does the same with its clients.
- Browser on another machine: the 127.0.0.1 page does not load. The user pastes the redirect URL from the address bar; zele checks its `state` the same way.
- Google does not treat Desktop client secrets as confidential. PKCE and the state protect the flow.
- Logging in with one client deletes the Google rows of the same email from other clients (`login` in `auth.ts`).
- Code: `zele/src/auth.ts` (`OAUTH_CLIENTS`, `login`), `zele/src/oauth-callback-server.ts` (`waitForOAuthCode`, `createPkce`).
- The earlier hosted flow (Web client, code handed through `zele.sh/oauth/google/callback`) is removed. Its D1 table `oauth_handoff` is dropped by `website/drizzle/20261120130609_drop_oauth_handoff`.

## Scopes

| Scope | Level | Why zele needs it |
| --- | --- | --- |
| `gmail.modify` | restricted | Read, search and send mail, manage drafts and labels, archive, mark read, star, trash and untrash. zele never deletes mail permanently. |
| `gmail.settings.basic` | restricted | `zele mail filter create/delete` manage Gmail filters. `filters.create` and `filters.delete` accept only this scope. |
| `calendar` | sensitive | zele reads and writes events through Google's CalDAV API, which needs full calendar access. Used by `zele cal` list, create, update, delete and RSVP. |

Not requested:

- `https://mail.google.com/`: only needed for permanent delete or Gmail IMAP/SMTP. zele uses neither.
- `userinfo.email`: login reads the address from `users.getProfile`, which `gmail.modify` covers.

## Reasons for the review form

**gmail.modify.** zele is a local command line email client. Users read their inbox, search, open threads and attachments, write and send replies, and manage drafts. They also archive, star, label, mark read and move threads to trash. Read-only or compose-only scopes cannot change labels or trash threads, so `gmail.modify` is the narrowest scope that covers these features. zele never permanently deletes mail.

**gmail.settings.basic.** The `zele mail filter` command lists, creates and deletes Gmail filters so users can sort incoming mail from the terminal. Gmail only allows `filters.create` and `filters.delete` with this scope. zele also lists send-as aliases so replies go out from the right address.

**calendar.** `zele cal` lists the user's calendars and events, creates, edits and deletes events, and answers invitations. zele talks to Google Calendar over CalDAV, which requires full calendar access. A read-only scope cannot create events or send RSVPs.

**Data handling.** zele runs on the user's computer. OAuth tokens and cached mail stay in `~/.zele/sqlite.db` on that machine. No Google user data is sent to zele.sh or any other server. Login uses a loopback redirect to the user's own computer with PKCE. Privacy policy: https://zele.sh/privacy

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

Google CalDAV (`apidata.googleusercontent.com/caldav/v2/`) needs the **CalDAV API** enabled in the project, besides the Calendar API.

A live read-only test with only these three scopes returned 200 for every Gmail read above and 207 for CalDAV `PROPFIND` and `REPORT` (2026-11-19).
