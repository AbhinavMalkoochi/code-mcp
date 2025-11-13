import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { spawn, ChildProcess } from "child_process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ServerConfig,
  StdioServerConfig,
  HttpServerConfig,
} from "../config/parser.js";
import { isStdioConfig, isHttpConfig } from "../config/parser.js";

export type { ServerConfig as MCPServerConfig };

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class MCPClient {
  private client: Client;
  private transport: Transport | null = null;
  private process: ChildProcess | null = null;
  private serverName: string;

  constructor(serverName: string) {
    this.serverName = serverName;
    this.client = new Client(
      {
        name: "mcpcode-generator",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );
  }

  async connect(config: ServerConfig): Promise<void> {
    try {
      if (isStdioConfig(config)) {
        await this.connectStdio(config);
      } else if (isHttpConfig(config)) {
        await this.connectHttp(config);
      } else {
        throw new Error("Invalid server configuration");
      }
    } catch (error) {
      throw new Error(
        `Failed to connect to MCP server "${this.serverName}": ${error}`
      );
    }
  }

  private async connectStdio(config: StdioServerConfig): Promise<void> {
    this.process = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
    });

    await this.client.connect(this.transport);
  }

  private async connectHttp(config: HttpServerConfig): Promise<void> {
    this.transport = new SSEClientTransport(new URL(config.url));

    await this.client.connect(this.transport);
  }

  async listTools(): Promise<MCPTool[]> {
    try {
      const response = await this.client.listTools();
      return response.tools.map((tool): MCPTool => {
        const mcpTool: MCPTool = {
          name: tool.name,
          inputSchema: (tool.inputSchema || {}) as Record<string, unknown>,
        };
        if (tool.description) {
          mcpTool.description = tool.description;
        }
        return mcpTool;
      });
    } catch (error) {
      throw new Error(
        `Failed to list tools from server "${this.serverName}": ${error}`
      );
    }
  }

  async callTool<T = unknown>(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<T> {
    try {
      const response = await this.client.callTool({
        name: toolName,
        arguments: args,
      });
      const content = Array.isArray(response.content)
        ? response.content[0]
        : response.content;
      return (content ?? {}) as T;
    } catch (error) {
      throw new Error(
        `Failed to call tool "${toolName}" on server "${this.serverName}": ${error}`
      );
    }
  }

  async close(): Promise<void> {
    try {
      if (this.transport) {
        await this.transport.close();
      }
      if (this.process) {
        this.process.kill();
      }
    } catch (error) {
      console.error(
        `Error closing MCP client for "${this.serverName}":`,
        error
      );
    }
  }
}

export async function callMCPTool<T = unknown>(
  serverToolName: string,
  input: Record<string, unknown>
): Promise<T> {
  throw new Error(
    `callMCPTool runtime not initialized. Cannot call ${serverToolName}`
  );
}
