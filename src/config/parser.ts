import { readFile } from "fs/promises";
import { existsSync } from "fs";

export interface StdioServerConfig {
  type?: "stdio";
  command: string;
  args: string[];
}

export interface HttpServerConfig {
  type?: "http";
  url: string;
  headers?: Record<string, string>;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export interface MCPConfig {
  mcpServers: Record<string, ServerConfig>;
}

export function isStdioConfig(
  config: ServerConfig
): config is StdioServerConfig {
  return "command" in config;
}

export function isHttpConfig(config: ServerConfig): config is HttpServerConfig {
  return "url" in config;
}

export class ConfigParser {
  static async parseConfig(configPath: string): Promise<MCPConfig> {
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }

    try {
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content) as MCPConfig;

      this.validateConfig(config);

      return config;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in config file: ${error.message}`);
      }
      throw error;
    }
  }

  static validateConfig(config: unknown): asserts config is MCPConfig {
    if (!config || typeof config !== "object") {
      throw new Error("Config must be an object");
    }

    const configObj = config as Record<string, unknown>;

    if (!configObj.mcpServers || typeof configObj.mcpServers !== "object") {
      throw new Error('Config must have "mcpServers" object');
    }

    for (const [serverName, serverConfig] of Object.entries(
      configObj.mcpServers
    )) {
      if (!serverConfig || typeof serverConfig !== "object") {
        throw new Error(`Server "${serverName}" config must be an object`);
      }

      const typedConfig = serverConfig as Record<string, unknown>;

      if ("command" in typedConfig) {
        if (typeof typedConfig.command !== "string") {
          throw new Error(
            `Server "${serverName}" must have a "command" string property`
          );
        }

        if (!Array.isArray(typedConfig.args)) {
          throw new Error(
            `Server "${serverName}" must have an "args" array property`
          );
        }

        for (const arg of typedConfig.args) {
          if (typeof arg !== "string") {
            throw new Error(
              `All args for server "${serverName}" must be strings`
            );
          }
        }
      } else if ("url" in typedConfig) {
        if (typeof typedConfig.url !== "string") {
          throw new Error(
            `Server "${serverName}" must have a "url" string property`
          );
        }

        if (typedConfig.headers !== undefined) {
          if (
            typeof typedConfig.headers !== "object" ||
            typedConfig.headers === null
          ) {
            throw new Error(`Server "${serverName}" headers must be an object`);
          }

          for (const [key, value] of Object.entries(typedConfig.headers)) {
            if (typeof value !== "string") {
              throw new Error(
                `All headers for server "${serverName}" must be strings (got ${typeof value} for "${key}")`
              );
            }
          }
        }
      } else {
        throw new Error(
          `Server "${serverName}" must have either "command" (for STDIO) or "url" (for HTTP)`
        );
      }
    }
  }

  static getServerNames(config: MCPConfig): string[] {
    return Object.keys(config.mcpServers);
  }

  static getServerConfig(config: MCPConfig, serverName: string): ServerConfig {
    const serverConfig = config.mcpServers[serverName];
    if (!serverConfig) {
      throw new Error(`Server "${serverName}" not found in config`);
    }
    return serverConfig;
  }
}
