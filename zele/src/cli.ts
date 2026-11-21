#!/usr/bin/env node

// zele — Gmail CLI built on goke.
// Entry point: registers all commands, global options, help, and version.
// Uses goke for command parsing with zod schemas for type-safe options.
//
// Shebang is `node` so all CLI subcommands work without Bun.
// Only the default TUI command requires Bun (OpenTUI Zig FFI). When
// invoked under Node, the TUI re-spawns itself with `bun` via spawnSync.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { goke } from 'goke'
import { z } from 'zod'
import React from 'react'
import { listAccounts, login } from './auth.js'
import type { ZeleCli } from './cli-types.js'
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
import { registerInboxCommands } from './commands/inbox.js'
import { createMcpAction } from '@goke/mcp'
import { createOutput } from './output.js'
import { closeDb } from './db.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

// Not exposed as MCP tools: interactive auth flows, shell setup, and the
// long-running `mail watch` (agents run it in a background shell instead).
const MCP_EXCLUDED_COMMANDS = /^(login|logout|completions|mail watch)\b/

const cli: ZeleCli = goke('zele').option(
  '--account [account]',
  z.array(z.string()).optional().describe('Filter by email account (repeatable)'),
)

// ---------------------------------------------------------------------------
// Default command (TUI)
// ---------------------------------------------------------------------------

cli.command('', 'Browse emails in TUI').action(async (_options, ctx) => {
  // TODO: Remove bun re-spawn when opentui supports Node.js natively.
  // OpenTUI's Zig renderer requires Bun FFI. When running under Node,
  // re-spawn the same command with bun so the TUI works transparently.
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
  if (!isBun) {
    const { spawnSync } = await import('node:child_process')
    const __filename = fileURLToPath(import.meta.url)
    const result = spawnSync('bun', [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: process.env,
    })
    if (result.error) {
      // bun binary not found
      const { colors } = await import('goke')
      const isWindows = process.platform === 'win32'
      const installCmd = isWindows
        ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
        : 'curl -fsSL https://bun.sh/install | bash'
      console.error(
        colors.red('Error: ') +
          'The TUI requires Bun to run.\n\n' +
          'Install Bun:\n' +
          `  ${colors.cyan(installCmd)}\n\n` +
          'Then run:\n' +
          `  ${colors.cyan('zele')}`,
      )
      process.exit(1)
    }
    // Preserve signal semantics: if the child was killed by a signal,
    // re-raise it so the parent exits with the correct shell status.
    if (result.signal) {
      process.kill(process.pid, result.signal)
      return
    }
    process.exit(result.status ?? 1)
    return
  }

  const accounts = await listAccounts()
  if (accounts.length === 0) {
    const result = await login()
    if (result instanceof Error) createOutput(ctx).fail(result)
  }
  const termcastMod = await import('termcast')
  const mailTuiMod = await import('./mail-tui.js')
  const { renderWithProviders } = termcastMod
  const Command = mailTuiMod.default
  await renderWithProviders(React.createElement(Command), {
    extensionName: 'zele',
  })
})

// ---------------------------------------------------------------------------
// Register all command modules (auth first so login/logout/whoami appear at top of --help)
// ---------------------------------------------------------------------------

registerAuthCommands(cli)
registerInboxCommands(cli)
registerProfileCommands(cli)
registerMailCommands(cli)
registerMailActionCommands(cli)
registerDraftCommands(cli)
registerLabelCommands(cli)
registerAttachmentCommands(cli)
registerCalendarCommands(cli)
registerWatchCommands(cli)
registerFilterCommands(cli)

cli
  .command(
    'mcp',
    'Start an MCP server over stdio. Every zele command becomes a tool, except login, logout, completions and mail watch',
  )
  .example('claude mcp add zele -- zele mcp')
  .action(
    createMcpAction({
      cli,
      serverVersion: version,
      commandFilter: (name) => !MCP_EXCLUDED_COMMANDS.test(name),
    }),
  )

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

cli.help()
cli.completions()
cli.version(version)

// ---------------------------------------------------------------------------
// Parse & run
// ---------------------------------------------------------------------------

void cli.parse().finally(() => closeDb())
