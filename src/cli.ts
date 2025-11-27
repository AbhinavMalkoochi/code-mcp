#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, existsSync } from "fs";
import { rm } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { ConfigParser } from "./config/parser.js";
import { ToolDiscovery } from "./discovery/toolDiscovery.js";
import { CodeGenerator } from "./generator/codeGenerator.js";
import { ConfigWatcher } from "./watcher/configWatcher.js";

const PATH_CONTROL_PATTERN = /[\0\r\n]/;

function sanitizePathOption(rawPath: string, optionName: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new Error(`Option "${optionName}" must not be empty`);
  }
  if (PATH_CONTROL_PATTERN.test(trimmed)) {
    throw new Error(
      `Option "${optionName}" contains invalid control characters`
    );
  }
  return trimmed;
}

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, "..", "package.json");
let version = "1.0.0";
try {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  version = packageJson.version || version;
} catch {
  // Fallback to default version if package.json can't be read
}

const program = new Command();

program
  .name("mcpcode")
  .description(
    "CLI tool to generate sandboxed TypeScript functions for MCP tools"
  )
  .version(version);

program
  .command("generate")
  .description("Generate TypeScript code from MCP server configurations")
  .option("-c, --config <path>", "Path to MCP config file", "mcp.config.json")
  .option(
    "-o, --output <path>",
    "Output directory for generated code",
    "servers/"
  )
  .option("--clean", "Remove output directory before generation")
  .action(async (options) => {
    try {
      const configPath = sanitizePathOption(options.config, "config");
      const outputPath = sanitizePathOption(options.output, "output");

      console.log(chalk.bold.blue("\n🚀 MCP Code Generator\n"));
      console.log(chalk.gray(`Config: ${configPath}`));
      console.log(chalk.gray(`Output: ${outputPath}\n`));

      // Clean output directory if requested
      if (options.clean && existsSync(outputPath)) {
        console.log(chalk.cyan("🧹 Cleaning output directory..."));
        await rm(outputPath, { recursive: true, force: true });
        console.log(chalk.green("✓ Output directory cleaned\n"));
      }

      // Parse config
      console.log(chalk.cyan("📝 Parsing configuration..."));
      const config = await ConfigParser.parseConfig(configPath);
      const serverCount = Object.keys(config.mcpServers).length;
      console.log(chalk.green(`✓ Found ${serverCount} server(s) in config\n`));

      // Discover tools
      const discovery = new ToolDiscovery(config);
      const results = await discovery.discoverAll();

      // Print summary
      ToolDiscovery.printSummary(results);

      // Check if any tools were discovered
      const allTools = ToolDiscovery.flattenTools(results);
      if (allTools.length === 0) {
        console.log(
          chalk.yellow("⚠ No tools discovered. Nothing to generate.")
        );
        process.exit(0);
      }

      // Generate code
      const generator = new CodeGenerator();
      const toolsByServer = CodeGenerator.groupToolsByServer(allTools);
      await generator.generateAll(outputPath, toolsByServer);

      console.log(chalk.bold.green("✅ Success!"));
      console.log(
        chalk.gray(`\nGenerated code is available in: ${outputPath}`)
      );
      console.log(
        chalk.gray(
          "\nTo use the generated code, import from the server directories:"
        )
      );
      console.log(
        chalk.cyan(
          `  import * as myServer from './${options.output}my-server';`
        )
      );
    } catch (error) {
      console.error(
        chalk.bold.red("\n❌ Error:"),
        error instanceof Error ? error.message : error
      );
      process.exit(1);
    }
  });

program
  .command("watch")
  .description("Watch MCP config file and auto-regenerate on changes")
  .option("-c, --config <path>", "Path to MCP config file", "mcp.config.json")
  .option(
    "-o, --output <path>",
    "Output directory for generated code",
    "servers/"
  )
  .option("-d, --debounce <ms>", "Debounce delay in milliseconds", "1000")
  .action(async (options) => {
    try {
      const configPath = sanitizePathOption(options.config, "config");
      const outputPath = sanitizePathOption(options.output, "output");

      // Validate debounce value
      const debounceMs = parseInt(options.debounce, 10);
      if (isNaN(debounceMs) || debounceMs < 100 || debounceMs > 60000) {
        throw new Error(
          "Debounce delay must be between 100 and 60000 milliseconds"
        );
      }

      const watcher = new ConfigWatcher({
        configPath,
        outputPath,
        debounceMs,
      });

      await watcher.start();

      // Keep the process running
      process.on("SIGINT", () => {
        console.log(chalk.yellow("\n\n👋 Watcher stopped"));
        process.exit(0);
      });
    } catch (error) {
      console.error(
        chalk.bold.red("\n❌ Error:"),
        error instanceof Error ? error.message : error
      );
      process.exit(1);
    }
  });

// Handle unknown commands
program.on("command:*", () => {
  console.error(chalk.red("\n❌ Invalid command"));
  program.help();
});

// Show help if no command provided
if (process.argv.length === 2) {
  program.help();
}

program.parse(process.argv);
