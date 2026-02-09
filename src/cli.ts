#!/usr/bin/env node

// zele — Gmail CLI built on goke.
// Entry point: registers all commands, global options, help, and version.
// Uses goke for command parsing with zod schemas for type-safe options.

import { goke } from 'goke'
import { z } from 'zod'
import { registerAuthCommands } from './commands/auth-cmd.js'
import { registerMailCommands } from './commands/mail.js'
import { registerMailActionCommands } from './commands/mail-actions.js'
import { registerDraftCommands } from './commands/draft.js'
import { registerLabelCommands } from './commands/label.js'
import { registerAttachmentCommands } from './commands/attachment.js'
import { registerProfileCommands } from './commands/profile.js'

const cli = goke('zele')

// ---------------------------------------------------------------------------
// Global options
// ---------------------------------------------------------------------------

cli.option(
  '--account <account>',
  z.array(z.string()).describe('Filter by email account (repeatable)'),
)

// ---------------------------------------------------------------------------
// Register all command modules
// ---------------------------------------------------------------------------

registerAuthCommands(cli)
registerMailCommands(cli)
registerMailActionCommands(cli)
registerDraftCommands(cli)
registerLabelCommands(cli)
registerAttachmentCommands(cli)
registerProfileCommands(cli)

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

cli.help()
cli.version('0.1.3')

// ---------------------------------------------------------------------------
// Parse & run
// ---------------------------------------------------------------------------

cli.parse()
