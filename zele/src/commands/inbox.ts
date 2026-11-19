// zele.sh commands: sign in with a @gmail.com owner, then create, list, and
// delete receive-only @zele.sh inboxes. Each inbox becomes a normal zele
// account, so `zele mail list --account name@zele.sh` works.
//
//   zele login zele ──► send code to owner Gmail ──► read it from that Gmail
//                       (if it is a zele account)     or prompt / --code
//                   ──► sign in ──► save session ──► add existing inboxes
//   zele inbox create tommy ──► sign in if needed ──► POST /api/v1/inboxes ──► add account

import { z } from 'zod'
import * as clack from '@clack/prompts'
import { isAgent } from 'goke'
import type { ZeleCli } from '../cli-types.js'
import {
  getClients,
  getZeleShSession,
  listAccounts,
  listZeleShAccounts,
  removeZeleShAccount,
  saveZeleShAccount,
  saveZeleShSession,
  zeleShApiFor,
} from '../auth.js'
import { abortableSleep } from '../api-utils.js'
import { codeFromSubject, resolveZeleApiUrl, sendZeleShCode, signInZeleSh, ZELE_SH_DOMAIN } from '../zele-sh-client.js'
import { createOutput, type Output } from '../output.js'

const API_URL_DESCRIPTION = 'zele.sh server URL (default: https://zele.sh, env: ZELE_API_URL)'
const CODE_POLL_INTERVAL_MS = 3_000
const CODE_POLL_TIMEOUT_MS = 90_000

/** Same canonical form as the server: no dots, no +tag, googlemail.com -> gmail.com. */
function canonicalGmail(email: string): string | null {
  const lower = email.trim().toLowerCase()
  const match = /^([^@]+)@(gmail\.com|googlemail\.com)$/.exec(lower)
  if (!match) return null
  return `${match[1]!.split('+')[0]!.replaceAll('.', '')}@gmail.com`
}

/** Google accounts logged in to zele whose address is a consumer @gmail.com. */
async function gmailAccountsInZele(): Promise<string[]> {
  const accounts = await listAccounts()
  return accounts.filter((a) => a.accountType === 'google' && canonicalGmail(a.email)).map((a) => a.email)
}

async function chooseOwnerEmail(out: Output): Promise<string> {
  const gmails = await gmailAccountsInZele()
  if (isAgent || !process.stdin.isTTY) {
    out.error('Missing --owner. The owner must be a @gmail.com address.')
    if (gmails.length > 0) {
      out.hint('Gmail accounts in zele (the code is read automatically from these):')
      for (const email of gmails) out.hint(`  zele login zele --owner ${email}`)
    } else {
      out.hint('Usage: zele login zele --owner you@gmail.com')
    }
    out.exit(1)
  }
  const OTHER = '__other__'
  const choice = gmails.length > 0
    ? await clack.select({
        message: 'Which Gmail owns your zele.sh inboxes?',
        options: [
          ...gmails.map((email) => ({ value: email, label: email, hint: 'code is read automatically' })),
          { value: OTHER, label: 'Another @gmail.com address', hint: 'you type the code' },
        ],
      })
    : OTHER
  if (clack.isCancel(choice)) out.exit(0)
  if (choice !== OTHER) return choice
  const typed = await clack.text({
    message: 'Gmail address',
    placeholder: 'you@gmail.com',
    validate: (value) => (value && canonicalGmail(value) ? undefined : 'Must be a @gmail.com address'),
  })
  if (clack.isCancel(typed)) out.exit(0)
  return typed
}

/** Waits for the code email in a Gmail account already logged in to zele, then trashes it. */
async function readCodeFromGmail(out: Output, { gmail, sentAt }: { gmail: string; sentAt: number }): Promise<string | Error> {
  const clients = await getClients([gmail])
  const client = clients[0]!.client
  const deadline = Date.now() + CODE_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await abortableSleep(CODE_POLL_INTERVAL_MS)
    const result = await client.listThreads({
      folder: 'all',
      // Exclude trash: older codes are trashed after use and are already consumed.
      query: `in:anywhere -in:trash from:noreply@${ZELE_SH_DOMAIN} after:${Math.floor(sentAt / 1000) - 60}`,
      maxResults: 5,
    })
    if (result instanceof Error) return result
    for (const thread of result.threads) {
      const code = codeFromSubject(thread.subject)
      if (!code || Date.parse(thread.date) < sentAt - 60_000) continue
      const trashed = await client.trash({ threadId: thread.id })
      if (trashed instanceof Error) out.hint(`Could not trash the code email: ${trashed.message}`)
      return code
    }
  }
  return new Error(`No zele.sh code arrived in ${gmail} after ${CODE_POLL_TIMEOUT_MS / 1000}s. Check spam, then rerun with --code <code>`)
}

