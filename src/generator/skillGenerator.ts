import { mkdir, writeFile, readdir, rm } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { TypeGenerator } from "./typeGenerator.js";
import type { DiscoveredTool } from "../discovery/toolDiscovery.js";
import chalk from "chalk";
import { GenerationError } from "../errors.js";

export interface SkillGenerationOptions {
  outputDir: string;
  configPath: string;
}

interface ToolParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export class SkillGenerator {
  private typeGen: TypeGenerator;

  constructor() {
    this.typeGen = new TypeGenerator();
  }

  /**
   * Generate all skills from discovered MCP tools
   */
  async generateAll(
    toolsByServer: Map<string, DiscoveredTool[]>,
    options: SkillGenerationOptions
  ): Promise<void> {
    console.log(chalk.blue("\nGenerating Claude Skills...\n"));

    // Create output directory
    await this.ensureDir(options.outputDir);

    // Clean up stale skill directories
    const currentSkills = new Set(
      [...toolsByServer.keys()].map((name) => this.toSkillName(name))
    );
    currentSkills.add("mcp-tools-index");
    await this.cleanupStaleSkills(options.outputDir, currentSkills);

    // Generate skill for each server
    for (const [serverName, tools] of toolsByServer.entries()) {
      await this.generateServerSkill(
        serverName,
        tools,
        options.outputDir,
        options.configPath
      );
    }

    // Generate master index skill
    await this.generateIndexSkill(toolsByServer, options.outputDir);

    console.log(chalk.green("\n✓ Skill generation complete!\n"));
  }

  /**
   * Generate a complete skill folder for one MCP server
   */
  async generateServerSkill(
    serverName: string,
    tools: DiscoveredTool[],
    outputDir: string,
    configPath: string
  ): Promise<void> {
    const skillName = this.toSkillName(serverName);
    const skillDir = join(outputDir, skillName);
    const actionsDir = join(skillDir, "actions");
    const libDir = join(skillDir, "lib");

    // Create directories
    await this.ensureDir(skillDir);
    await this.ensureDir(actionsDir);
    await this.ensureDir(libDir);

    console.log(chalk.cyan(`Generating skill: ${skillName}`));

    // Generate SKILL.md
    await this.generateSkillMd(skillDir, serverName, tools);

    // Generate lib/client.ts (MCP client wrapper)
    await this.generateClientLib(libDir, serverName, configPath);

    // Generate action files
    const actionFiles: string[] = [];
    for (const tool of tools) {
      const fileName = await this.generateActionFile(
        actionsDir,
        serverName,
        tool
      );
      actionFiles.push(fileName);
      console.log(chalk.gray(`  - actions/${fileName}`));
    }

    // Generate index.ts
    await this.generateSkillIndex(skillDir, actionFiles);

    console.log(
      chalk.green(`✓ Generated skill ${skillName} with ${tools.length} tool(s)`)
    );
  }

  /**
   * Generate SKILL.md file with YAML frontmatter
   */
  private async generateSkillMd(
    skillDir: string,
    serverName: string,
    tools: DiscoveredTool[]
  ): Promise<void> {
    const skillName = this.toSkillName(serverName);
    const toolSummary = tools
      .slice(0, 3)
      .map((t) => t.name)
      .join(", ");
    const description = `MCP tools for ${serverName}: ${toolSummary}${
      tools.length > 3 ? ` and ${tools.length - 3} more` : ""
    }`.slice(0, 1024);

    // Build tools table
    const toolsTable = tools
      .map((t) => {
        const fnName = TypeGenerator.toCamelCase(this.normalizeName(t.name)) || "tool";
        const desc = (t.description || t.name).split("\n")[0]?.slice(0, 80) || t.name;
        return `| \`${fnName}\` | ${desc} |`;
      })
      .join("\n");

    // Build detailed tool reference
    const toolReference = tools
      .map((t) => this.generateToolReference(serverName, t))
      .join("\n\n---\n\n");

    // Generate example usage
    const firstTool = tools[0];
    const firstFnName = firstTool
      ? TypeGenerator.toCamelCase(this.normalizeName(firstTool.name))
      : "toolName";
    const serverVarName = TypeGenerator.toCamelCase(
      serverName.replace(/[^a-zA-Z0-9]/g, "")
    );

    const content = `---
name: ${skillName}
description: ${description}
allowed-tools: Read, Bash(npx:*, node:*, tsx:*)
---

# ${serverName} MCP Tools

This skill provides access to MCP tools from the \`${serverName}\` server.

## Available Tools

| Tool | Description |
|------|-------------|
${toolsTable}

## Quick Start

\`\`\`typescript
import { ${firstFnName} } from './actions/${firstFnName}.js';

const result = await ${firstFnName}({
  // Add parameters here
});
console.log(result);
\`\`\`

## Running Tools

Execute tools using:

\`\`\`bash
npx tsx .claude/skills/${skillName}/actions/${firstFnName}.ts
\`\`\`

Or import and use in your code:

\`\`\`typescript
import * as ${serverVarName} from '.claude/skills/${skillName}/index.js';

const result = await ${serverVarName}.${firstFnName}({ /* params */ });
\`\`\`

## Tool Reference

${toolReference}
`;

    await this.writeFileSafe(join(skillDir, "SKILL.md"), content);
    console.log(chalk.gray(`  - SKILL.md`));
  }

