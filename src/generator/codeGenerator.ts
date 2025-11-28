import { mkdir, writeFile, readFile, readdir, rm, appendFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { TypeGenerator } from "./typeGenerator.js";
import type { DiscoveredTool } from "../discovery/toolDiscovery.js";
import chalk from "chalk";
import { GenerationError } from "../errors.js";

export interface GenerationOptions {
  outputDir: string;
  serverName: string;
  tools: DiscoveredTool[];
}

export class CodeGenerator {
  private typeGen: TypeGenerator;

  constructor() {
    this.typeGen = new TypeGenerator();
  }

  async generateAll(
    outputDir: string,
    toolsByServer: Map<string, DiscoveredTool[]>
  ): Promise<void> {
    console.log(chalk.blue("\nGenerating TypeScript code...\n"));

    // Create output directory if it doesn't exist
    await this.ensureDir(outputDir);

    // Clean up stale server directories before generating new code
    const currentServers = new Set(toolsByServer.keys());
    await this.cleanupStaleServers(outputDir, currentServers);

    // Generate code for each server
    for (const [serverName, tools] of toolsByServer.entries()) {
      await this.generateServer(outputDir, serverName, tools);
    }

    // Generate the root client file that will be used by all generated code
    await this.generateRuntimeClient(outputDir);

    // Generate search file for tool discovery
    await this.generateSearchFile(outputDir, toolsByServer);

    // Generate cursor rules file for IDE integration
    await this.generateCursorRules(outputDir, toolsByServer);

    // Update .gitignore to exclude generated servers folder
    await this.updateGitignore(outputDir);

    console.log(chalk.green("\n✓ Code generation complete!\n"));
  }

  async cleanupStaleServers(
    outputDir: string,
    currentServers: Set<string>
  ): Promise<void> {
    if (!existsSync(outputDir)) {
      return;
    }

    try {
      const entries = await readdir(outputDir, { withFileTypes: true });
      const reservedFiles = new Set(["client.ts", "search.ts"]);

      for (const entry of entries) {
        if (entry.isDirectory() && !currentServers.has(entry.name)) {
          const serverPath = join(outputDir, entry.name);
          await rm(serverPath, { recursive: true, force: true });
          console.log(chalk.yellow(`🗑  Removed stale server: ${entry.name}`));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        chalk.yellow(`Warning: Failed to cleanup stale servers: ${message}`)
      );
    }
  }

  async generateServer(
    outputDir: string,
    serverName: string,
    tools: DiscoveredTool[]
  ): Promise<void> {
    const serverDir = join(outputDir, serverName);
    await this.ensureDir(serverDir);

    console.log(chalk.cyan(`Generating code for server: ${serverName}`));

    // Generate individual tool files
    const toolFiles: string[] = [];
    for (const tool of tools) {
      const fileName = await this.generateToolFile(serverDir, serverName, tool);
      toolFiles.push(fileName);
      console.log(chalk.gray(`  - ${fileName}`));
    }

    // Generate index file
    await this.generateIndexFile(serverDir, toolFiles);
    console.log(
      chalk.green(`✓ Generated ${tools.length} tool(s) for ${serverName}`)
    );
  }

  async generateToolFile(
    serverDir: string,
    serverName: string,
    tool: DiscoveredTool
  ): Promise<string> {
    const normalizedName = CodeGenerator.normalizeName(tool.name);
    const fileBaseName = TypeGenerator.toCamelCase(normalizedName) || "tool";
    const fileName = `${fileBaseName}.ts`;
    const filePath = join(serverDir, fileName);

    const functionName = TypeGenerator.toCamelCase(normalizedName) || "tool";
    const inputInterfaceName = `${TypeGenerator.toPascalCase(
      normalizedName
    )}Input`;
    const responseInterfaceName = `${TypeGenerator.toPascalCase(
      normalizedName
    )}Response`;

    // Generate input interface using normalized name for consistency
    const inputInterface = this.typeGen.generateInputInterface(
      normalizedName,
      tool.inputSchema
    );

    // Generate response interface using normalized name for consistency
    const responseInterface =
      this.typeGen.generateResponseInterface(normalizedName);

    // Generate function
    const description = tool.description
      ? `/** ${tool.description} */`
      : `/** ${tool.name} */`;

    const code = `import { callMCPTool } from "../client.js";

${inputInterface}

${responseInterface}

${description}
export async function ${functionName}(input: ${inputInterfaceName}): Promise<${responseInterfaceName}> {
  return callMCPTool<${responseInterfaceName}>(${JSON.stringify(
      serverName
    )}, ${JSON.stringify(tool.name)}, input);
}
`;

    await this.writeFileSafe(filePath, code);
    return fileName;
  }

  async generateIndexFile(
    serverDir: string,
    toolFiles: string[]
  ): Promise<void> {
    const filePath = join(serverDir, "index.ts");

    const exports = toolFiles
      .map((fileName) => {
        const moduleName = fileName.replace(".ts", ".js");
        return `export * from './${moduleName}';`;
      })
      .join("\n");

    await this.writeFileSafe(filePath, `${exports}\n`);
  }

  async generateRuntimeClient(outputDir: string): Promise<void> {
    const clientPath = join(outputDir, "client.ts");

    const clientCode = `import { MCPClient, ConfigParser, ConnectionError } from "@abmalk/mcpcode";

// Global registry of MCP clients
const clientRegistry = new Map<string, MCPClient>();
let isInitialized = false;

/**
 * Initialize the MCP runtime with the config file
 */
export async function initializeMCPRuntime(configPath: string = "mcp.config.json"): Promise<void> {
  if (isInitialized) {
    return;
  }

  const config = await ConfigParser.parseConfig(configPath);
  const initializedClients: Array<[string, MCPClient]> = [];

  try {
    // Initialize clients for all servers
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      if (clientRegistry.has(serverName)) {
        continue;
      }
      const client = new MCPClient(serverName);
      await client.connect(serverConfig);
      clientRegistry.set(serverName, client);
      initializedClients.push([serverName, client]);
    }

    isInitialized = true;
  } catch (error) {
    await Promise.all(
      initializedClients.map(async ([name, client]) => {
        clientRegistry.delete(name);
        await client.close().catch(() => undefined);
      })
    );

    if (error instanceof ConnectionError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new ConnectionError(
        \`Failed to initialize MCP runtime: \${error.message}\`,
        { cause: error }
      );
    }
    throw new ConnectionError(
      \`Failed to initialize MCP runtime: \${String(error)}\`
    );
  }
}

/**
 * Close all MCP connections
 */
export async function closeMCPRuntime(): Promise<void> {
  const errors: string[] = [];

  for (const [serverName, client] of clientRegistry.entries()) {
    try {
      await client.close();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      errors.push(\`\${serverName}: \${message}\`);
    }
  }
  clientRegistry.clear();
  isInitialized = false;

  if (errors.length > 0) {
    throw new ConnectionError(
      \`Failed to close MCP clients: \${errors.join("; ")}\`
    );
  }
}

/**
 * Call an MCP tool - used by generated code
 */
export async function callMCPTool<TResponse = unknown>(
  serverName: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<TResponse> {
  if (!isInitialized) {
    throw new ConnectionError(
      "MCP runtime not initialized. Call initializeMCPRuntime() first."
    );
  }

  const client = clientRegistry.get(serverName);
  if (!client) {
    throw new ConnectionError(\`MCP server "\${serverName}" not found in registry\`);
  }

  return client.callTool<TResponse>(toolName, input);
}
`;

    await this.writeFileSafe(clientPath, clientCode);
    console.log(chalk.gray(`\nGenerated runtime client: client.ts`));
  }

  async generateSearchFile(
    outputDir: string,
    toolsByServer: Map<string, DiscoveredTool[]>
  ): Promise<void> {
    const searchPath = join(outputDir, "search.ts");

    // Build tool registry data
    const toolEntries: string[] = [];
    for (const [serverName, tools] of toolsByServer.entries()) {
      for (const tool of tools) {
        const normalizedName = CodeGenerator.normalizeName(tool.name);
        const functionName =
          TypeGenerator.toCamelCase(normalizedName) || "tool";
        const description = tool.description || tool.name;
        toolEntries.push(
          `  { server: ${JSON.stringify(serverName)}, name: ${JSON.stringify(
            tool.name
          )}, fn: ${JSON.stringify(
            functionName
          )}, description: ${JSON.stringify(description)} }`
        );
      }
    }

    const searchCode = `/** Detail level for tool information */
export type DetailLevel = "name" | "summary" | "full";

/** Tool metadata for discovery */
export interface ToolInfo {
  server: string;
  name: string;
  fn: string;
  description: string;
}

/** Minimal tool info (name only) */
export interface ToolNameInfo {
  server: string;
  name: string;
}

/** Summary tool info (name + description) */
export interface ToolSummaryInfo {
  server: string;
  name: string;
  description: string;
}

/** Registry of all available tools */
export const toolRegistry: ToolInfo[] = [
${toolEntries.join(",\n")}
];

/** List all servers */
export function listServers(): string[] {
  return [...new Set(toolRegistry.map(t => t.server))];
}

/** List tools for a specific server with configurable detail level */
export function listTools(serverName?: string, detail: DetailLevel = "full"): ToolInfo[] | ToolSummaryInfo[] | ToolNameInfo[] {
  const tools = serverName 
    ? toolRegistry.filter(t => t.server === serverName)
    : toolRegistry;
  
  switch (detail) {
    case "name":
      return tools.map(t => ({ server: t.server, name: t.name }));
    case "summary":
      return tools.map(t => ({ server: t.server, name: t.name, description: t.description }));
    case "full":
    default:
      return tools;
  }
}

/** 
 * Search tools by keyword with configurable detail level
 * Matches against name, description, or server name
 */
export function searchTools(query: string, detail: DetailLevel = "full"): ToolInfo[] | ToolSummaryInfo[] | ToolNameInfo[] {
  const q = query.toLowerCase();
  const matches = toolRegistry.filter(t =>
    t.name.toLowerCase().includes(q) ||
    t.description.toLowerCase().includes(q) ||
    t.server.toLowerCase().includes(q)
  );
  
  switch (detail) {
    case "name":
      return matches.map(t => ({ server: t.server, name: t.name }));
    case "summary":
      return matches.map(t => ({ server: t.server, name: t.name, description: t.description }));
    case "full":
    default:
      return matches;
  }
}

/** Get tool info by server and name */
export function getTool(serverName: string, toolName: string): ToolInfo | undefined {
  return toolRegistry.find(t => t.server === serverName && t.name === toolName);
}

/** Get total tool count */
export function getToolCount(serverName?: string): number {
  if (serverName) {
    return toolRegistry.filter(t => t.server === serverName).length;
  }
  return toolRegistry.length;
}
`;

    await this.writeFileSafe(searchPath, searchCode);
    console.log(chalk.gray(`Generated search utilities: search.ts`));
  }

  async generateCursorRules(
    outputDir: string,
    toolsByServer: Map<string, DiscoveredTool[]>
  ): Promise<void> {
    const cursorDir = join(process.cwd(), ".cursor", "rules");
    await this.ensureDir(cursorDir);

    const rulesPath = join(cursorDir, "mcpcode.mdc");

    const serverList = [...toolsByServer.keys()]
      .map((s) => `- \`${s}\``)
      .join("\n");

    const toolExamples = [...toolsByServer.entries()]
      .slice(0, 2)
      .map(([serverName, tools]) => {
        const tool = tools[0];
        if (!tool) return "";
        const normalizedName = CodeGenerator.normalizeName(tool.name);
        const functionName =
          TypeGenerator.toCamelCase(normalizedName) || "tool";
        return `// ${serverName}
import * as ${TypeGenerator.toCamelCase(
          serverName.replace(/[^a-zA-Z0-9]/g, "")
        )} from './${outputDir}${serverName}/index.js';
const result = await ${TypeGenerator.toCamelCase(
          serverName.replace(/[^a-zA-Z0-9]/g, "")
        )}.${functionName}({ /* params */ });`;
      })
      .filter(Boolean)
      .join("\n\n");

    const rulesContent = `---
description: MCP Code Generator - Use generated TypeScript wrappers instead of direct MCP tool calls
globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
alwaysApply: true
---

# MCP Code Generator Rules

When working with MCP tools in this project, use the generated TypeScript wrappers in \`${outputDir}\` instead of making direct MCP tool calls. This approach reduces token usage and improves type safety.

## Available Servers

${serverList}

## How to Use

1. **Initialize the runtime** before calling any tools:

\`\`\`typescript
import { initializeMCPRuntime, closeMCPRuntime } from './${outputDir}client.js';

await initializeMCPRuntime();
// ... use tools ...
await closeMCPRuntime();
\`\`\`

2. **Import and call tools** from server modules:

\`\`\`typescript
${toolExamples}
\`\`\`

3. **Discover tools** using the search utilities:

\`\`\`typescript
import { searchTools, listServers, listTools } from './${outputDir}search.js';

const servers = listServers();
const gitTools = searchTools('commit');
\`\`\`

## Benefits

- **Type Safety**: All tool inputs and outputs are fully typed
- **Token Efficiency**: Load only the tools you need instead of all definitions
- **IDE Support**: Full autocomplete and type checking
- **Progressive Discovery**: Browse tools via filesystem or search utilities
`;

    await this.writeFileSafe(rulesPath, rulesContent);
    console.log(
      chalk.gray(`Generated cursor rules: .cursor/rules/mcpcode.mdc`)
    );
  }

  async updateGitignore(outputDir: string): Promise<void> {
    const gitignorePath = join(process.cwd(), ".gitignore");
    
    // Use relative path for gitignore - strip leading ./ and ensure trailing /
    let relativePath = outputDir
      .replace(/^\.\//, "")  // Remove leading ./
      .replace(/^\/.*/, outputDir.split("/").pop() || outputDir); // For absolute paths, use just the folder name
    
    // If it's an absolute path outside cwd, just use the folder name
    if (outputDir.startsWith("/") && !outputDir.startsWith(process.cwd())) {
      relativePath = outputDir.split("/").filter(Boolean).pop() || "servers";
    }
    
    const normalizedPath = relativePath.endsWith("/") ? relativePath : `${relativePath}/`;
    const gitignoreEntry = `\n# MCP Code Generator - generated server wrappers\n${normalizedPath}\n`;

    try {
      if (existsSync(gitignorePath)) {
        const content = await readFile(gitignorePath, "utf-8");
        
        // Check if the entry already exists (with or without trailing slash)
        const pathWithoutSlash = normalizedPath.replace(/\/$/, "");
        if (
          content.includes(normalizedPath) ||
          content.includes(pathWithoutSlash) ||
          content.includes(`\n${normalizedPath}`) ||
          content.includes(`\n${pathWithoutSlash}`)
        ) {
          return; // Already in .gitignore
        }

        // Append to existing .gitignore
        await appendFile(gitignorePath, gitignoreEntry);
        console.log(chalk.gray(`Updated .gitignore to exclude ${normalizedPath}`));
      } else {
        // Create new .gitignore
        await writeFile(gitignorePath, gitignoreEntry.trim() + "\n", "utf-8");
        console.log(chalk.gray(`Created .gitignore with ${normalizedPath}`));
      }
    } catch (error) {
      // Non-fatal - just warn
      const message = error instanceof Error ? error.message : String(error);
      console.warn(chalk.yellow(`Warning: Could not update .gitignore: ${message}`));
    }
  }

  private async ensureDir(dirPath: string): Promise<void> {
    if (existsSync(dirPath)) {
      return;
    }
    try {
      await mkdir(dirPath, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GenerationError(
        `Failed to create directory "${dirPath}": ${message}`,
        error instanceof Error ? { cause: error } : undefined
      );
    }
  }

  private async writeFileSafe(
    filePath: string,
    contents: string
  ): Promise<void> {
    try {
      await writeFile(filePath, contents, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GenerationError(
        `Failed to write file "${filePath}": ${message}`,
        error instanceof Error ? { cause: error } : undefined
      );
    }
  }

  private static normalizeName(name: string): string {
    const sanitized = name
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return sanitized.length > 0 ? sanitized : "tool";
  }

  static groupToolsByServer(
    tools: DiscoveredTool[]
  ): Map<string, DiscoveredTool[]> {
    const grouped = new Map<string, DiscoveredTool[]>();

    for (const tool of tools) {
      const serverTools = grouped.get(tool.serverName) || [];
      serverTools.push(tool);
      grouped.set(tool.serverName, serverTools);
    }

    return grouped;
  }
}
