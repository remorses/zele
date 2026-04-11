// Mail action commands: star, unstar, archive, trash, untrash, mark read/unread,
// spam, unspam, label modify, unsubscribe.
// Bulk operations on threads — cache invalidation is handled by the client methods.

import type { ZeleCli } from '../cli-types.js'
import { z } from 'zod'
import * as errore from 'errore'
import { getClient } from '../auth.js'
import type { GmailClient, ParsedMessage } from '../gmail-client.js'
import type { ImapSmtpClient } from '../imap-smtp-client.js'
import { UnsubscribeUnavailableError, UnsubscribeFailedError } from '../api-utils.js'
import {
  planUnsubscribe,
  type UnsubscribeMechanism,
  type UnsubscribePlan,
} from '../unsubscribe.js'
import * as out from '../output.js'
import { handleCommandError } from '../output.js'

// ---------------------------------------------------------------------------
// Helper: run a bulk action
// ---------------------------------------------------------------------------

async function bulkAction(
  threadIds: string[],
  actionName: string,
  accountFilter: string[] | undefined,
  fn: (client: GmailClient | ImapSmtpClient, ids: string[]) => Promise<void | Error>,
) {
  if (threadIds.length === 0) {
    out.error('No thread IDs provided')
    process.exit(1)
  }

  const { client } = await getClient(accountFilter)
  const result = await fn(client, threadIds)
  if (result instanceof Error) handleCommandError(result)

  out.printYaml({ action: actionName, thread_ids: threadIds, success: true })
}

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------