  /**
   * Generate detailed reference for a single tool
   */
  private generateToolReference(
    serverName: string,
    tool: DiscoveredTool
  ): string {
    const fnName = TypeGenerator.toCamelCase(this.normalizeName(tool.name));
    const params = this.extractParameters(tool.inputSchema);

    let paramsTable = "No parameters required.";
    if (params.length > 0) {
      paramsTable = `| Name | Type | Required | Description |
|------|------|----------|-------------|
${params.map((p) => `| \`${p.name}\` | ${p.type} | ${p.required ? "Yes" : "No"} | ${p.description} |`).join("\n")}`;
    }

    return `### ${fnName}

${tool.description || tool.name}

**Parameters:**

${paramsTable}

**Example:**

\`\`\`typescript
import { ${fnName} } from './actions/${fnName}.js';

const result = await ${fnName}({
${params
  .filter((p) => p.required)
  .map((p) => `  ${p.name}: ${this.getExampleValue(p.type)}`)
  .join(",\n")}
});
\`\`\``;
  }

  /**
   * Extract parameters from JSON schema
   */
  private extractParameters(schema: Record<string, unknown>): ToolParameter[] {
    const params: ToolParameter[] = [];
    const properties = schema.properties as Record<string, unknown> | undefined;
    const required = (schema.required as string[]) || [];

    if (!properties) return params;

    for (const [name, propSchema] of Object.entries(properties)) {
      const prop = propSchema as Record<string, unknown>;
      const descText = (prop.description as string) || name;
      params.push({
        name,
        type: (prop.type as string) || "unknown",
        required: required.includes(name),
        description: descText.split("\n")[0] || name,
      });
    }

    return params;
  }

  /**
   * Get example value for a type
   */
  private getExampleValue(type: string): string {
    switch (type) {
      case "string":
        return '"example"';
      case "number":
        return "123";
      case "boolean":
        return "true";
      case "array":
        return "[]";
      case "object":
        return "{}";
      default:
        return '"value"';
    }
  }

  /**
   * Generate the MCP client wrapper for this skill
   */
  private async generateClientLib(
    libDir: string,
    serverName: string,
    configPath: string
  ): Promise<void> {
    const content = `/**
 * MCP Client for ${serverName}
 * 
 * This module handles connection to the ${serverName} MCP server.
 */
import { MCPClient, ConfigParser, ConnectionError } from "@abmalk/mcpcode";

let client: MCPClient | null = null;
let isInitialized = false;

/**
 * Initialize connection to the ${serverName} MCP server
 */
export async function initializeClient(configPath: string = "${configPath}"): Promise<MCPClient> {
  if (isInitialized && client) {
    return client;
  }

  const config = await ConfigParser.parseConfig(configPath);
  const serverConfig = config.mcpServers["${serverName}"];
  
  if (!serverConfig) {
    throw new ConnectionError(\`Server "${serverName}" not found in config\`);
  }

  client = new MCPClient("${serverName}");
  await client.connect(serverConfig);
  isInitialized = true;
  
  return client;
}

/**
 * Call a tool on the ${serverName} MCP server
 */
export async function callTool<TResponse = unknown>(
  toolName: string,
  input: Record<string, unknown>,
  configPath?: string
): Promise<TResponse> {
  const mcpClient = await initializeClient(configPath);
  return mcpClient.callTool<TResponse>(toolName, input);
}

/**
 * Close the connection to the ${serverName} MCP server
 */
export async function closeClient(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    isInitialized = false;
  }
}
`;

    await this.writeFileSafe(join(libDir, "client.ts"), content);
    console.log(chalk.gray(`  - lib/client.ts`));
  }

  /**
   * Generate an action file for a single tool
   */
  private async generateActionFile(
    actionsDir: string,
    serverName: string,
    tool: DiscoveredTool
  ): Promise<string> {
    const normalizedName = this.normalizeName(tool.name);
    const fnName = TypeGenerator.toCamelCase(normalizedName) || "tool";
    const fileName = `${fnName}.ts`;
    const inputInterfaceName = `${TypeGenerator.toPascalCase(normalizedName)}Input`;
    const responseInterfaceName = `${TypeGenerator.toPascalCase(normalizedName)}Response`;

    // Generate input interface
    const inputInterface = this.typeGen.generateInputInterface(
      normalizedName,
      tool.inputSchema
    );

    // Generate response interface
    const responseInterface =
      this.typeGen.generateResponseInterface(normalizedName);

    const description = tool.description
      ? `/** ${tool.description} */`
      : `/** ${tool.name} */`;

    const content = `import { callTool, closeClient } from "../lib/client.js";

${inputInterface}

${responseInterface}

${description}
export async function ${fnName}(input: ${inputInterfaceName}): Promise<${responseInterfaceName}> {
  return callTool<${responseInterfaceName}>(${JSON.stringify(tool.name)}, input);
}

// Allow running directly: npx tsx ${fileName}
if (import.meta.url === \`file://\${process.argv[1]}\`) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: npx tsx ${fileName} '<json-input>'");
    console.log("Example: npx tsx ${fileName} '${JSON.stringify(this.getExampleInput(tool.inputSchema))}'");
    process.exit(1);
  }
  
  try {
    const input = JSON.parse(args[0]) as ${inputInterfaceName};
    ${fnName}(input)
      .then((result) => {
        console.log(JSON.stringify(result, null, 2));
        return closeClient();
      })
      .catch((error) => {
        console.error("Error:", error instanceof Error ? error.message : error);
        process.exit(1);
      });
  } catch (e) {
    console.error("Invalid JSON input:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
`;

    await this.writeFileSafe(join(actionsDir, fileName), content);
    return fileName;
  }

  /**
   * Generate example input object from schema
   */
  private getExampleInput(schema: Record<string, unknown>): Record<string, unknown> {
    const example: Record<string, unknown> = {};
    const properties = schema.properties as Record<string, unknown> | undefined;
    const required = (schema.required as string[]) || [];

    if (!properties) return example;

    for (const [name, propSchema] of Object.entries(properties)) {
      if (!required.includes(name)) continue;
      const prop = propSchema as Record<string, unknown>;
      const type = prop.type as string;
      
      switch (type) {
        case "string":
          example[name] = "example";
          break;
        case "number":
          example[name] = 0;
          break;
        case "boolean":
          example[name] = true;
          break;
        default:
          example[name] = "value";
      }
    }

    return example;
  }

  /**
   * Generate index.ts that exports all actions
   */
  private async generateSkillIndex(
    skillDir: string,
    actionFiles: string[]
  ): Promise<void> {
    const exports = actionFiles
      .map((fileName) => {
        const moduleName = fileName.replace(".ts", ".js");
        return `export * from './actions/${moduleName}';`;
      })
      .join("\n");

    const content = `// Re-export all actions from this skill
${exports}

// Re-export client utilities
export { initializeClient, closeClient } from './lib/client.js';
`;

    await this.writeFileSafe(join(skillDir, "index.ts"), content);
    console.log(chalk.gray(`  - index.ts`));
  }

  /**
   * Generate master index skill
   */
  async generateIndexSkill(
    toolsByServer: Map<string, DiscoveredTool[]>,
    outputDir: string
  ): Promise<void> {
    const skillDir = join(outputDir, "mcp-tools-index");
    await this.ensureDir(skillDir);

    const serverCount = toolsByServer.size;
    let totalTools = 0;
    for (const tools of toolsByServer.values()) {
      totalTools += tools.length;
    }

    // Build servers table
    const serversTable = [...toolsByServer.entries()]
      .map(([serverName, tools]) => {
        const skillName = this.toSkillName(serverName);
        const toolSummary = tools
          .slice(0, 2)
          .map((t) => t.name)
          .join(", ");
        return `| \`${serverName}\` | ${tools.length} | ${toolSummary}${tools.length > 2 ? "..." : ""} | \`${skillName}\` |`;
      })
      .join("\n");

    // Build quick reference
    const quickRef = [...toolsByServer.entries()]
      .map(([serverName, tools]) => {
        const toolList = tools
          .map((t) => {
            const fnName = TypeGenerator.toCamelCase(this.normalizeName(t.name)) || "tool";
            const descText = (t.description || t.name);
            const desc = descText.split("\n")[0]?.slice(0, 60) || t.name;
            return `- \`${fnName}\` - ${desc}`;
          })
          .join("\n");
        return `### ${serverName}\n\n${toolList}`;
      })
      .join("\n\n");

    const content = `---
name: mcp-tools-index
description: Index of all available MCP server tools. Load this to discover available MCP integrations and their capabilities.
---

# MCP Tools Index

This project has ${serverCount} MCP server integration(s) with ${totalTools} total tool(s).

## Available Servers

| Server | Tools | Summary | Skill |
|--------|-------|---------|-------|
${serversTable}

## How to Use

1. **Load a server skill** for detailed documentation:
${[...toolsByServer.keys()].map((s) => `   - Load \`${this.toSkillName(s)}\` skill for ${s} tools`).join("\n")}

