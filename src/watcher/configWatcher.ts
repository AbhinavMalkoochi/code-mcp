import { watch } from "fs";
import { existsSync } from "fs";
import chalk from "chalk";
import { ConfigParser } from "../config/parser.js";
import { ToolDiscovery } from "../discovery/toolDiscovery.js";
import { CodeGenerator } from "../generator/codeGenerator.js";
import { ConfigError } from "../errors.js";

const PATH_CONTROL_PATTERN = /[\0\r\n]/;

function sanitizeWatcherPath(path: string, label: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new ConfigError(`Watcher option "${label}" must not be empty`);
  }
  if (PATH_CONTROL_PATTERN.test(trimmed)) {
    throw new ConfigError(
      `Watcher option "${label}" contains invalid control characters`
    );
  }
  return trimmed;
}

export interface WatcherOptions {
  configPath: string;
  outputPath: string;
  debounceMs?: number;
}

export class ConfigWatcher {
  private configPath: string;
  private outputPath: string;
  private debounceMs: number;
  private debounceTimer: NodeJS.Timeout | null = null;
  private isGenerating = false;

  constructor(options: WatcherOptions) {
    this.configPath = sanitizeWatcherPath(options.configPath, "configPath");
    this.outputPath = sanitizeWatcherPath(options.outputPath, "outputPath");
    this.debounceMs = options.debounceMs || 1000;
  }

  async start(): Promise<void> {
    console.log(chalk.bold.blue("\n👀 MCP Config Watcher Started\n"));
    console.log(chalk.gray(`Watching: ${this.configPath}`));
    console.log(chalk.gray(`Output: ${this.outputPath}`));
    console.log(chalk.gray(`Press Ctrl+C to stop\n`));

    // Generate initially
    await this.regenerate();

    // Watch for changes - handle file not found gracefully
    try {
      watch(this.configPath, async (eventType) => {
        if (eventType === "change") {
          this.scheduleRegeneration();
        }
      });
      console.log(chalk.green("✓ Watching for config changes...\n"));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new ConfigError(`Config file not found: ${this.configPath}`);
      }
      throw error;
    }
  }

  private scheduleRegeneration(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.regenerate();
    }, this.debounceMs);
  }

  private async regenerate(): Promise<void> {
    if (this.isGenerating) {
      console.log(
        chalk.yellow("⏳ Generation already in progress, skipping...")
      );
      return;
    }

    this.isGenerating = true;

    try {
      console.log(chalk.blue("\n" + "=".repeat(60)));
      console.log(chalk.bold(`🔄 Config changed - Regenerating...`));
      console.log(chalk.gray(new Date().toLocaleTimeString()));
      console.log(chalk.blue("=".repeat(60) + "\n"));

      // Parse config
      const config = await ConfigParser.parseConfig(this.configPath);
      const serverCount = Object.keys(config.mcpServers).length;
      console.log(chalk.cyan(`📝 Found ${serverCount} server(s) in config`));

      // Discover tools
      const discovery = new ToolDiscovery(config);
      const results = await discovery.discoverAll();

      // Check if any tools were discovered
      const allTools = ToolDiscovery.flattenTools(results);
      if (allTools.length === 0) {
        console.log(
          chalk.yellow("\n⚠ No tools discovered. Skipping generation.")
        );
        this.isGenerating = false;
        return;
      }

      // Generate code
      const generator = new CodeGenerator();
      const toolsByServer = CodeGenerator.groupToolsByServer(allTools);
      await generator.generateAll(this.outputPath, toolsByServer);

      console.log(chalk.bold.green("\n✅ Regeneration complete!"));
      console.log(chalk.gray(new Date().toLocaleTimeString()));
      console.log(chalk.green("\n👀 Watching for more changes...\n"));
    } catch (error) {
      console.error(
        chalk.bold.red("\n❌ Regeneration failed:"),
        error instanceof Error ? error.message : error
      );
      console.log(chalk.yellow("\n👀 Continuing to watch for changes...\n"));
    } finally {
      this.isGenerating = false;
    }
  }
}
