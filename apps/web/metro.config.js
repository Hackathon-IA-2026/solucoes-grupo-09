/**
 * Metro has to be told two things about this monorepo, and neither is optional
 * once `@wattsteer/core` is imported from a screen.
 *
 *  1. **The workspace root is a watch folder.** The package is a symlink into
 *     `../../packages/core`, and Metro will not read files outside the project
 *     root unless it is told they exist.
 *  2. **`./thing.js` inside `packages/core` means `./thing.ts`.** The package
 *     is consumed as TypeScript source, and `apps/api` compiles it under
 *     `moduleResolution: "NodeNext"`, which *requires* the `.js` extension on
 *     every relative import. TypeScript resolves that to the `.ts` file;
 *     Metro's default resolver does not, and `expo export` dies on
 *     `Unable to resolve module ./causality.js`. Stripping the extension and
 *     delegating restores the TypeScript rule without touching the imports,
 *     which cannot be changed without breaking the gateway's build.
 *
 * The rewrite is deliberately narrow — relative specifiers only, `.js` only,
 * and only where the extensionless form actually resolves — so a real missing
 * module still reports itself as a missing module.
 */

const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..", "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // Not a TypeScript source import after all — fall through and let the
      // default resolver report the real failure.
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
