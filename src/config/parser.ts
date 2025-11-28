import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { isAbsolute } from "path";
import { z } from "zod";
import { ConfigError } from "../errors.js";

const MAX_COMMAND_LENGTH = 256;
const MAX_ARG_LENGTH = 2048;
const MAX_ARGS = 64;
const MAX_URL_LENGTH = 2048;
const CONTROL_CHAR_PATTERN = /[\0\r\n]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const SERVER_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

// URL validation schema (shared)
const UrlSchema = z
  .string()
  .trim()
  .min(1, { message: "URL must not be empty" })
  .max(MAX_URL_LENGTH, {
    message: `URL must be <= ${MAX_URL_LENGTH} characters`,
  })
  .url({ message: "Invalid URL format" });

// HTTP/SSE transport schema with explicit type
const ExplicitHttpServerSchema = z.object({
  type: z.enum(["http", "sse"]),
  url: UrlSchema,
  headers: z.record(z.string()).optional(),
});

// URL-only config (auto-detect as http) - for configs like Context7 that omit type
const UrlOnlyServerSchema = z
  .object({
    url: UrlSchema,
    headers: z.record(z.string()).optional(),
  })
  .transform((val) => ({ ...val, type: "http" as const }));

// Combined HTTP schema - try explicit first, then URL-only
const HttpServerSchema = z.union([
  ExplicitHttpServerSchema,
  UrlOnlyServerSchema,
]);

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

// Union of all transport types
const ServerConfigSchema = z.union([StdioServerSchema, HttpServerSchema]);

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
    ServerConfigSchema
  ),
});

export type StdioServerConfig = z.infer<typeof StdioServerSchema>;
export type HttpServerConfig = z.infer<typeof HttpServerSchema>;
export type ServerConfig = StdioServerConfig | HttpServerConfig;
export type MCPConfig = z.infer<typeof MCPConfigSchema>;

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

          // Provide clearer messages for union type failures
          if (issue.code === "invalid_union") {
            const serverPath = issue.path.slice(0, 2).join(".");
            return `${serverPath}: Server config must have either "command" (for STDIO) or "url" (for HTTP/SSE)`;
          }

          return `${path}${issue.message}`;
        })
        .filter((msg, idx, arr) => arr.indexOf(msg) === idx)
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
