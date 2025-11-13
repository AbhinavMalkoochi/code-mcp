#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { ConfigParser } from "./config/parser.js";
import { ToolDiscovery } from "./discovery/toolDiscovery.js";
import { CodeGenerator } from "./generator/codeGenerator.js";
import { ConfigWatcher } from "./watcher/configWatcher.js";

const program = new Command();

program
  .name("mcpcode")
  .description(
    "CLI tool to generate sandboxed TypeScript functions for MCP tools"
  )
  .version("1.0.0");

program
  .command("generate")
  .description("Generate TypeScript code from MCP server configurations")
  .option("-c, --config <path>", "Path to MCP config file", "mcp.config.json")
  .option(
    "-o, --output <path>",
    "Output directory for generated code",
    "servers/"
  )
  .action(async (options) => {
    try {
      console.log(chalk.bold.blue("\n🚀 MCP Code Generator\n"));
      console.log(chalk.gray(`Config: ${options.config}`));
      console.log(chalk.gray(`Output: ${options.output}\n`));

      // Parse config
      console.log(chalk.cyan("📝 Parsing configuration..."));
      const config = await ConfigParser.parseConfig(options.config);
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
      await generator.generateAll(options.output, toolsByServer);

      console.log(chalk.bold.green("✅ Success!"));
      console.log(
        chalk.gray(`\nGenerated code is available in: ${options.output}`)
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
      const watcher = new ConfigWatcher({
        configPath: options.config,
        outputPath: options.output,
        debounceMs: parseInt(options.debounce, 10),
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
