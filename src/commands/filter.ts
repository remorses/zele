// Filter commands: list, create, delete Gmail filters.
// Multi-account support via getClients/getClient like label.ts.

import type { Goke } from 'goke'
import { z } from 'zod'
import { getClients, getClient } from '../auth.js'
import { AuthError } from '../api-utils.js'
import * as out from '../output.js'

export function registerFilterCommands(cli: Goke) {
  // =========================================================================
  // filter list
  // =========================================================================

  cli
    .command('filter list', 'List all Gmail filters')
    .action(async (options) => {
      const clients = await getClients(options.account)

      const results = await Promise.all(
        clients.map(async ({ email, client }) => {
          const res = await client.listFilters()
          if (res instanceof Error) return res
          return { email, filters: res.parsed }
        }),
      )

      const allResults = results.filter((r): r is Exclude<typeof r, Error> => {
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

  cli
    .command('filter create', 'Create a Gmail filter')
    .option('--from <from>', z.string().describe('Match sender address'))
    .option('--query <query>', z.string().describe('Match query string'))
    .option('--label <label>', z.string().describe('Apply label (created if missing)'))
    .option('--skip-inbox', z.boolean().default(true).describe('Skip inbox (default: true)'))
    .option('--never-spam', z.boolean().default(true).describe('Never mark as spam (default: true)'))
    .option('--mark-important', z.boolean().default(true).describe('Mark as important (default: true)'))
    .action(async (options) => {
      if (!options.from && !options.query) {
        out.error('At least one of --from or --query is required')
        process.exit(1)
      }

      const { client } = await getClient(options.account)

      const addLabelIds: string[] = []
      const removeLabelIds: string[] = []

      // Resolve label name → ID
      if (options.label) {
        const labelId = await client.resolveLabel(options.label)
        if (labelId instanceof Error) {
          out.error(`Failed to resolve label "${options.label}": ${labelId.message}`)
          process.exit(1)
        }
        addLabelIds.push(labelId)
      }

      if (options.skipInbox) removeLabelIds.push('INBOX')
      if (options.neverSpam) removeLabelIds.push('SPAM')
      if (options.markImportant) addLabelIds.push('IMPORTANT')

      const result = await client.createFilter({
        from: options.from,
        query: options.query,
        addLabelIds: addLabelIds.length ? addLabelIds : undefined,
        removeLabelIds: removeLabelIds.length ? removeLabelIds : undefined,
      })

      if (result instanceof Error) {
        out.error(`Failed to create filter: ${result.message}`)
        process.exit(1)
      }

      out.printYaml({
        id: result.id,
        criteria: result.criteria,
        action: result.action,
      })
      out.success('Filter created')
    })

  // =========================================================================
  // filter delete
  // =========================================================================

  cli
    .command('filter delete <filterId>', 'Delete a Gmail filter')
    .option('--force', 'Skip confirmation')
    .action(async (filterId, options) => {
      if (!options.force && process.stdin.isTTY) {
        const readline = await import('node:readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Delete filter ${filterId}? [y/N] `, resolve)
        })
        rl.close()

        if (answer.toLowerCase() !== 'y') {
          out.hint('Cancelled')
          return
        }
      }

      const { client } = await getClient(options.account)
      const result = await client.deleteFilter(filterId)

      if (result instanceof Error) {
        out.error(`Failed to delete filter: ${result.message}`)
        process.exit(1)
      }

      out.printYaml({ filter_id: filterId, deleted: true })
    })
}