/**
 * Signs in to zele.sh and stores the session. Returns null when a code was sent
 * but must be passed with --code in a second run (agents, non-zele Gmail).
 */
async function signIn(out: Output, { apiUrl, email, code }: { apiUrl: string; email?: string; code?: string }) {
  const ownerInput = email ?? (await chooseOwnerEmail(out))
  const owner = canonicalGmail(ownerInput)
  if (!owner) {
    out.fail(new Error(`zele.sh owners must be @gmail.com addresses, got ${ownerInput}. Try: zele login zele --owner you@gmail.com`))
  }

  let otp = code
  if (!otp) {
    const sentAt = Date.now()
    const sent = await sendZeleShCode({ apiUrl, email: owner })
    if (sent instanceof Error) out.fail(sent)
    const gmail = (await gmailAccountsInZele()).find((e) => canonicalGmail(e) === owner)
    if (gmail) {
      out.hint(`Sent a code to ${gmail}. Reading it from that inbox...`)
      const read = await readCodeFromGmail(out, { gmail, sentAt })
      if (read instanceof Error) out.fail(read)
      otp = read
    } else if (!isAgent && process.stdin.isTTY) {
      const typed = await clack.text({
        message: `Code sent to ${owner}. Enter it`,
        validate: (value) => (value && /^\d{6}$/.test(value.trim()) ? undefined : 'The code has 6 digits'),
      })
      if (clack.isCancel(typed)) out.exit(0)
      otp = typed.trim()
    } else {
      out.success(`Sent a code to ${owner}`)
      out.hint(`Rerun with: zele login zele --owner ${owner} --code <code>`)
      return null
    }
  }

  const session = await signInZeleSh({ apiUrl, email: owner, code: otp })
  if (session instanceof Error) out.fail(session)
  const saved = await saveZeleShSession({ apiUrl, ownerEmail: session.ownerEmail, token: session.token })
  if (saved instanceof Error) out.fail(saved)
  return session
}

/** Makes local zele.sh accounts for this server match the owner's inboxes on the server. */
async function syncInboxes(out: Output, apiUrl: string) {
  const api = zeleShApiFor(apiUrl)
  if (api instanceof Error) out.fail(api)
  const list = await api.listInboxes()
  if (list instanceof Error) out.fail(list)
  const remote = new Set(list.inboxes.map((i) => i.address))
  for (const address of listZeleShAccounts(apiUrl).filter((a) => !remote.has(a))) {
    const removed = await removeZeleShAccount(address)
    if (removed instanceof Error) out.fail(removed)
  }
  for (const inbox of list.inboxes) {
    const saved = await saveZeleShAccount({ address: inbox.address, apiUrl })
    if (saved instanceof Error) out.fail(saved)
  }
  return list
}

async function createInbox(out: Output, { apiUrl, name }: { apiUrl: string; name: string }) {
  const api = zeleShApiFor(apiUrl)
  if (api instanceof Error) out.fail(api)
  const created = await api.createInbox({ name })
  if (created instanceof Error) out.fail(created)
  const saved = await saveZeleShAccount({ address: created.address, apiUrl })
  if (saved instanceof Error) out.fail(saved)
  return created
}

async function promptInboxName(out: Output): Promise<string> {
  const name = await clack.text({
    message: 'Inbox name',
    placeholder: 'tommy',
    validate: (value) =>
      value && /^[a-z0-9][a-z0-9._-]{2,30}(@zele\.sh)?$/i.test(value.trim()) ? undefined : '3-31 chars: a-z 0-9 . _ -',
  })
  if (clack.isCancel(name)) out.exit(0)
  return name.trim()
}

