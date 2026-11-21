---
'zele': minor
---

Browser login for Google and Microsoft is safer:

- The callback server listens on `127.0.0.1` on a **random port** instead of `localhost:8089`, so login no longer kills whatever process used port 8089.
- Every login sends **PKCE** and a random **state**. zele checks the state in the browser redirect and in a pasted redirect URL, and ignores redirects from other login attempts.
- When the browser runs on another machine, paste the **full redirect URL** from the address bar. A bare code is no longer accepted.
- Login gives up after 10 minutes.

Logging in to a Google account again replaces the saved login of the same email, so `--account` never matches two entries for one address.

The `ZELE_CLIENT_ID` and `ZELE_CLIENT_SECRET` overrides are removed. Accounts saved with a custom client must run `zele login` again.
