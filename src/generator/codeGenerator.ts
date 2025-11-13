import { mkdir, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { TypeGenerator } from "./typeGenerator.js";
import type { DiscoveredTool } from "../discovery/toolDiscovery.js";
import chalk from "chalk";

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
    const fileName = `${TypeGenerator.toCamelCase(tool.name)}.ts`;
    const filePath = join(serverDir, fileName);

    const functionName = TypeGenerator.toCamelCase(tool.name);
    const inputInterfaceName = `${TypeGenerator.toPascalCase(tool.name)}Input`;
    const responseInterfaceName = `${TypeGenerator.toPascalCase(
      tool.name
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
  return callMCPTool<${responseInterfaceName}>('${serverName}', '${tool.name}', input);
}
`;

    await writeFile(filePath, code, "utf-8");
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

    await writeFile(filePath, exports + "\n", "utf-8");
  }

  async generateRuntimeClient(outputDir: string): Promise<void> {
    const clientPath = join(outputDir, "client.ts");

    const clientCode = `import { MCPClient } from "../src/client/mcpClient.js";
import { ConfigParser } from "../src/config/parser.js";

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
  
  // Initialize clients for all servers
  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    const client = new MCPClient(serverName);
    await client.connect(serverConfig);
    clientRegistry.set(serverName, client);
  }

  isInitialized = true;
}

/**
 * Close all MCP connections
 */
export async function closeMCPRuntime(): Promise<void> {
  for (const client of clientRegistry.values()) {
    await client.close();
  }
  clientRegistry.clear();
  isInitialized = false;
}

/**
 * Call an MCP tool - used by generated code
 */
export async function callMCPTool<T = any>(
  serverName: string,
  toolName: string,
  input: any
): Promise<T> {
  if (!isInitialized) {
    throw new Error(
      "MCP runtime not initialized. Call initializeMCPRuntime() first."
    );
  }

  const client = clientRegistry.get(serverName);
  if (!client) {
    throw new Error(\`MCP server "\${serverName}" not found in registry\`);
  }

  return client.callTool<T>(toolName, input);
}
`;

    await writeFile(clientPath, clientCode, "utf-8");
    console.log(chalk.gray(`\nGenerated runtime client: client.ts`));
  }

  private async ensureDir(dirPath: string): Promise<void> {
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }
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
