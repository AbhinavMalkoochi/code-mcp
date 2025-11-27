import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { access } from "fs/promises";
import { constants as fsConstants } from "fs";
import { delimiter, isAbsolute, join, resolve } from "path";
import { setPriority } from "node:os";
import type { ServerConfig, StdioServerConfig } from "../config/parser.js";
import { isStdioConfig } from "../config/parser.js";
import { ConnectionError } from "../errors.js";

export type { ServerConfig as MCPServerConfig };

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const CONNECT_TIMEOUT_MS = 30_000;
const CONTROL_CHAR_PATTERN = /[\0\r\n]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const MAX_COMMAND_LENGTH = 256;
const MAX_ARG_LENGTH = 2048;

function sanitizeCommand(command: string, serverName: string): string {
  const trimmed = command.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_COMMAND_LENGTH) {
    throw new ConnectionError(
      `Server "${serverName}" command must be between 1 and ${MAX_COMMAND_LENGTH} characters`
    );
  }

  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    throw new ConnectionError(
      `Server "${serverName}" command contains invalid control characters`
    );
  }

  const segments = trimmed.split(PATH_SEPARATOR_PATTERN).filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    throw new ConnectionError(
      `Server "${serverName}" command must not include parent directory segments`
    );
  }

  const hasPathSeparator = PATH_SEPARATOR_PATTERN.test(trimmed);
  const isExplicitRelative =
    trimmed.startsWith("./") || trimmed.startsWith(".\\");

  if (hasPathSeparator && !isAbsolute(trimmed) && !isExplicitRelative) {
    throw new ConnectionError(
      `Server "${serverName}" command path must be absolute or start with "./"`
    );
  }

  return trimmed;
}

function sanitizeArgs(args: readonly string[], serverName: string): string[] {
  return args.map((arg, index) => {
    if (CONTROL_CHAR_PATTERN.test(arg)) {
      throw new ConnectionError(
        `Argument ${index} for server "${serverName}" contains control characters`
      );
    }

    if (arg.length > MAX_ARG_LENGTH) {
      throw new ConnectionError(
        `Argument ${index} for server "${serverName}" exceeds ${MAX_ARG_LENGTH} characters`
      );
    }

    return arg;
  });
}

async function ensureExecutableAvailable(
  command: string,
  serverName: string
): Promise<void> {
  const accessMode = fsConstants.X_OK ?? fsConstants.F_OK;

  const checkCandidate = async (candidate: string): Promise<boolean> => {
    try {
      await access(candidate, accessMode);
      return true;
    } catch {
      return false;
    }
  };

  if (PATH_SEPARATOR_PATTERN.test(command)) {
    const candidate = isAbsolute(command)
      ? command
      : resolve(process.cwd(), command);
    if (await checkCandidate(candidate)) {
      return;
    }
    throw new ConnectionError(
      `Executable "${command}" for server "${serverName}" not found or not executable`
    );
  }

  const pathEnv = process.env.PATH;
  if (!pathEnv) {
    throw new ConnectionError(
      `Unable to resolve command "${command}" for server "${serverName}" because PATH is not defined`
    );
  }

  const directories = pathEnv.split(delimiter).filter(Boolean);
  const extensions = getExecutableExtensions(command);

  for (const directory of directories) {
    for (const candidate of buildExecutableCandidates(
      directory,
      command,
      extensions
    )) {
      if (await checkCandidate(candidate)) {
        return;
      }
    }
  }

  throw new ConnectionError(
    `Executable "${command}" for server "${serverName}" was not found in PATH`
  );
}

