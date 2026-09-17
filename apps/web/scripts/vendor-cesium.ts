/**
 * Copy CesiumJS's built distribution into `public/` so the export can serve it.
 *
 * ## Why a copy rather than an import
 *
 * CesiumJS is not a library Metro can bundle. It loads its own Web Workers by
 * URL at runtime, fetches `Assets/` (the star field, the approximate terrain
 * tiles, the imagery fallbacks) and `Widgets/` (its stylesheet) by relative
 * path, and resolves all three against a global `CESIUM_BASE_URL`. A bundler
 * that inlined `Cesium.js` would produce a module whose first `new Viewer(…)`
 * immediately 404s on a worker it expects to find on disk.
 *
 * The supported answer for that shape — the one Cesium's own docs give for a
 * project without a Cesium-aware bundler plugin — is to serve the built
 * distribution as static files and point `CESIUM_BASE_URL` at it. That is what
 * this does, and it has a second benefit: the 68 MB never enters the
 * JavaScript bundle, so every page that is not the console pays nothing for it.
 * `cesium-globe.tsx` injects the script tag itself, on mount, and only there.
 *
 * ## Why it is not committed
 *
 * `public/cesium/` is gitignored. It is a verbatim copy of a pinned dependency,
 * so committing it would put 68 MB of derived bytes in every clone and every
 * diff, to say something `package.json` already says. `bun run export` runs
 * this first, which is the only moment it has to exist.
 */

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");

/**
 * Resolved through Node's algorithm rather than assumed to be `../node_modules`.
 *
 * This is a workspace: Bun hoists `cesium` to the repository root, so the path
 * relative to this app is wrong, and it would be wrong *silently* — the copy
 * would fail, the export would succeed, and the console would ship a viewer
 * that 404s. Resolving the manifest asks the package manager where it actually
 * put it.
 */
const source = join(dirname(Bun.resolveSync("cesium/package.json", web)), "Build/Cesium");
const destination = join(web, "public/cesium");

const exists = await stat(source).then(
  () => true,
  () => false,
);
if (!exists) {
  throw new Error(
    `CesiumJS's build is not at ${source}. Run \`bun install\` — the console's map cannot be exported without it.`,
  );
}

// Removed rather than merged. A stale worker left behind by an older version is
// the kind of failure that reproduces on one machine and nowhere else.
await rm(destination, { recursive: true, force: true });
await mkdir(dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });

console.log(`cesium: vendored ${source} -> ${destination}`);
