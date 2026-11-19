---
'zele': minor
---

New `zele mcp` command starts an MCP server over stdio. Every zele command is a tool with the same options (`mail list` is `mail_list`, `cal events` is `cal_events`), plus an `account` argument like `--account`. The tool result is the text the CLI prints (YAML for structured output). `login`, `logout`, `completions` and `mail watch` are not tools.

```bash
claude mcp add zele -- npx -y zele mcp
```

In MCP, pass email text with `body`. `bodyFile: "-"` is refused because stdin is the MCP channel.
