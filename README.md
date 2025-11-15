# MCP Code Generator

Generate type-safe TypeScript wrappers for Model Context Protocol (MCP) tools. Connects to MCP servers via STDIO or HTTP, discovers tools automatically, and generates clean, type-safe code.

## Features

- 🔍 **Auto-discovery** - Connects to MCP servers and discovers all available tools
- 🎯 **Type-safe** - Generates TypeScript interfaces from JSON schemas
- 📦 **Clean structure** - Organized, deterministic folder structure
- 🔒 **Secure STDIO** - Hardened STDIO transport with strict validation
- 👀 **Watch mode** - Auto-regenerate on config changes
- 🎨 **Beautiful CLI** - Colorful output with progress indicators

## Installation

```bash
npm install -g @abmalk/mcpcode
```

### Run Without Installing

```bash
npx @abmalk/mcpcode generate
```

## Usage

### Generate Once

```bash
mcpcode generate
mcpcode generate --config my-config.json --output generated/
```

### Watch Mode

```bash
mcpcode watch
mcpcode watch --debounce 2000
```

### Options

- `-c, --config <path>` - Config file path (default: `mcp.config.json`)
- `-o, --output <path>` - Output directory (default: `servers/`)
- `-d, --debounce <ms>` - Watch debounce delay (default: `1000`)

## Configuration

Create `mcp.config.json`:

```json
{
  "mcpServers": {
    "git": {
      "command": "uvx",
      "args": ["mcp-server-git", "--repository", "."]
    },
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

### STDIO Servers

```json
{
  "command": "uvx",
  "args": ["mcp-server-name"]
}
```

## Generated Code

```
servers/
├── client.ts          # Runtime client
├── git/
│   ├── getFile.ts    # Individual tools
│   ├── listFiles.ts
│   └── index.ts      # Exports
└── fetch/
    ├── fetch.ts
    └── index.ts
```

### Example Tool

```typescript
import { callMCPTool } from "../client.js";

export interface GetFileInput {
  path: string;
  ref?: string;
}

export interface GetFileResponse {
  content: string;
}

export async function getFile(input: GetFileInput): Promise<GetFileResponse> {
  return callMCPTool<GetFileResponse>("git", "getFile", input);
}
```

## Using Generated Code

```typescript
import { initializeMCPRuntime, closeMCPRuntime } from "./servers/client.js";
import * as git from "./servers/git/index.js";

await initializeMCPRuntime("mcp.config.json");

const file = await git.getFile({ path: "README.md" });
console.log(file.content);

await closeMCPRuntime();
```

## Benefits

Based on [Anthropic's research](https://www.anthropic.com/research/building-effective-agents):

- **98.7% token reduction** - Load tools on-demand vs upfront
- **Context efficient** - Process data in code before returning to model
- **Better control flow** - Use familiar programming constructs
- **Privacy** - Intermediate results stay in execution environment

## Security Considerations

- **Transport Hardening** – Only STDIO connections are supported. Commands and arguments are validated for control characters, directory traversal, and length limits before execution.
- **Executable Safety** – Commands must exist on disk or resolve within the current `PATH`. Relative paths must be explicit (e.g. `./bin/server`).
- **Resource Guardrails** – MCP clients enforce connection timeouts, concurrency limits, and graceful shutdown to prevent runaway processes.
- **Safe Code Generation** – Generated filenames and identifiers are sanitized to avoid filesystem traversal and injection risks. All generated runtime helpers use strict TypeScript types (no `any`).
- **Robust Error Handling** – Dedicated error classes (`ConfigError`, `ConnectionError`, `GenerationError`) provide precise failure messages while guaranteeing cleanup on failure.

## License

ISC
