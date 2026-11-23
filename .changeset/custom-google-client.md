---
'zele': patch
---

`ZELE_CLIENT_ID` and `ZELE_CLIENT_SECRET` work again: set both to log in to Google with your own OAuth client. These logins use the redirect `http://localhost:8089`, like before 0.12, so Web application clients registered with that URI keep working. Accounts saved with a custom client refresh again when the variables are set.