export function registerMailActionCommands(cli: ZeleCli) {
  cli
    .command('mail star [...threadIds]', 'Star threads')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Starred', options.account, (c, ids) => c.star({ threadIds: ids }))
    })

  cli
    .command('mail unstar [...threadIds]', 'Remove star from threads')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Unstarred', options.account, (c, ids) => c.unstar({ threadIds: ids }))
    })

  cli
    .command('mail archive [...threadIds]', 'Archive threads (remove from inbox)')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Archived', options.account, (c, ids) => c.archive({ threadIds: ids }))
    })

  cli
    .command('mail trash <threadId>', 'Move thread to trash')
    .action(async (threadId, options) => {
      await bulkAction([threadId], 'Trashed', options.account, (c, ids) => c.trash({ threadId: ids[0]! }))
    })

  cli
    .command('mail untrash <threadId>', 'Remove thread from trash')
    .action(async (threadId, options) => {
      await bulkAction([threadId], 'Untrashed', options.account, (c, ids) => c.untrash({ threadId: ids[0]! }))
    })

  cli
    .command('mail read-mark [...threadIds]', 'Mark threads as read (removes UNREAD label)')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Marked as read', options.account, (c, ids) => c.markAsRead({ threadIds: ids }))
    })

  cli
    .command('mail unread-mark [...threadIds]', 'Mark threads as unread')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Marked as unread', options.account, (c, ids) => c.markAsUnread({ threadIds: ids }))
    })

  cli
    .command('mail spam [...threadIds]', 'Mark threads as spam')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Marked as spam', options.account, (c, ids) => c.markAsSpam({ threadIds: ids }))
    })

  cli
    .command('mail unspam [...threadIds]', 'Remove threads from spam')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Removed from spam', options.account, (c, ids) => c.unmarkSpam({ threadIds: ids }))
    })

  cli
    .command('mail label [...threadIds]', 'Add or remove labels from threads')
    .option('--add <add>', z.string().describe('Labels to add (comma-separated)'))
    .option('--remove <remove>', z.string().describe('Labels to remove (comma-separated)'))
    .action(async (threadIds, options) => {
      if (!options.add && !options.remove) {
        out.error('At least one of --add or --remove is required')
        process.exit(1)
      }

      const addLabels = options.add?.split(',').map((l: string) => l.trim()).filter(Boolean) ?? []
      const removeLabels = options.remove?.split(',').map((l: string) => l.trim()).filter(Boolean) ?? []

      await bulkAction(
        threadIds,
        'Labels modified',
        options.account,
        (c, ids) => c.modifyLabels({ threadIds: ids, addLabelIds: addLabels, removeLabelIds: removeLabels }),
      )
    })

  cli
    .command('mail trash-spam', 'Trash all spam threads')
    .action(async (options) => {
      const { client } = await getClient(options.account)
      const result = await client.trashAllSpam()
      if (result instanceof Error) handleCommandError(result)

      out.printYaml(result)
      out.success(`Trashed ${result.count} spam thread(s)`)
    })

  // =========================================================================
  // mail unsubscribe — RFC 2369 + RFC 8058
  // =========================================================================
  //
  // Reads List-Unsubscribe and List-Unsubscribe-Post from the latest non-draft
  // message in a thread, then picks a mechanism:
  //   1. RFC 8058 one-click (HTTPS POST with `List-Unsubscribe=One-Click`)
  //   2. RFC 2369 mailto: (send the canonical unsubscribe email)
  //   3. RFC 2369 http(s): landing page (manual — print URL only)
  //
  // The decision logic lives in ../unsubscribe.ts so it can be unit-tested
  // with inline snapshots. This command is the thin executor: fetch thread,
  // build plan, optionally dry-run, otherwise perform the chosen mechanism.

  cli
    .command('mail unsubscribe <threadId>', 'Unsubscribe from a mailing list thread (RFC 2369 / RFC 8058)')
    .option('--via <via>', z.enum(['auto', 'one-click', 'mailto', 'url']).describe(
      'Mechanism to use (default: auto — prefers one-click if DKIM passes, then mailto, then url)',
    ))
    .option('--dry-run', 'Print the unsubscribe plan without executing anything')
    .option('--require-dkim', 'Refuse one-click unless the message has DKIM=pass')
    .option('--then <then>', z.enum(['nothing', 'archive', 'trash']).describe(
      'Follow-up action on the thread after unsubscribing (default: nothing)',
    ))
    .action(async (threadId, options) => {
      const via = options.via ?? 'auto'
      const then = options.then ?? 'nothing'

      const { client } = await getClient(options.account)
      const { parsed: thread } = await client.getThread({ threadId })

      const nonDraft = thread.messages.filter((m) => !m.isDraft)
      const latest: ParsedMessage | undefined = nonDraft[nonDraft.length - 1] ?? thread.messages[thread.messages.length - 1]
      if (!latest) {
        handleCommandError(new UnsubscribeUnavailableError({ threadId }))
      }

      // DKIM gating: per RFC 8058 §4 the signed headers SHOULD include
      // List-Unsubscribe and List-Unsubscribe-Post. We can't verify the
      // `h=` tag here, so we approximate with the MTA's DKIM verdict
      // (`auth.dkim === 'pass'`). SPF and DMARC aren't relevant for this
      // specific header-signing check, so we don't require `auth.authentic`.
      const dkimPass: boolean | null = latest.auth ? latest.auth.dkim === 'pass' : null
      const plan = planUnsubscribe({
        listUnsubscribe: latest.listUnsubscribe,
        listUnsubscribePost: latest.listUnsubscribePost,
        dkimAuthentic: dkimPass,
      })

      if (plan.mechanisms.length === 0) {
        handleCommandError(new UnsubscribeUnavailableError({ threadId }))
      }

      const chosen = pickMechanism(plan, via, dkimPass)
      if (chosen instanceof Error) handleCommandError(chosen)

      if (options.requireDkim && chosen.kind === 'one-click' && dkimPass !== true) {
        handleCommandError(
          new UnsubscribeFailedError({
            mechanism: 'one-click',
            reason:
              dkimPass === false
                ? 'DKIM did not pass and --require-dkim was set'
                : 'DKIM status unknown and --require-dkim was set',
          }),
        )
      }

      if (options.dryRun) {
        out.printYaml({
          action: 'Unsubscribe (dry-run)',
          thread_id: threadId,
          chosen: describeMechanism(chosen),
          plan: describePlan(plan),
        })
        return
      }

      // Execute the chosen mechanism.
      if (chosen.kind === 'one-click') {
        const res = await oneClickPost(chosen.url)
        if (res instanceof Error) handleCommandError(res)
      } else if (chosen.kind === 'mailto') {
        const sendResult = await client.sendMessage({
          to: [{ email: chosen.mailto.to }],
          subject: chosen.mailto.subject ?? 'unsubscribe',
          body: chosen.mailto.body ?? 'unsubscribe',
          cc: chosen.mailto.cc?.map((email) => ({ email })),
        })
        if (sendResult instanceof Error) {
          handleCommandError(
            new UnsubscribeFailedError({
              mechanism: 'mailto',
              reason: sendResult.message,
              cause: sendResult,
            }),
          )
        }
      } else {
        // url: cannot be executed programmatically — surface the URL and exit
        // without marking success (nothing was actually done).
        out.printYaml({
          action: 'Unsubscribe (manual required)',
          thread_id: threadId,
          url: chosen.url,
          note: 'Only a landing-page URL is available. Open it in a browser to complete unsubscription.',
          plan: describePlan(plan),
        })
        out.hint('Open the printed URL in a browser to finish unsubscribing.')
        return
      }

      // Unsubscribe action itself succeeded at this point. Report that
      // BEFORE attempting the follow-up so that a follow-up failure can't
      // hide an already-completed (and irreversible) unsubscribe.
      out.printYaml({
        action: 'Unsubscribed',
        thread_id: threadId,
        mechanism: describeMechanism(chosen),
        then,
        plan: describePlan(plan),
      })
      out.success(`Unsubscribed via ${chosen.kind}`)

      // Optional follow-up action on the thread. Failure here is non-fatal
      // for the unsubscribe itself — warn and exit non-zero so scripts can
      // still notice, but don't hide the success.
      if (then === 'archive') {
        const r = await client.archive({ threadIds: [threadId] })
        if (r instanceof Error) {
          out.error(`Unsubscribed, but follow-up archive failed: ${r.message}`)
          process.exit(1)
        }
      } else if (then === 'trash') {
        const r = await client.trash({ threadId })
        if (r instanceof Error) {
          out.error(`Unsubscribed, but follow-up trash failed: ${r.message}`)
          process.exit(1)
        }
      }
    })
}

