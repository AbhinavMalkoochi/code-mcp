# MCP Code Generator

Generate type-safe TypeScript functions for your MCP tools. Instead of loading all tool definitions into your agent's context, generate code that your agent can import and use on-demand. Reduce your tool context by 98.7% compared to traditional MCP usage.

## Quick Start

Install the CLI tool:

```bash
npm install -g @abmalk/mcpcode
```

Create a config file `mcp.config.json` in your project:

```json
{
  "mcpServers": {
    "git": {
      "command": "uvx",
      "args": ["mcp-server-git", "--repository", "."]
    }
  }
}
```

Generate the code:

```bash
mcpcode generate
```

That's it. You'll find TypeScript functions in the `servers/` directory, ready to use.

## Configuration

The config file tells the generator which MCP servers to connect to. Each server needs a command and optional arguments:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "uvx",
      "args": ["mcp-server-name"]
    }
  }
}
```

Server names can contain letters, numbers, dots, dashes, and underscores. They become the folder names in your generated code.

### Environment Variables

Pass environment variables to MCP servers using the `env` field. Use `${VAR_NAME}` to reference environment variables:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

### HTTP/SSE Transport

For web-based MCP servers, use `type: "http"` or `type: "sse"`:

```json
{
  "mcpServers": {
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/api",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    }
  }
}
```

### Relative Paths (STDIO)

For local STDIO servers with relative paths:

```json
{
  "mcpServers": {
    "local": {
      "command": "./bin/my-server",
      "args": []
    }
  }
}
```

## CLI Options

Generate code once:

```bash
mcpcode generate
mcpcode generate --config my-config.json --output generated/
mcpcode generate --clean  # Remove output directory before generation
```

Generate Claude Code skills (self-contained skill folders with TypeScript tools):

```bash
mcpcode skills
mcpcode skills --config my-config.json --output .claude/skills/
mcpcode skills --clean  # Remove existing MCP skills before generation
```

Watch for config changes and auto-regenerate:

```bash
mcpcode watch
mcpcode watch --debounce 2000
```

Available options:

- `-c, --config <path>` - Path to config file (default: `mcp.config.json`)
- `-o, --output <path>` - Output directory (default: `servers/` for generate, `.claude/skills/` for skills)
- `--clean` - Remove output directory before generation
- `-d, --debounce <ms>` - Watch debounce delay (100-60000ms, default: `1000`)

## Claude Code Skills

The `skills` command generates self-contained Claude Code skills from your MCP servers. Each skill folder includes:

```
.claude/skills/
├── mcp-context7/
│   ├── SKILL.md              # Discovery + documentation (YAML frontmatter)
│   ├── index.ts              # Exports all actions
│   ├── lib/
│   │   └── client.ts         # MCP client wrapper
│   └── actions/
│       ├── resolveLibraryId.ts
│       └── getLibraryDocs.ts
└── mcp-tools-index/
    └── SKILL.md              # Master index of all MCP tools
```

### How Skills Work

Claude Code automatically discovers skills in `.claude/skills/`. When you ask Claude something that matches a skill's description, it loads and uses the skill.

**Run tools directly:**

```bash
npx tsx .claude/skills/mcp-context7/actions/resolveLibraryId.ts '{"query":"react hooks","libraryName":"react"}'
```

**Import in your code:**

```typescript
import { resolveLibraryId } from './.claude/skills/mcp-context7/index.js';

const result = await resolveLibraryId({
  query: "react hooks",
  libraryName: "react"
});
```

### SKILL.md Format

Each skill has a `SKILL.md` file with YAML frontmatter that Claude Code uses for discovery:

```markdown
---
name: mcp-context7
description: MCP tools for context7 - resolve library IDs and fetch documentation
allowed-tools: Read, Bash(npx:*, node:*, tsx:*)
---

# context7 MCP Tools

[Documentation and usage examples...]
```

## Run Without Installing

You can use npx to run it without installing:

```bash
npx @abmalk/mcpcode generate
```

## Why Use This?

When you connect an agent to many MCP servers, loading all tool definitions upfront can consume a lot of tokens. This approach lets your agent:

- Load tools on-demand by importing only what it needs
- Process data in code before sending results back to the model
- Use familiar programming constructs like loops and conditionals
- Keep intermediate results private (they stay in the execution environment)

Research from Anthropic shows this can reduce token usage by up to 98.7% compared to loading all tools upfront.

## Tool Discovery

A `search.ts` file is generated with utilities for agents to discover tools:

```typescript
import { searchTools, listServers, listTools } from "./servers/search.js";

// Search by keyword
const gitTools = searchTools("commit");

// List all servers
const servers = listServers();

// List tools for a server
const tools = listTools("git");
```

## IDE Integration

For AI coding assistants (Cursor, Claude Code, etc.), mcpcode automatically generates:

- `.cursor/rules/mcpcode.mdc` - Rules file that instructs the LLM
- `servers/run.ts` - A reusable runner file for executing MCP tools

### How Agents Should Use MCP Tools

The generated `servers/run.ts` file is the correct way to execute MCP tools:

1. **Discover** tools using `listServers()`, `listTools()`, `searchTools()`
2. **Edit** `servers/run.ts` - modify the `runTask()` function
3. **Run** `npx tsx servers/run.ts` - execute the tools

```typescript
// In servers/run.ts, edit runTask():
async function runTask() {
  // Discover tools (no need to read files manually)
  console.log(listServers()); // ["context7", "github", ...]
  console.log(listTools("context7")); // [{ name, description }]
  console.log(searchTools("docs")); // Find tools by keyword

  // Call tools
  const result = await servers.context7.resolveLibraryId({
    libraryName: "react",
  });
  console.log(result);
}
```

### Recommended Agent Prompt

Add this to your system prompt or user rules:

```
MCP Tool Usage Rules:
1. To call MCP tools, EDIT the file servers/run.ts
2. Use discovery functions to find tools (don't read files manually):
   - listServers() → list all server names
   - listTools("serverName") → list tools with descriptions
   - searchTools("keyword") → find tools by keyword
3. Call tools via: servers.serverName.toolName({ params })
4. Run with: npx tsx servers/run.ts
5. NEVER create new .mjs, .js, or .ts files
6. NEVER import MCPClient or read individual tool files

Example - edit servers/run.ts:
  async function runTask() {
    // Discover
    console.log(searchTools("library"));
    // Call
    const result = await servers.context7.getLibraryDocs({ ... });
    console.log(result);
  }

Then run: npx tsx servers/run.ts
```

## Supported Transports

- **STDIO** (default): Local process communication
- **HTTP**: StreamableHTTP for modern MCP servers
- **SSE**: Server-Sent Events for legacy servers

## License

MIT
