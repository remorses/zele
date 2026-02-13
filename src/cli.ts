#!/usr/bin/env node

// zele — Gmail CLI built on goke.
// Entry point: registers all commands, global options, help, and version.
// Uses goke for command parsing with zod schemas for type-safe options.

import { goke } from 'goke'
import { z } from 'zod'
import React from 'react'
import { listAccounts, login } from './auth.js'
import { registerAuthCommands } from './commands/auth-cmd.js'
import { registerMailCommands } from './commands/mail.js'
import { registerMailActionCommands } from './commands/mail-actions.js'
import { registerDraftCommands } from './commands/draft.js'
import { registerLabelCommands } from './commands/label.js'
import { registerAttachmentCommands } from './commands/attachment.js'
import { registerProfileCommands } from './commands/profile.js'
import { registerCalendarCommands } from './commands/calendar.js'
import { registerWatchCommands } from './commands/watch.js'
import { registerFilterCommands } from './commands/filter.js'
import { handleCommandError } from './output.js'

const cli = goke('zele')

// ---------------------------------------------------------------------------
// Global options
// ---------------------------------------------------------------------------

cli.option(
  '--account <account>',
  z.array(z.string()).describe('Filter by email account (repeatable)'),
)

// ---------------------------------------------------------------------------
// Default command (TUI)
// ---------------------------------------------------------------------------

cli
  .command('', 'Browse emails in TUI')
  .action(async () => {
    if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
      const pc = await import('picocolors')
      const isWindows = process.platform === 'win32'
      const installCmd = isWindows
        ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
        : 'curl -fsSL https://bun.sh/install | bash'
      console.error(
        pc.default.red('Error: ') +
          'The TUI requires Bun to run.\n\n' +
          'Install Bun:\n' +
          `  ${pc.default.cyan(installCmd)}\n\n` +
          'Then run:\n' +
          `  ${pc.default.cyan('zele')}`,
      )
      process.exit(1)
    }

    const accounts = await listAccounts()
    if (accounts.length === 0) {
      const result = await login()
      if (result instanceof Error) handleCommandError(result)
    }

    const { renderWithProviders } = await import('termcast')
    const { default: Command } = await import('./mail-tui.js')
    await renderWithProviders(React.createElement(Command))
  })

// ---------------------------------------------------------------------------
// Register all command modules (auth first so login/logout/whoami appear at top of --help)
// ---------------------------------------------------------------------------

registerAuthCommands(cli)
registerProfileCommands(cli)
registerMailCommands(cli)
registerMailActionCommands(cli)
registerDraftCommands(cli)
registerLabelCommands(cli)
registerAttachmentCommands(cli)
registerCalendarCommands(cli)
registerWatchCommands(cli)
registerFilterCommands(cli)

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

cli.help()
cli.version('0.3.13')

// ---------------------------------------------------------------------------
// Parse & run
// ---------------------------------------------------------------------------

cli.parse()
