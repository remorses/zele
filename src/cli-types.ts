// Shared goke type for the zele CLI, including the global options declared
// on the root `goke('zele')` instance. Living in its own file avoids the
// circular import that would arise from command modules importing from
// `./cli.js` (which itself imports every command module).

import type { Goke } from 'goke'

export type ZeleCli = Goke<{ account?: string[] }>
