// Mail action commands: star, unstar, archive, trash, untrash, mark read/unread, spam, unspam, label modify.
// Bulk operations on threads — cache invalidation is handled by the client methods.

import type { ZeleCli } from '../cli-types.js'
import { z } from 'zod'
import { getClient } from '../auth.js'
import type { GmailClient } from '../gmail-client.js'
import type { ImapSmtpClient } from '../imap-smtp-client.js'
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
}
