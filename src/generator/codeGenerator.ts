import { mkdir, writeFile } from "fs/promises";
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

    // Generate code for each server
    for (const [serverName, tools] of toolsByServer.entries()) {
      await this.generateServer(outputDir, serverName, tools);
    }

    // Generate the root client file that will be used by all generated code
    await this.generateRuntimeClient(outputDir);

    console.log(chalk.green("\n✓ Code generation complete!\n"));
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

    // Generate input interface
    const inputInterface = this.typeGen.generateInputInterface(
      tool.name,
      tool.inputSchema
    );

    // Generate response interface
    const responseInterface = this.typeGen.generateResponseInterface(tool.name);

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

    const clientCode = `import { MCPClient } from "../src/client/mcpClient.js";
import { ConfigParser } from "../src/config/parser.js";
import { ConnectionError } from "../src/errors.js";

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
