import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { isAbsolute } from "path";
import { z } from "zod";
import { ConfigError } from "../errors.js";

const MAX_COMMAND_LENGTH = 256;
const MAX_ARG_LENGTH = 2048;
const MAX_ARGS = 64;
const CONTROL_CHAR_PATTERN = /[\0\r\n]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const SERVER_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

const StdioServerSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z
      .string()
      .trim()
      .min(1, { message: "Command must not be empty" })
      .max(MAX_COMMAND_LENGTH, {
        message: `Command must be <= ${MAX_COMMAND_LENGTH} characters`,
      })
      .refine((value) => !CONTROL_CHAR_PATTERN.test(value), {
        message: "Command must not contain control characters",
      })
      .refine(
        (value) =>
          !value
            .split(PATH_SEPARATOR_PATTERN)
            .filter(Boolean)
            .some((segment) => segment === ".."),
        { message: "Command must not include parent directory segments" }
      )
      .refine(
        (value) => {
          if (!PATH_SEPARATOR_PATTERN.test(value)) {
            return true;
          }
          return (
            isAbsolute(value) ||
            value.startsWith("./") ||
            value.startsWith(".\\")
          );
        },
        {
          message:
            'Command paths with separators must be absolute or start with "./"',
        }
      ),
    args: z
      .array(
        z
          .string()
          .max(MAX_ARG_LENGTH, {
            message: `Arguments must be <= ${MAX_ARG_LENGTH} characters`,
          })
          .refine((value) => !CONTROL_CHAR_PATTERN.test(value), {
            message: "Arguments must not contain control characters",
          })
      )
      .max(MAX_ARGS, {
        message: `Too many arguments (max ${MAX_ARGS})`,
      }),
    env: z.record(z.string()).optional(),
  })
  .transform((value) => ({
    ...value,
    args: [...value.args],
    env: value.env ? { ...value.env } : undefined,
  }));

const MCPConfigSchema = z.object({
  mcpServers: z.record(
    z
      .string()
      .trim()
      .min(1, { message: "Server name must not be empty" })
      .regex(SERVER_NAME_PATTERN, {
        message:
          'Server names may only contain letters, numbers, ".", "-", and "_"',
      }),
    StdioServerSchema
  ),
});

export type StdioServerConfig = z.infer<typeof StdioServerSchema>;
export type ServerConfig = StdioServerConfig;
export type MCPConfig = z.infer<typeof MCPConfigSchema>;

export function isStdioConfig(
  config: ServerConfig
): config is StdioServerConfig {
  return "command" in config;
}

export class ConfigParser {
  static async parseConfig(configPath: string): Promise<MCPConfig> {
    if (!existsSync(configPath)) {
      throw new ConfigError(`Config file not found: ${configPath}`);
    }

    try {
      const content = await readFile(configPath, "utf-8");
      const rawConfig = JSON.parse(content);

      return this.validateConfig(rawConfig);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ConfigError(`Invalid JSON in config file: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  static validateConfig(config: unknown): MCPConfig {
    const parsed = MCPConfigSchema.safeParse(config);
    if (!parsed.success) {
      const messages = parsed.error.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
          return `${path}${issue.message}`;
        })
        .join("; ");
      if (messages.length > 0) {
        throw new ConfigError(`Invalid MCP configuration: ${messages}`);
      }
      throw new ConfigError("Invalid MCP configuration");
    }
    return parsed.data;
  }

  static getServerNames(config: MCPConfig): string[] {
    return Object.keys(config.mcpServers);
  }

  static getServerConfig(config: MCPConfig, serverName: string): ServerConfig {
    const serverConfig = config.mcpServers[serverName];
    if (!serverConfig) {
      throw new ConfigError(`Server "${serverName}" not found in config`);
    }
    return serverConfig;
  }
}
