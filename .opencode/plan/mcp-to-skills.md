# Plan: MCP to Claude Skills Generator

## Overview

Extend `mcpcode` to generate Claude Code/OpenCode compatible Skills from MCP server tool discovery. Each skill is a **self-contained folder** with the SKILL.md discovery file plus executable TypeScript tool wrappers.

---

## Background Research (Updated based on Official Claude Code Docs)

### What are Claude Code Skills?

Skills are markdown files that teach Claude how to do something specific. They are **model-invoked** - Claude decides which Skills to use based on your request.

**Official Skill Structure (from Claude Code docs):**
```
.claude/skills/<skill-name>/
├── SKILL.md              # Required - YAML frontmatter + markdown instructions
├── index.ts              # Exports all actions (our addition)
├── lib/                  # Shared utilities for this skill
│   └── client.ts         # MCP client wrapper
└── actions/              # Tool wrapper functions
    ├── toolOne.ts
    └── toolTwo.ts
```

**SKILL.md Format (from Claude Code docs):**
```markdown
---
name: skill-name
description: What the skill does and when to use it (max 1024 chars)
allowed-tools: Read, Bash(python:*)   # optional - restrict tools
model: claude-sonnet-4-20250514       # optional
context: fork                         # optional - run in sub-agent
---

# Skill Title

## Instructions
Clear step-by-step guidance for Claude.

## Examples
Concrete usage examples.
```

**YAML Frontmatter Fields:**
| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase, hyphens, max 64 chars. Must match directory name |
| `description` | Yes | What it does and when to use it (max 1024 chars) |
| `allowed-tools` | No | Restrict which tools Claude can use |
| `model` | No | Specific model to use |
| `context` | No | Set to `fork` for isolated sub-agent context |
| `hooks` | No | Define PreToolUse, PostToolUse, Stop handlers |
| `user-invocable` | No | Show in slash menu (default: true) |

**Skill Locations:**
- Project: `.claude/skills/<name>/SKILL.md`
- Personal: `~/.claude/skills/<name>/SKILL.md`
- Enterprise: Managed settings
- Plugin: Bundled with plugins

**Naming Rules:**
- 1-64 characters
- Lowercase alphanumeric with single hyphen separators  
- Pattern: `^[a-z0-9]+(-[a-z0-9]+)*$`
- Directory name MUST match `name` in frontmatter

---

## Architecture Design

### Generated Output Structure

```
.claude/skills/
├── mcp-context7/                    # Per-server skill (self-contained)
│   ├── SKILL.md                     # Discovery + documentation
│   ├── index.ts                     # Exports all actions
│   ├── lib/
│   │   └── client.ts                # MCP runtime client for this skill
│   └── actions/
│       ├── resolveLibraryId.ts      # Tool wrapper
│       └── getLibraryDocs.ts        # Tool wrapper
├── mcp-github/
│   ├── SKILL.md
│   ├── index.ts
│   ├── lib/
│   │   └── client.ts
│   └── actions/
│       ├── createIssue.ts
│       └── listRepos.ts
└── mcp-tools-index/                 # Master index skill
    └── SKILL.md
```

### CLI Commands

```bash
# Generate skills from MCP config
mcpcode skills [-c mcp.config.json] [-o .claude/skills/] [--clean]

# Options:
#   -c, --config <path>     Path to MCP config file (default: mcp.config.json)
#   -o, --output <path>     Output directory (default: .claude/skills/)
#   --clean                 Remove existing MCP skills before generation
```

---

## Implementation Plan

### Phase 1: Core Skill Generator

#### 1.1 Create SkillGenerator Class

**File: `src/generator/skillGenerator.ts`**

```typescript
export interface SkillGenerationOptions {
  outputDir: string;
  claudeCompatible: boolean;
  perTool: boolean;
}

export class SkillGenerator {
  async generateAll(
    toolsByServer: Map<string, DiscoveredTool[]>,
    options: SkillGenerationOptions
  ): Promise<void>;
  
  async generateServerSkill(
    serverName: string,
    tools: DiscoveredTool[]
  ): Promise<void>;
  
  async generateToolSkill(
    serverName: string,
    tool: DiscoveredTool
  ): Promise<void>;
  
  async generateIndexSkill(
    toolsByServer: Map<string, DiscoveredTool[]>
  ): Promise<void>;
}
```

