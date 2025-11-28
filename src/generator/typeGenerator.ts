export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];
  $ref?: string;
  description?: string;
  additionalProperties?: boolean | JSONSchema;
}

export class TypeGenerator {
  static toPascalCase(str: string): string {
    return str
      .replace(/[-_](.)/g, (_, char) => char.toUpperCase())
      .replace(/^(.)/, (char) => char.toUpperCase());
  }

  static toCamelCase(str: string): string {
    return str
      .replace(/[-_](.)/g, (_, char) => char.toUpperCase())
      .replace(/^(.)/, (char) => char.toLowerCase());
  }

  generateInterface(
    name: string,
    schema: JSONSchema,
    indent: string = "",
    addIndexSignature: boolean = false
  ): string {
    if (!schema || typeof schema !== "object") {
      return `${indent}export interface ${name} {\n${indent}  [key: string]: unknown;\n${indent}}`;
    }

    const properties = schema.properties || {};
    const required = schema.required || [];

    if (Object.keys(properties).length === 0) {
      return `${indent}export interface ${name} {\n${indent}  [key: string]: unknown;\n${indent}}`;
    }

    let interfaceCode = `${indent}export interface ${name} {\n`;

    for (const [propName, propSchema] of Object.entries(properties)) {
      const isRequired = required.includes(propName);
      const optional = isRequired ? "" : "?";
      const propType = this.schemaToType(propSchema);

      if (propSchema.description) {
        interfaceCode += `${indent}  /** ${propSchema.description} */\n`;
      }

      interfaceCode += `${indent}  ${propName}${optional}: ${propType};\n`;
    }

    if (addIndexSignature) {
      interfaceCode += `${indent}  [key: string]: unknown;\n`;
    }

    interfaceCode += `${indent}}`;

    return interfaceCode;
  }

  schemaToType(schema: JSONSchema): string {
    if (!schema || typeof schema !== "object") {
      return "unknown";
    }

    if (schema.enum) {
      return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
    }

    if (schema.anyOf) {
      return schema.anyOf.map((s) => this.schemaToType(s)).join(" | ");
    }
    if (schema.oneOf) {
      return schema.oneOf.map((s) => this.schemaToType(s)).join(" | ");
    }

    if (schema.allOf) {
      return schema.allOf.map((s) => this.schemaToType(s)).join(" & ");
    }

    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

    switch (type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        if (schema.items) {
          const itemType = this.schemaToType(schema.items);
          return `${itemType}[]`;
        }
        return "unknown[]";
      case "object":
        if (schema.properties && Object.keys(schema.properties).length > 0) {
          const props = Object.entries(schema.properties)
            .map(([key, propSchema]) => {
              const isRequired = schema.required?.includes(key);
              const optional = isRequired ? "" : "?";
              return `${key}${optional}: ${this.schemaToType(propSchema)}`;
            })
            .join("; ");
          return `{ ${props} }`;
        }
        if (schema.additionalProperties === false) {
          return "Record<string, never>";
        }
        if (
          schema.additionalProperties &&
          typeof schema.additionalProperties === "object"
        ) {
          return `Record<string, ${this.schemaToType(
            schema.additionalProperties
          )}>`;
        }
        return "Record<string, unknown>";
      default:
        return "unknown";
    }
  }

  generateResponseInterface(
    toolName: string,
    outputSchema?: JSONSchema
  ): string {
    const interfaceName = `${TypeGenerator.toPascalCase(toolName)}Response`;

    if (!outputSchema) {
      return `export interface ${interfaceName} {\n  content: unknown;\n}`;
    }

    return this.generateInterface(interfaceName, outputSchema);
  }

  generateInputInterface(toolName: string, inputSchema: JSONSchema): string {
    const interfaceName = `${TypeGenerator.toPascalCase(toolName)}Input`;
    return this.generateInterface(interfaceName, inputSchema, "", true);
  }
}
