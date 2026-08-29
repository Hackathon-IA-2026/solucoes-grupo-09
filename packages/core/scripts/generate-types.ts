/**
 * `schema/*.json` → `src/types.generated.ts`.
 *
 * The schema directory is the authority; this script is the only thing that
 * translates it into TypeScript, and its output is **checked in** so that a
 * reader of the repository can see the contract without running a build.
 * `packages/core/test/schema-generated-types.test.ts` regenerates in memory and
 * diffs, so a schema edited without regenerating is a failing test rather than
 * a stale file nobody notices.
 *
 * Two things are emitted from one walk, which is what keeps them in step:
 *
 *  - the **camelCase interfaces** the web app compiles against, and
 *  - `WIRE_SHAPES`, the **wire-name table** `src/wire.ts` renames through.
 *
 * Emitting the table from the same walk is the point. A hand-written mapping
 * beside generated types is a second contract; a regular expression over keys
 * is not invertible (see the note in `src/wire.ts`). The table is both, and it
 * is generated, so a field renamed in the schema is a compile error in the web
 * app rather than an `undefined` on a chart.
 *
 * Run: `bun run --cwd packages/core generate:types`
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toCamelKey } from "../src/casing.js";
import { readSchemas } from "../src/schema.js";

type Node = Record<string, unknown>;

interface Emitted {
  /** The TypeScript declaration, doc comment included. */
  declaration: string;
  /** The `WIRE_SHAPES` entry, if this type is an object with named fields. */
  shape?: string;
}

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "types.generated.ts",
);