#### 1.2 Skill Name Normalization

Convert MCP server/tool names to valid skill names:

```typescript
function toSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-')
    .slice(0, 64);
}

// Examples:
// "context7" -> "mcp-context7"
// "My_Server" -> "mcp-my-server"
// "resolve-library-id" -> "mcp-context7-resolve-library-id"
```

#### 1.3 SKILL.md Template

**Per-Server Skill Template:**
```markdown
---
name: mcp-${serverName}
description: MCP tools for ${serverName}: ${toolSummary}
license: MIT
compatibility: opencode
metadata:
  type: mcp-server
  server: ${serverName}
  tool-count: ${toolCount}
---

# ${serverName} MCP Tools

${serverDescription}

## Available Tools

${toolsList}

## Usage

To use these tools, edit `servers/run.ts` and call:

\`\`\`typescript
import * as ${camelCaseName} from './servers/${serverName}/index.js';

// ${firstTool.name}
const result = await ${camelCaseName}.${firstToolFn}({
  ${exampleParams}
});
\`\`\`

## Tool Reference

${detailedToolDocs}
```

### Phase 2: CLI Integration

#### 2.1 Add `skills` Command

**File: `src/cli.ts`**

```typescript
program
  .command('skills')
  .description('Generate Claude/OpenCode skills from MCP server configurations')
  .option('-c, --config <path>', 'Path to MCP config file', 'mcp.config.json')
  .option('-o, --output <path>', 'Output directory', '.opencode/skill/')
  .option('--claude', 'Also generate to .claude/skills/ for Claude compatibility')
  .option('--per-tool', 'Generate individual skill per tool')
  .option('--clean', 'Remove existing MCP skills before generation')
  .action(async (options) => {
    // Implementation
  });
```

#### 2.2 Integration with `generate` Command

Add option to generate skills alongside TypeScript code:

```bash
mcpcode generate --with-skills
```

### Phase 3: Package Distribution

#### 3.1 Programmatic API

**File: `src/index.ts`** - Add exports:

```typescript
export { SkillGenerator, type SkillGenerationOptions } from './generator/skillGenerator.js';
```

This allows users to:
```typescript
import { SkillGenerator, ToolDiscovery, ConfigParser } from '@abmalk/mcpcode';

const config = await ConfigParser.parseConfig('mcp.config.json');
const discovery = new ToolDiscovery(config);
const results = await discovery.discoverAll();
const tools = ToolDiscovery.flattenTools(results);
const toolsByServer = CodeGenerator.groupToolsByServer(tools);

const skillGen = new SkillGenerator();
await skillGen.generateAll(toolsByServer, {
  outputDir: '.opencode/skill/',
  claudeCompatible: true,
  perTool: false
});
```

---

## Generated Skill Examples

### Example 1: Server-Level Skill

**`.opencode/skill/mcp-context7/SKILL.md`**

```markdown
---
name: mcp-context7
description: MCP tools for context7 - resolve library IDs and fetch documentation for npm packages
license: MIT
compatibility: opencode
metadata:
  type: mcp-server
  server: context7
  tool-count: "2"
---

# context7 MCP Tools

Access library documentation and resolve package identifiers.

## Available Tools

| Tool | Description |
|------|-------------|
| `resolveLibraryId` | Resolve a library name to its context7 compatible ID |
| `getLibraryDocs` | Fetch documentation for a library by its context7 ID |

## Quick Usage

```typescript
import * as context7 from './servers/context7/index.js';

// Resolve a library ID
const libId = await context7.resolveLibraryId({
  libraryName: "react"
});

// Get documentation
const docs = await context7.getLibraryDocs({
  context7CompatibleLibraryID: "/facebook/react",
  topic: "hooks"
});
```

## Tool Reference

### resolveLibraryId

Resolve a library name to its context7 compatible ID.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `libraryName` | string | Yes | The name of the library to resolve |

**Returns:** Library ID string or error message.

---

### getLibraryDocs

Fetch documentation for a library by its context7 ID.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `context7CompatibleLibraryID` | string | Yes | The context7 compatible library ID |
| `topic` | string | No | Specific topic to focus documentation on |

**Returns:** Documentation content.
```

