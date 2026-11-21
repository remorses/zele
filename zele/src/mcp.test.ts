// E2E test for `zele mcp`: starts the real stdio server with the MCP SDK client.
// Skipped by default: it reads the real ~/.zele DB and calls Gmail/IMAP. Only
// read-only tools run, on the account you name.
// Run with: ZELE_MCP_E2E_ACCOUNT=you@example.com bunx vitest run src/mcp.test.ts

import path from 'node:path'
import { test as baseTest, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const CLI_PATH = path.resolve(import.meta.dirname, 'cli.ts')
const ACCOUNT = process.env.ZELE_MCP_E2E_ACCOUNT
const TEST_TIMEOUT_MS = 60_000

const test = baseTest.skipIf(!ACCOUNT)

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content.map((block) => block.text ?? '').join('')
}

test('zele mcp lists commands as tools and runs them', { timeout: TEST_TIMEOUT_MS }, async () => {
  const transport = new StdioClientTransport({ command: 'bun', args: [CLI_PATH, 'mcp'], stderr: 'pipe' })
  const client = new Client({ name: 'zele-mcp-e2e', version: '0.0.0' })
  // any non-JSON-RPC line on the server's stdout shows up here as a parse error
  const protocolErrors: string[] = []
  client.onerror = (error) => protocolErrors.push(error.message)
  await client.connect(transport)

  try {
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)
    expect(names).toContain('mail_list')
    expect(names).toContain('whoami')
    for (const excluded of ['login', 'logout', 'mail_watch', 'mcp']) expect(names).not.toContain(excluded)

    const mailList = tools.find((tool) => tool.name === 'mail_list')!
    expect(Object.keys(mailList.inputSchema.properties ?? {})).toContain('account')

    const list = await client.callTool({ name: 'mail_list', arguments: { account: [ACCOUNT], limit: '1' } })
    expect(list.isError).toBeFalsy()
    expect(textOf(list)).toContain('items:')

    // stdin is the JSON-RPC channel: refused before any account is touched
    const stdinBody = await client.callTool({
      name: 'draft_create',
      arguments: { account: [ACCOUNT], to: 'nobody@example.com', subject: 'zele mcp e2e', bodyFile: '-' },
    })
    expect(stdinBody.isError).toBe(true)
    expect(textOf(stdinBody).trim()).toMatchInlineSnapshot(`"bodyFile "-" reads stdin, which is the MCP channel. Pass body instead"`)

    // the server survives a failed tool call
    const whoami = await client.callTool({ name: 'whoami', arguments: {} })
    expect(whoami.isError).toBeFalsy()
    expect(textOf(whoami)).toContain(ACCOUNT)

    expect(protocolErrors).toEqual([])
  } finally {
    await client.close()
  }
})