export async function runZeleLogin(out: Output, options: { owner?: string; code?: string; name?: string; apiUrl?: string }) {
  const apiUrl = resolveZeleApiUrl(options.apiUrl)
  const session = await signIn(out, { apiUrl, email: options.owner, code: options.code })
  if (!session) return
  out.success(`Signed in to zele.sh as ${session.ownerEmail}`)
  const list = await syncInboxes(out, apiUrl)

  let name = options.name
  if (!name && list.inboxes.length === 0 && !isAgent && process.stdin.isTTY) {
    const create = await clack.confirm({ message: 'You have no zele.sh inboxes yet. Create one now?' })
    if (!clack.isCancel(create) && create) name = await promptInboxName(out)
  }
  const created = name ? await createInbox(out, { apiUrl, name }) : null
  out.printYaml({
    owner: session.ownerEmail,
    inboxes_added: list.inboxes.map((i) => i.address),
    ...(created ? { created: created.address } : {}),
  })
  if (!created && list.inboxes.length === 0) out.hint('Create an inbox with: zele inbox create <name>')
}

const apiUrlOption = ['--api-url [apiUrl]', z.string().optional().describe(API_URL_DESCRIPTION)] as const

export function registerInboxCommands(cli: ZeleCli) {
  cli
    .command(
      'inbox create [name]',
      'Create a free, permanent name@zele.sh address (receive-only for now, max 10 per owner). Owners sign in with a @gmail.com address',
    )
    .option('--owner [email]', z.string().optional().describe('Your @gmail.com address that owns the inboxes, used to sign in first if needed'))
    .option('--code [code]', z.string().optional().describe('Sign-in code from the zele.sh email (skips auto-read)'))
    .option(...apiUrlOption)
    .example('zele inbox create tommy')
    .example('zele inbox create tommy --owner you@gmail.com')
    .action(async (nameArg, options, ctx) => {
      const out: Output = createOutput(ctx)
      const apiUrl = resolveZeleApiUrl(options.apiUrl)
      if (!getZeleShSession(apiUrl)) {
        const session = await signIn(out, { apiUrl, email: options.owner, code: options.code })
        if (!session) return
        await syncInboxes(out, apiUrl)
      }
      let name = nameArg
      if (!name) {
        if (isAgent || !process.stdin.isTTY) {
          out.error('Missing inbox name. Usage: zele inbox create <name>')
          out.exit(1)
        }
        name = await promptInboxName(out)
      }
      const created = await createInbox(out, { apiUrl, name })
      out.printYaml({
        address: created.address,
        inboxes_used: `${created.used}/${created.limit}`,
        hint: `zele mail list --account ${created.address}`,
      })
    })

  cli
    .command('inbox list', 'List your @zele.sh inboxes on the server')
    .option(...apiUrlOption)
    .action(async (options, ctx) => {
      const out: Output = createOutput(ctx)
      const apiUrl = resolveZeleApiUrl(options.apiUrl)
      const api = zeleShApiFor(apiUrl)
      if (api instanceof Error) out.fail(api)
      const list = await api.listInboxes()
      if (list instanceof Error) out.fail(list)
      const local = new Set(listZeleShAccounts(apiUrl))
      out.printList(
        list.inboxes.map((i) => ({ address: i.address, created: i.createdAt, on_this_machine: local.has(i.address) })),
        { summary: `${list.inboxes.length}/${list.limit} inboxes, owner ${list.owner}` },
      )
      if (list.inboxes.some((i) => !local.has(i.address))) out.hint('Add missing inboxes with: zele login zele')
    })

  cli
    .command('inbox delete <address>', 'Delete a zele.sh inbox and all its mail. The address is never reused')
    .option('--force', 'Skip confirmation')
    .option(...apiUrlOption)
    .example('zele inbox delete tommy@zele.sh --force')
    .action(async (address, options, ctx) => {
      const out: Output = createOutput(ctx)
      const apiUrl = resolveZeleApiUrl(options.apiUrl)
      const full = address.includes('@') ? address.toLowerCase() : `${address.toLowerCase()}@${ZELE_SH_DOMAIN}`
      if (!options.force) {
        if (isAgent || !process.stdin.isTTY) {
          out.error(`Use --force to delete non-interactively: zele inbox delete ${full} --force`)
          out.exit(1)
        }
        const confirmed = await clack.confirm({
          message: `Delete ${full} and all its mail? The address can never be used again.`,
          initialValue: false,
        })
        if (clack.isCancel(confirmed) || !confirmed) return
      }
      const api = zeleShApiFor(apiUrl)
      if (api instanceof Error) out.fail(api)
      const deleted = await api.deleteInbox({ address: full })
      if (deleted instanceof Error) out.fail(deleted)
      const removed = await removeZeleShAccount(deleted.address)
      if (removed instanceof Error) out.fail(removed)
      out.printYaml({ deleted: deleted.address, deleted_messages: deleted.deletedMessages })
    })
}