// ---------------------------------------------------------------------------
// Unsubscribe helpers
// ---------------------------------------------------------------------------

/** Pick a mechanism from a plan based on the --via flag.
 *
 *  In `auto` mode we only use one-click if DKIM is known to pass, so a
 *  spoofed List-Unsubscribe-Post header on an unauthenticated message
 *  can't trigger a background POST. Users can still force it with
 *  `--via one-click` (and can combine with `--require-dkim` to re-gate). */
function pickMechanism(
  plan: UnsubscribePlan,
  via: 'auto' | 'one-click' | 'mailto' | 'url',
  dkimPass: boolean | null,
): UnsubscribeMechanism | UnsubscribeFailedError {
  if (via === 'auto') {
    for (const m of plan.mechanisms) {
      if (m.kind === 'one-click' && dkimPass !== true) continue
      return m
    }
    // Nothing usable in auto mode — the only remaining case is a plan made
    // up entirely of one-click entries on a message we couldn't verify.
    if (plan.mechanisms.length === 0) {
      return new UnsubscribeFailedError({ mechanism: 'auto', reason: 'no mechanisms available' })
    }
    return new UnsubscribeFailedError({
      mechanism: 'auto',
      reason:
        'only one-click is advertised, but DKIM did not pass. Re-run with --via one-click to force it.',
    })
  }
  const match = plan.mechanisms.find((m) => m.kind === via)
  if (match) return match
  return new UnsubscribeFailedError({
    mechanism: via,
    reason: `no ${via} mechanism advertised by the sender`,
  })
}