function getExecutableExtensions(command: string): string[] {
  if (process.platform !== "win32") {
    return [""];
  }

  const rawExts =
    process.env.PATHEXT?.split(";")
      .map((ext) => ext.trim())
      .filter(Boolean) ?? [];

  const normalizedExts =
    rawExts.length > 0
      ? rawExts.map((ext) =>
          ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`
        )
      : [".exe", ".cmd", ".bat", ".com"];

  const commandLower = command.toLowerCase();
  if (normalizedExts.some((ext) => ext !== "" && commandLower.endsWith(ext))) {
    return [""];
  }

  return normalizedExts;
}

function buildExecutableCandidates(
  directory: string,
  command: string,
  extensions: string[]
): string[] {
  if (extensions.length === 0) {
    return [join(directory, command)];
  }

  return extensions.map((ext) =>
    ext === "" ? join(directory, command) : join(directory, `${command}${ext}`)
  );
}

export class MCPClient {
  private static activeClients = 0;
  private static readonly MAX_CONCURRENT_CLIENTS = 8;
  private static readonly clientRegistry = new Set<MCPClient>();
  private static shutdownHandlersRegistered = false;

  private client: Client;
  private transport: Transport | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  private isConnected = false;
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
    MCPClient.clientRegistry.add(this);
    MCPClient.registerShutdownHandlers();
  }

  async connect(config: ServerConfig): Promise<void> {
    try {
      if (this.isConnected) {
        throw new ConnectionError(
          `MCP client for "${this.serverName}" is already connected`
        );
      }
      if (!isStdioConfig(config)) {
        throw new ConnectionError(
          `Server "${this.serverName}" is misconfigured: only STDIO transport is supported`
        );
      }
      await this.connectStdio(config);
    } catch (error) {
      await this.close().catch(() => undefined);
      if (error instanceof ConnectionError) {
        throw error;
      }
      if (error instanceof Error) {
        throw new ConnectionError(
          `Failed to connect to MCP server "${this.serverName}": ${error.message}`,
          { cause: error }
        );
      }
      throw new ConnectionError(
        `Failed to connect to MCP server "${this.serverName}": ${String(error)}`
      );
    }
  }

  private async connectStdio(config: StdioServerConfig): Promise<void> {
    const sanitizedCommand = sanitizeCommand(config.command, this.serverName);
    const sanitizedArgs = sanitizeArgs(config.args, this.serverName);

    await ensureExecutableAvailable(sanitizedCommand, this.serverName);

    if (MCPClient.activeClients >= MCPClient.MAX_CONCURRENT_CLIENTS) {
      throw new ConnectionError(
        `Maximum concurrent MCP connections (${MCPClient.MAX_CONCURRENT_CLIENTS}) reached`
      );
    }

    // Process environment variables, expanding ${VAR} references
    const transportConfig: {
      command: string;
      args: string[];
      env?: Record<string, string>;
    } = {
      command: sanitizedCommand,
      args: sanitizedArgs,
    };

    if (config.env) {
      transportConfig.env = Object.entries(config.env).reduce(
        (acc, [key, value]) => {
          acc[key] = value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
            return process.env[varName] || "";
          });
          return acc;
        },
        {} as Record<string, string>
      );
    }

    const stdioTransport = new StdioClientTransport(transportConfig);

    stdioTransport.onclose = () => {
      this.handleDisconnect();
      if (this.transport === stdioTransport) {
        this.transport = null;
      }
    };
    stdioTransport.onerror = (error) => {
      console.error(
        `MCP transport error for "${this.serverName}":`,
        error.message
      );
    };

    this.transport = stdioTransport;

    const connectPromise = this.client.connect(stdioTransport);
    const timeoutPromise = new Promise<never>((_, reject) => {
      this.connectionTimer = setTimeout(() => {
        stdioTransport.close().catch(() => undefined);
        reject(
          new ConnectionError(
            `Timed out after ${CONNECT_TIMEOUT_MS}ms connecting to "${this.serverName}"`
          )
        );
      }, CONNECT_TIMEOUT_MS);
    });

    try {
      await Promise.race([connectPromise, timeoutPromise]);
      this.isConnected = true;
      MCPClient.activeClients += 1;
      const pid = stdioTransport.pid;
      if (pid !== null) {
        try {
          setPriority(pid, 10);
        } catch {
          // Ignore if setting priority is not supported on this platform.
        }
      }
    } finally {
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
      }
    }
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
      if (error instanceof ConnectionError) {
        throw error;
      }
      if (error instanceof Error) {
        throw new ConnectionError(
          `Failed to list tools from server "${this.serverName}": ${error.message}`,
          { cause: error }
        );
      }
      throw new ConnectionError(
        `Failed to list tools from server "${this.serverName}": ${String(
          error
        )}`
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
      if (error instanceof ConnectionError) {
        throw error;
      }
      if (error instanceof Error) {
        throw new ConnectionError(
          `Failed to call tool "${toolName}" on server "${this.serverName}": ${error.message}`,
          { cause: error }
        );
      }
      throw new ConnectionError(
        `Failed to call tool "${toolName}" on server "${
          this.serverName
        }": ${String(error)}`
      );
    }
  }

  async close(): Promise<void> {
    try {
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
      }
      if (this.transport) {
        await this.transport.close();
      }
    } catch (error) {
      console.error(
        `Error closing MCP client for "${this.serverName}":`,
        error
      );
      throw error;
    } finally {
      this.handleDisconnect();
      this.transport = null;
    }
  }

  private handleDisconnect(): void {
    if (this.isConnected && MCPClient.activeClients > 0) {
      MCPClient.activeClients -= 1;
    }
    this.isConnected = false;
    MCPClient.clientRegistry.delete(this);
  }

  private static registerShutdownHandlers(): void {
    if (MCPClient.shutdownHandlersRegistered) {
      return;
    }
    MCPClient.shutdownHandlersRegistered = true;

    const cleanup = async () => {
      const clients = Array.from(MCPClient.clientRegistry);
      await Promise.allSettled(clients.map((client) => client.close()));
    };

    process.on("SIGTERM", () => {
      cleanup().finally(() => process.exit(0));
    });

    process.on("SIGINT", () => {
      cleanup().finally(() => process.exit(0));
    });
  }
}

export async function callMCPTool<T = unknown>(
  serverToolName: string,
  input: Record<string, unknown>
): Promise<T> {
  throw new ConnectionError(
    `callMCPTool runtime not initialized. Cannot call ${serverToolName}`
  );
}