### Example 2: Index Skill

**`.opencode/skill/mcp-tools-index/SKILL.md`**

```markdown
---
name: mcp-tools-index
description: Index of all available MCP server tools and how to use them
license: MIT
compatibility: opencode
metadata:
  type: mcp-index
  server-count: "2"
  tool-count: "5"
---

# MCP Tools Index

This project has MCP server integrations available. Use this skill to discover available tools.

## Available Servers

| Server | Tools | Description |
|--------|-------|-------------|
| `context7` | 2 | Library documentation and resolution |
| `github` | 3 | GitHub repository operations |

## How to Use MCP Tools

1. Load the specific server skill for detailed documentation:
   - `skill({ name: "mcp-context7" })`
   - `skill({ name: "mcp-github" })`

2. Edit `servers/run.ts` with your tool calls

3. Execute: `npx tsx servers/run.ts`

## Quick Reference

### context7
- `resolveLibraryId` - Resolve library names to IDs
- `getLibraryDocs` - Fetch library documentation

### github
- `createIssue` - Create a new issue
- `listPRs` - List pull requests
- `getFileContents` - Get file contents from a repo
```

---

## File Structure After Implementation

```
src/
├── cli.ts                          # Add 'skills' command
├── index.ts                        # Export SkillGenerator
├── generator/
│   ├── codeGenerator.ts            # Existing
│   ├── typeGenerator.ts            # Existing
│   └── skillGenerator.ts           # NEW: Skill generation logic
└── templates/                      # NEW: Template files
    ├── serverSkill.ts              # Server skill template
    ├── toolSkill.ts                # Tool skill template
    └── indexSkill.ts               # Index skill template
```

---

## Task Breakdown

### Must Have (MVP)
1. [ ] Create `SkillGenerator` class with server-level skill generation
2. [ ] Add `skills` CLI command
3. [ ] Generate valid SKILL.md files with proper frontmatter
4. [ ] Support `--claude` flag for `.claude/skills/` output
5. [ ] Export `SkillGenerator` from package for programmatic use
6. [ ] Update README with skills documentation

### Should Have
7. [ ] Generate master index skill (`mcp-tools-index`)
8. [ ] Add `--per-tool` option for granular skill generation
9. [ ] Add `--with-skills` option to `generate` command
10. [ ] Include input schema documentation in skills
11. [ ] Add `--clean` to remove stale skills

### Nice to Have
12. [ ] Watch mode for skill regeneration
13. [ ] Custom skill templates via config
14. [ ] Skill permission suggestions in output
15. [ ] Validation command to check existing skills

---

## Testing Strategy

1. **Unit Tests:**
   - Skill name normalization
   - Frontmatter generation
   - Template rendering

2. **Integration Tests:**
   - Generate skills from test MCP config
   - Verify file structure
   - Validate YAML frontmatter

3. **Manual Testing:**
   - Use generated skills with OpenCode
   - Verify agent discovery works
   - Test Claude compatibility

---

## Questions for User

1. **Default output location:** Should skills go to `.opencode/skill/` by default, or should we default to a `skills/` directory that users can then move/symlink?

2. **Per-tool granularity:** Should we generate one skill per tool by default, or one skill per server? (Server-level is more token-efficient for discovery)

3. **Claude vs OpenCode:** Should we generate to both `.claude/skills/` and `.opencode/skill/` by default, or require the `--claude` flag?

4. **Skill naming:** Prefix with `mcp-` (e.g., `mcp-context7`) to distinguish from other skills, or use server names directly?

5. **Watch mode:** Should `mcpcode watch` also regenerate skills, or keep that separate?

---

## Timeline Estimate

| Phase | Tasks | Estimate |
|-------|-------|----------|
| Phase 1 | Core SkillGenerator | 2-3 hours |
| Phase 2 | CLI Integration | 1 hour |
| Phase 3 | Package/API Updates | 30 mins |
| Testing | Unit + Integration | 1-2 hours |
| Documentation | README updates | 30 mins |

**Total: ~5-7 hours**