/** Reject URLs that point at localhost, loopback, or RFC1918 / link-local /
 *  ULA ranges. This is a best-effort SSRF guard — it won't catch DNS
 *  rebinding or hostnames that resolve to private IPs, but it stops the
 *  obvious cases of `https://127.0.0.1/unsubscribe` hidden in a spoofed
 *  List-Unsubscribe header. */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'ip6-localhost') return true

  // IPv4 literal
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10) return true
    if (a === 127) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true // link-local
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    return false
  }

  // IPv6 literal — reject loopback (::1), link-local (fe80::/10), ULA (fc00::/7).
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true
  return false
}

/** Build an RFC 8058 one-click POST request and validate the response.
 *  Returns void on success, UnsubscribeFailedError on any failure. */
async function oneClickPost(url: string): Promise<void | UnsubscribeFailedError> {
  // Re-validate the URL at the executor boundary (not just the planner),
  // in case a future code path constructs a mechanism without going
  // through planUnsubscribe.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (err) {
    return new UnsubscribeFailedError({
      mechanism: 'one-click',
      reason: `invalid URL: ${String(err)}`,
      cause: err,
    })
  }
  if (parsed.protocol !== 'https:') {
    return new UnsubscribeFailedError({
      mechanism: 'one-click',
      reason: `refusing to POST to ${parsed.protocol} URL (RFC 8058 requires https)`,
    })
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return new UnsubscribeFailedError({
      mechanism: 'one-click',
      reason: `refusing to POST to private/loopback host ${parsed.hostname} (SSRF guard)`,
    })
  }

  // RFC 8058 §3.1: senders MUST NOT return redirects, so we refuse to follow.
  // `redirect: 'manual'` lets us see 3xx status codes instead of auto-following.
  // 5-second timeout keeps a slow/unreachable endpoint from hanging the CLI.
  const res = await errore.tryAsync({
    try: () =>
      fetch(parsed, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      }),
    catch: (err) =>
      new UnsubscribeFailedError({
        mechanism: 'one-click',
        reason: String(err),
        cause: err,
      }),
  })
  if (res instanceof Error) return res

  if (res.status >= 200 && res.status < 300) return undefined
  if (res.status >= 300 && res.status < 400) {
    // RFC 8058 §3.1 says senders MUST NOT redirect, but many widely-deployed
    // senders (ConvertKit, SendGrid, Mailchimp) redirect to a "you have been
    // unsubscribed" confirmation page after processing the POST body. A POST
    // that was going to be rejected would return 4xx, not 3xx — the server
    // has to read and act on the body before deciding to redirect — so we
    // treat 3xx as success with a warning printed to stderr.
    const location = res.headers.get('location')
    out.hint(
      `one-click endpoint returned HTTP ${res.status} redirect${location ? ` → ${location}` : ''} (RFC 8058 §3.1 forbids this, but many senders do it anyway). Treating as success.`,
    )
    return undefined
  }
  return new UnsubscribeFailedError({
    mechanism: 'one-click',
    reason: `HTTP ${res.status} ${res.statusText}`,
  })
}

/** YAML-friendly representation of a mechanism for output. */
function describeMechanism(m: UnsubscribeMechanism): Record<string, unknown> {
  if (m.kind === 'one-click') return { kind: 'one-click', url: m.url }
  if (m.kind === 'url') return { kind: 'url', url: m.url }
  return {
    kind: 'mailto',
    to: m.mailto.to,
    ...(m.mailto.subject ? { subject: m.mailto.subject } : {}),
    ...(m.mailto.body ? { body: m.mailto.body } : {}),
    ...(m.mailto.cc && m.mailto.cc.length > 0 ? { cc: m.mailto.cc } : {}),
  }
}

/** YAML-friendly representation of a full plan. */
function describePlan(plan: UnsubscribePlan): Record<string, unknown> {
  return {
    mechanisms: plan.mechanisms.map(describeMechanism),
    has_one_click: plan.hasOneClick,
    dkim_authentic: plan.dkimAuthentic,
    ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
  }
}