/** `forecast_hour` → `ForecastHour`; `grid-now.schema.json` → `GridNow`. */
function pascal(raw: string): string {
  return raw
    .replace(/\.schema\.json$/, "")
    .split(/[-_./\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
}

/** A JSON Schema `description` as a TypeScript doc comment. */
function docComment(node: Node, indent = ""): string {
  const description = typeof node.description === "string" ? node.description : "";
  if (description === "") {
    return "";
  }
  const words = description.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > 76) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join("\n")}\n${indent} */\n`;
}

class Generator {
  private readonly schemas = readSchemas();
  /** Canonical ref (`file#/pointer`) → the TypeScript name it was given. */
  private readonly names = new Map<string, string>();
  /** Name → the node it was registered from. Insertion order is emission order. */
  private readonly nodes = new Map<string, { ref: string; node: Node }>();

  run(): string {
    for (const [file, schema] of this.schemas) {
      const root = schema as Node;
      if (
        root.type !== undefined ||
        root.oneOf !== undefined ||
        root.properties !== undefined
      ) {
        this.register(file, root, this.titleOf(root, file));
      }
      const defs = (root.$defs ?? {}) as Record<string, Node>;
      for (const [key, node] of Object.entries(defs)) {
        this.register(`${file}#/$defs/${key}`, node, this.titleOf(node, key));
      }
    }

    const emitted: Emitted[] = [];
    // `nodes` grows while we walk it: an inline object inside a registered type
    // is registered as it is met, and then emitted in turn.
    const seen = new Set<string>();
    let progress = true;
    while (progress) {
      progress = false;
      for (const [name, entry] of [...this.nodes]) {
        if (seen.has(name)) {
          continue;
        }
        seen.add(name);
        progress = true;
        emitted.push(this.emit(name, entry.ref, entry.node));
      }
    }

    return this.render(emitted);
  }

  private titleOf(node: Node, fallback: string): string {
    const title = typeof node.title === "string" ? node.title : "";
    return title === "" ? pascal(fallback) : pascal(title);
  }

  private register(ref: string, node: Node, name: string): string {
    const existing = this.names.get(ref);
    if (existing !== undefined) {
      return existing;
    }
    if (this.nodes.has(name)) {
      throw new Error(`Two schema nodes both want the name ${name}: ${ref}`);
    }
    this.names.set(ref, name);
    this.nodes.set(name, { ref, node });
    return name;
  }

  /** Resolve a `$ref` written relative to the file it appears in. */
  private resolve(ref: string, fromFile: string): { ref: string; node: Node } {
    const [file, pointer] = ref.split("#");
    const target = file === undefined || file === "" ? fromFile : file;
    const schema = this.schemas.get(target);
    if (schema === undefined) {
      throw new Error(`Unknown schema file ${target} (from ${fromFile})`);
    }
    let node = schema as Node;
    if (pointer !== undefined && pointer !== "") {
      for (const segment of pointer.split("/").slice(1)) {
        node = (node as Record<string, Node>)[
          segment.replace(/~1/g, "/").replace(/~0/g, "~")
        ];
        if (node === undefined) {
          throw new Error(`Unresolvable $ref ${ref} in ${fromFile}`);
        }
      }
    }
    const canonical =
      pointer === undefined || pointer === "" ? target : `${target}#${pointer}`;
    return { ref: canonical, node };
  }

  /** The name of an already-registered node, registering it if it is new. */
  private nameFor(ref: string, fromFile: string): string {
    const { ref: canonical, node } = this.resolve(ref, fromFile);
    const known = this.names.get(canonical);
    if (known !== undefined) {
      return known;
    }
    const key = canonical.split("/").pop() ?? canonical;
    return this.register(canonical, node, this.titleOf(node, key));
  }

  private emit(name: string, ref: string, node: Node): Emitted {
    const file = ref.split("#")[0] ?? "";
    if (node.properties !== undefined) {
      return this.emitObject(name, file, node);
    }
    if (node.oneOf !== undefined) {
      return this.emitUnion(name, file, node);
    }
    return {
      declaration: `${docComment(node)}export type ${name} = ${this.typeOf(node, file, name)};`,
    };
  }

  private emitObject(name: string, file: string, node: Node): Emitted {
    const properties = node.properties as Record<string, Node>;
    const required = new Set((node.required ?? []) as string[]);
    const fields: string[] = [];
    const shape: string[] = [];
    for (const [wire, property] of Object.entries(properties)) {
      const camel = toCamelKey(wire);
      const optional = required.has(wire) ? "" : "?";
      const type = this.typeOf(property, file, `${name}${pascal(wire)}`);
      fields.push(`${docComment(property, "  ")}  ${camel}${optional}: ${type};`);
      shape.push(
        `    ${JSON.stringify(camel)}: ${this.shapeField(wire, property, file, `${name}${pascal(wire)}`, required.has(wire))},`,
      );
    }
    return {
      declaration: `${docComment(node)}export interface ${name} {\n${fields.join("\n")}\n}`,
      shape: `  ${JSON.stringify(name)}: {\n${shape.join("\n")}\n  },`,
    };
  }

  private emitUnion(name: string, file: string, node: Node): Emitted {
    const branches = (node.oneOf as Node[]).map((branch, index) =>
      this.typeOf(branch, file, `${name}${index}`),
    );
    // A discriminated union renames keys the same way whichever branch a value
    // took, so the shape is the union of the branches' fields. The codec only
    // renames; it never decides which variant it is looking at.
    const merged = new Map<string, string>();
    for (const branch of node.oneOf as Node[]) {
      const resolved =
        branch.$ref === undefined
          ? branch
          : this.resolve(branch.$ref as string, file).node;
      const properties = (resolved.properties ?? {}) as Record<string, Node>;
      const branchFile =
        branch.$ref === undefined
          ? file
          : (this.resolve(branch.$ref as string, file).ref.split("#")[0] ?? file);
      for (const [wire, property] of Object.entries(properties)) {
        merged.set(
          toCamelKey(wire),
          this.shapeField(wire, property, branchFile, `${name}${pascal(wire)}`, false),
        );
      }
    }
    const shape =
      merged.size === 0
        ? undefined
        : `  ${JSON.stringify(name)}: {\n${[...merged]
            .map(([camel, field]) => `    ${JSON.stringify(camel)}: ${field},`)
            .join("\n")}\n  },`;
    return {
      declaration: `${docComment(node)}export type ${name} = ${branches.join(" | ")};`,
      shape,
    };
  }

  /** One `WireField` literal: the wire name, and the nested shape to recurse into. */
  private shapeField(
    wire: string,
    property: Node,
    file: string,
    inlineName: string,
    required: boolean,
  ): string {
    const parts = [`wire: ${JSON.stringify(wire)}`];
    const nested = this.nestedShapeName(property, file, inlineName);
    if (nested !== null) {
      parts.push(`shape: ${JSON.stringify(nested.name)}`);
      if (nested.list) {
        parts.push("list: true");
      }
    }
    if (!required) {
      parts.push("optional: true");
    }
    return `{ ${parts.join(", ")} }`;
  }

  private nestedShapeName(
    property: Node,
    file: string,
    inlineName: string,
  ): { name: string; list: boolean } | null {
    const unwrapped = this.unwrapNullable(property, file);
    if (unwrapped === null) {
      return null;
    }
    const { node, file: nodeFile } = unwrapped;
    if (node.$ref !== undefined) {
      const target = this.resolve(node.$ref as string, nodeFile);
      if (target.node.properties === undefined && target.node.oneOf === undefined) {
        return null;
      }
      return { name: this.nameFor(node.$ref as string, nodeFile), list: false };
    }
    if (node.type === "array") {
      const items = node.items as Node | undefined;
      if (items === undefined || items === null || typeof items !== "object") {
        return null;
      }
      const inner = this.nestedShapeName(items, nodeFile, `${inlineName}Item`);
      return inner === null ? null : { name: inner.name, list: true };
    }
    if (node.properties !== undefined || node.oneOf !== undefined) {
      // An inline object. Given a name derived from where it sits, so the codec
      // has something to recurse into and the web app has something to import.
      return {
        name: this.register(`${file}#inline/${inlineName}`, node, inlineName),
        list: false,
      };
    }
    return null;
  }

  /**
   * `{ oneOf: [ {type:"null"}, X ] }` is how the schemas write "nullable", so
   * that the null is a stated member of the contract rather than a missing key.
   * Unwrap it for typing and for the codec; the null itself needs no shape.
   */
  private unwrapNullable(node: Node, file: string): { node: Node; file: string } | null {
    if (node.oneOf === undefined) {
      return { node, file };
    }
    const branches = (node.oneOf as Node[]).filter((branch) => branch.type !== "null");
    if (branches.length !== 1 || (node.oneOf as Node[]).length !== 2) {
      return { node, file };
    }
    return { node: branches[0] as Node, file };
  }

  private typeOf(node: Node, file: string, inlineName: string): string {
    if (node.$ref !== undefined) {
      return this.nameFor(node.$ref as string, file);
    }
    if (node.const !== undefined) {
      return JSON.stringify(node.const);
    }
    if (Array.isArray(node.enum)) {
      return (node.enum as unknown[]).map((value) => JSON.stringify(value)).join(" | ");
    }
    if (node.oneOf !== undefined) {
      const nullable = this.unwrapNullable(node, file);
      if (nullable !== null && nullable.node !== node) {
        return `${this.typeOf(nullable.node, file, inlineName)} | null`;
      }
      return (node.oneOf as Node[])
        .map((branch, index) => this.typeOf(branch, file, `${inlineName}${index}`))
        .join(" | ");
    }
    if (Array.isArray(node.prefixItems)) {
      return `[${(node.prefixItems as Node[])
        .map((item, index) => this.typeOf(item, file, `${inlineName}${index}`))
        .join(", ")}]`;
    }
    if (node.type === "array") {
      const items = node.items as Node | undefined;
      if (items === undefined || typeof items !== "object") {
        return "unknown[]";
      }
      return `${wrap(this.typeOf(items, file, `${inlineName}Item`))}[]`;
    }
    if (node.properties !== undefined) {
      return this.register(`${file}#inline/${inlineName}`, node, inlineName);
    }
    if (
      node.additionalProperties !== undefined &&
      typeof node.additionalProperties === "object"
    ) {
      return `Record<string, ${this.typeOf(node.additionalProperties as Node, file, `${inlineName}Value`)}>`;
    }
    const types = Array.isArray(node.type)
      ? (node.type as string[])
      : [node.type as string];
    return types.map(primitive).join(" | ");
  }

  private render(emitted: Emitted[]): string {
    const shapes = emitted
      .filter((entry) => entry.shape !== undefined)
      .map((entry) => entry.shape);
    return `${HEADER}
${emitted.map((entry) => entry.declaration).join("\n\n")}

/**
 * One field of a wire object: the \`snake_case\` name it travels under, the
 * shape to recurse into if it is an object or a list of them, and whether the
 * schema makes it optional.
 */
export interface WireField {
  readonly wire: string;
  /**
   * The nested shape to recurse into, as a \`WireShapeName\`. Typed \`string\`
   * rather than \`WireShapeName\` because the name union is derived from
   * \`WIRE_SHAPES\` itself and the two would reference each other; \`src/wire.ts\`
   * narrows it at the one place it is used.
   */
  readonly shape?: string;
  readonly list?: boolean;
  readonly optional?: boolean;
}

/** A wire object, keyed by the camelCase name the interface above declares. */
export type WireShape = Readonly<Record<string, WireField>>;

/**
 * The whole translation table, generated from \`schema/\`.
 *
 * \`src/wire.ts\` is the only module that reads it. A field renamed in the
 * schema changes both the interface and this table in one regeneration, which
 * is what makes the rename a compile error in the web app.
 */
export const WIRE_SHAPES = {
${shapes.join("\n")}
} as const satisfies Record<string, WireShape>;

/** The name of a generated wire object. */
export type WireShapeName = keyof typeof WIRE_SHAPES;

/**
 * Every error code, as a type, derived from the same schema the gateway
 * validates against. \`packages/core/src/errors.ts\` holds the authority — the
 * code-to-status table — and this is the wire's view of it;
 * \`test/schema-generated-types.test.ts\` asserts the two agree member for
 * member, so neither can gain a code the other has not heard of.
 */
export type WireErrorCode = ErrorEnvelopeError["code"];
`;
  }
}

