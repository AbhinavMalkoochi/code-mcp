import { MCPClient, type MCPTool } from "../client/mcpClient.js";
import type { MCPConfig, ServerConfig } from "../config/parser.js";
import chalk from "chalk";

export interface DiscoveredTool extends MCPTool {
  serverName: string;
}

export interface DiscoveryResult {
  serverName: string;
  tools: MCPTool[];
  error?: string;
}

export class ToolDiscovery {
  private config: MCPConfig;

  constructor(config: MCPConfig) {
    this.config = config;
  }

  async discoverAll(): Promise<DiscoveryResult[]> {
    const serverNames = Object.keys(this.config.mcpServers);
    const results: DiscoveryResult[] = [];

    console.log(
      chalk.blue(
        `\nDiscovering tools from ${serverNames.length} server(s)...\n`
      )
    );

    for (const serverName of serverNames) {
      const result = await this.discoverServer(serverName);
      results.push(result);
    }

    return results;
  }

  async discoverServer(serverName: string): Promise<DiscoveryResult> {
    const serverConfig = this.config.mcpServers[serverName];
    if (!serverConfig) {
      return {
        serverName,
        tools: [],
        error: `Server "${serverName}" not found in config`,
      };
    }

    console.log(chalk.cyan(`Connecting to server: ${serverName}...`));

    const client = new MCPClient(serverName);

    try {
      await client.connect(serverConfig);
      console.log(chalk.green(`✓ Connected to ${serverName}`));

      console.log(chalk.cyan(`  Fetching tools from ${serverName}...`));
      const tools = await client.listTools();
      console.log(
        chalk.green(`✓ Found ${tools.length} tool(s) in ${serverName}`)
      );

      await client.close();

      return {
        serverName,
        tools,
      };
    } catch (error) {
      console.log(chalk.red(`✗ Failed to connect to ${serverName}: ${error}`));
      await client.close();

      return {
        serverName,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  static flattenTools(results: DiscoveryResult[]): DiscoveredTool[] {
    const flattened: DiscoveredTool[] = [];

    for (const result of results) {
      for (const tool of result.tools) {
        flattened.push({
          ...tool,
          serverName: result.serverName,
        });
      }
    }

    return flattened;
  }

  static printSummary(results: DiscoveryResult[]): void {
    console.log(chalk.blue("\n" + "=".repeat(50)));
    console.log(chalk.bold("Discovery Summary"));
    console.log(chalk.blue("=".repeat(50) + "\n"));

    let totalTools = 0;
    let successfulServers = 0;
    let failedServers = 0;

    for (const result of results) {
      if (result.error) {
        console.log(chalk.red(`✗ ${result.serverName}: ${result.error}`));
        failedServers++;
      } else {
        console.log(
          chalk.green(`✓ ${result.serverName}: ${result.tools.length} tool(s)`)
        );
        totalTools += result.tools.length;
        successfulServers++;
      }
    }

    console.log(chalk.blue("\n" + "=".repeat(50)));
    console.log(
      chalk.bold(
        `Total: ${totalTools} tool(s) from ${successfulServers} server(s)`
      )
    );
    if (failedServers > 0) {
      console.log(chalk.yellow(`Failed servers: ${failedServers}`));
    }
    console.log(chalk.blue("=".repeat(50) + "\n"));
  }
}
