// zele.sh worker: docs site (holocron), better-auth at /api/auth, the inbox
// API at /api/v1, the Google login relay (oauth-handoff.ts), and the Email
// Routing handler for *@zele.sh.

import './globals.css'

import { Spiceflow, redirect } from 'spiceflow'
import { app as holocronApp } from '@holocron.so/vite/app'
import { getAuth } from './db.ts'
import { apiApp } from './api.ts'
import { receiveMail } from './receive-mail.ts'
import { oauthHandoffApp } from './oauth-handoff.ts'

export { InboxStore } from './inbox-store.ts'
export { OAuthHandoff } from './oauth-handoff.ts'

export const app = new Spiceflow()
  .use(({ request }, next) => {
    const url = new URL(request.url)
    if (!url.hostname.startsWith('www.')) return next()
    url.hostname = url.hostname.slice('www.'.length)
    url.protocol = 'https:'
    throw redirect(url.toString(), { status: 301 })
  })
  .use(async ({ request }, next) => {
    if (!request.parsedUrl.pathname.startsWith('/api/auth')) return next()
    const response = await getAuth().handler(request)
    if (response.ok || response.status !== 404) return response
    return next()
  })
  .use(apiApp)
  .use(oauthHandoffApp)
  .use(holocronApp)

export default {
  fetch(request: Request) {
    return app.handle(request)
  },
  email(message: ForwardableEmailMessage) {
    return receiveMail(message)
  },
} satisfies ExportedHandler<Env>