2. **Run a tool directly**:
   \`\`\`bash
   npx tsx .claude/skills/<skill-name>/actions/<tool-name>.ts '{"param": "value"}'
   \`\`\`

3. **Import in your code**:
   \`\`\`typescript
   import { toolName } from '.claude/skills/<skill-name>/index.js';
   const result = await toolName({ /* params */ });
   \`\`\`

## Quick Reference

${quickRef}
`;

    await this.writeFileSafe(join(skillDir, "SKILL.md"), content);
    console.log(chalk.cyan(`Generated index skill: mcp-tools-index`));
  }

  /**
   * Clean up stale skill directories
   */
  async cleanupStaleSkills(
    outputDir: string,
    currentSkills: Set<string>
  ): Promise<void> {
    if (!existsSync(outputDir)) {
      return;
    }

    try {
      const entries = await readdir(outputDir, { withFileTypes: true });

      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          entry.name.startsWith("mcp-") &&
          !currentSkills.has(entry.name)
        ) {
          const skillPath = join(outputDir, entry.name);
          await rm(skillPath, { recursive: true, force: true });
          console.log(chalk.yellow(`Removed stale skill: ${entry.name}`));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        chalk.yellow(`Warning: Failed to cleanup stale skills: ${message}`)
      );
    }
  }

  /**
   * Convert a server name to a valid skill name
   */
  private toSkillName(name: string): string {
    const normalized = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/--+/g, "-");

    const skillName = `mcp-${normalized}`.slice(0, 64);
    return skillName;
  }

  /**
   * Normalize a tool name for use in code
   */
  private normalizeName(name: string): string {
    const sanitized = name
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return sanitized.length > 0 ? sanitized : "tool";
  }

  private async ensureDir(dirPath: string): Promise<void> {
    if (existsSync(dirPath)) {
      return;
    }
    try {
      await mkdir(dirPath, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GenerationError(
        `Failed to create directory "${dirPath}": ${message}`,
        error instanceof Error ? { cause: error } : undefined
      );
    }
  }

  private async writeFileSafe(
    filePath: string,
    contents: string
  ): Promise<void> {
    try {
      await writeFile(filePath, contents, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GenerationError(
        `Failed to write file "${filePath}": ${message}`,
        error instanceof Error ? { cause: error } : undefined
      );
    }
  }
}