function wrap(type: string): string {
  return /[|&]/.test(type) ? `(${type})` : type;
}

function primitive(type: string): string {
  switch (type) {
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "object":
      return "Record<string, unknown>";
    case "array":
      return "unknown[]";
    default:
      return "unknown";
  }
}

const HEADER = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source: \`packages/core/schema/*.json\`, the cross-language authority.
 * Generator: \`packages/core/scripts/generate-types.ts\`.
 * Regenerate: \`bun run --cwd packages/core generate:types\`.
 *
 * Checked in on purpose: a reader of the repository sees the wire contract
 * without running a build, and a schema edited without regenerating fails
 * \`packages/core/test/schema-generated-types.test.ts\` rather than drifting.
 *
 * The interfaces are \`camelCase\` — the vocabulary the screens already use.
 * The wire is \`snake_case\`, and \`WIRE_SHAPES\` at the bottom is the table
 * \`src/wire.ts\` renames through, in exactly one place.
 */
`;

/**
 * The emitted source, run through the repository's formatter.
 *
 * Not cosmetic: the checked-in file has to survive `bun run lint`, and the
 * test that asserts it is current compares it byte for byte with this string.
 * Formatting here is what makes those two facts compatible without exempting
 * a generated file from the linter, which would be one more place the contract
 * is not checked.
 */
function format(source: string): string {
  const formatted = Bun.spawnSync(
    ["bunx", "biome", "format", "--stdin-file-path=types.generated.ts"],
    { stdin: Buffer.from(source, "utf8"), stderr: "pipe" },
  );
  if (formatted.exitCode !== 0) {
    throw new Error(`biome format failed: ${formatted.stderr.toString()}`);
  }
  return formatted.stdout.toString();
}

/** The generated source, for the test that asserts the checked-in file is current. */
export const generatedSource = format(new Generator().run());

if (import.meta.main) {
  writeFileSync(OUT, generatedSource, "utf8");
  process.stdout.write(`wrote ${OUT}\n`);
}
