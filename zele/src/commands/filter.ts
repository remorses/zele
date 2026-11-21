// Filter commands: list, create, delete Gmail filters.
// Multi-account support via getClients/getClient like label.ts.

import type { ZeleCli } from '../cli-types.js'
import { z } from 'zod'
import { getClients, getGmailClient } from '../auth.js'
import { AuthError, MissingScopeError, UnsupportedError, ValidationError } from '../api-utils.js'
import type { GmailClient } from '../gmail-client.js'
import { createOutput, type Output } from '../output.js'

export function registerFilterCommands(cli: ZeleCli) {
  // =========================================================================
  // filter list
  // =========================================================================

  cli
    .command('mail filter list', 'List all Gmail filters')
    .action(async (options, ctx) => {
      const out: Output = createOutput(ctx)
      const clients = await getClients(options.account)
      const googleClients = clients.filter((c) => c.accountType === 'google')
      if (googleClients.length === 0) {
        out.fail(new UnsupportedError({ feature: 'Filters', accountType: 'IMAP/SMTP and zele.sh', hint: 'Filters are a Gmail-specific feature.' }))
      }

      const results = await Promise.all(
        googleClients.map(async ({ email, client }) => {
          const res = await (client as GmailClient).listFilters()
          if (res instanceof Error) return res
          return { email, filters: res.parsed }
        }),
      )

      const allResults = results.filter((r): r is Exclude<typeof r, Error> => {
        if (r instanceof MissingScopeError) { out.error(r.message); return false }
        if (r instanceof AuthError) { out.error(`${r.message}. Try: zele login`); return false }
        if (r instanceof Error) { out.error(`Failed to fetch filters: ${r.message}`); return false }
        return true
      })

      const merged = allResults.flatMap(({ email, filters }) =>
        filters.map((f) => ({ ...f, account: email })),
      )

      if (merged.length === 0) {
        out.hint('No filters found')
        return
      }

      const showAccount = clients.length > 1
      for (const f of merged) {
        out.printYaml({
          ...(showAccount ? { account: f.account } : {}),
          id: f.id,
          criteria: f.criteria,
          action: f.action,
        })
      }

      out.hint(`${merged.length} filter(s)`)
    })

  // =========================================================================
  // filter create
  // =========================================================================

  // Gmail accepts filter writes only with gmail.settings.basic. The default Google
  // client cannot grant it, so the token scope is checked before any label is created.
  cli
    .command('mail filter create', 'Create a Gmail filter for incoming mail')
    .option('--from [from]', z.string().optional().describe('Match sender (email, domain or name)'))
    .option('--to [to]', z.string().optional().describe('Match recipient'))
    .option('--subject [subject]', z.string().optional().describe('Match words in the subject'))
    .option('--query [query]', z.string().optional().describe('Match a Gmail search query, e.g. "has:attachment larger:5M"'))
    .option('--add-label <addLabel>', z.array(z.string()).describe('Label to add, created if missing (repeatable)'))
    .option('--remove-label <removeLabel>', z.array(z.string()).describe('Label to remove (repeatable)'))
    .option('--archive', 'Skip the inbox')
    .option('--mark-read', 'Mark as read')
    .option('--star', 'Star the message')
    .example('zele mail filter create --from news@example.com --add-label Newsletters --archive')
    .example('zele mail filter create --subject "invoice" --star')
    .action(async (options, ctx) => {
      const out: Output = createOutput(ctx)
      if (!options.from && !options.to && !options.subject && !options.query) {
        out.fail(new ValidationError({ field: 'criteria', reason: 'pass at least one of --from, --to, --subject, --query' }))
      }
      const addLabels = [...(options.addLabel ?? []), ...(options.star ? ['STARRED'] : [])]
      const removeLabels = [
        ...(options.removeLabel ?? []),
        ...(options.archive ? ['INBOX'] : []),
        ...(options.markRead ? ['UNREAD'] : []),
      ]
      if (addLabels.length === 0 && removeLabels.length === 0) {
        out.fail(new ValidationError({ field: 'action', reason: 'pass at least one of --add-label, --remove-label, --archive, --mark-read, --star' }))
      }

      const { email, client } = await getGmailClient(options.account)
      const scopeError = client.requireFilterWriteScope()
      if (scopeError) out.fail(scopeError)
      const addLabelIds = await resolveLabelIds({ client, labels: addLabels, create: true })
      if (addLabelIds instanceof Error) out.fail(addLabelIds)
      const removeLabelIds = await resolveLabelIds({ client, labels: removeLabels, create: false })
      if (removeLabelIds instanceof Error) out.fail(removeLabelIds)

      const filter = await client.createFilter({
        from: options.from,
        to: options.to,
        subject: options.subject,
        query: options.query,
        addLabelIds,
        removeLabelIds,
      })
      if (filter instanceof Error) out.fail(filter)

      out.printYaml({ account: email, id: filter.id, criteria: filter.criteria, action: filter.action })
      out.hint(`Delete with: zele mail filter delete ${filter.id}`)
    })

  // =========================================================================
  // filter delete
  // =========================================================================

  cli
    .command('mail filter delete <filterId>', 'Delete a Gmail filter by id (see: zele mail filter list)')
    .action(async (filterId, options, ctx) => {
      const out: Output = createOutput(ctx)
      const { email, client } = await getGmailClient(options.account)
      const result = await client.deleteFilter(filterId)
      if (result instanceof Error) out.fail(result)
      out.success(`Deleted filter ${filterId} from ${email}`)
    })
}

/** Label names or ids to ids. Labels to add are created if missing; labels to remove must exist. */
async function resolveLabelIds({ client, labels, create }: { client: GmailClient; labels: string[]; create: boolean }) {
  const ids: string[] = []
  for (const label of labels) {
    const id = create ? await client.resolveLabel(label) : await client.lookupLabel(label)
    if (id instanceof Error) return id
    if (id === null) return new ValidationError({ field: 'label', reason: `no label named "${label}". Run: zele label list` })
    ids.push(id)
  }
  return ids
}
