import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// undefined where no package is installed.
export type ExportsCache = Map<string, object | undefined>;

function readExports(root: string): object | undefined {
  const manifest = join(root, "package.json");
  if (!existsSync(manifest)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return {};
  const exports = "exports" in parsed ? parsed.exports : undefined;
  return typeof exports === "object" && exports !== null ? exports : {};
}

function conditionEntry(
  exports: object,
  subpath: string,
  conditions: readonly string[],
): string | undefined {
  const entry: unknown = Object.entries(exports).find(
    ([key]) => key === subpath,
  )?.[1];
  if (typeof entry !== "object" || entry === null) return undefined;
  const targets = new Map(Object.entries(entry));
  for (const condition of conditions) {
    const target: unknown = targets.get(condition);
    if (typeof target === "string") return target;
  }
  return undefined;
}

// Bun's dev server ignores a plugin's conditions, and its runtime takes
// them only from --conditions, so the plugin resolves them itself.
export function resolveCondition(
  specifier: string,
  importer: string,
  conditions: readonly string[],
  cache: ExportsCache,
): string | undefined {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
  const subpath = `.${specifier.slice(name.length)}`;
  for (let dir = dirname(importer); ; dir = dirname(dir)) {
    const root = join(dir, "node_modules", name);
    if (!cache.has(root)) cache.set(root, readExports(root));
    const exports = cache.get(root);
    if (exports !== undefined) {
      const target = conditionEntry(exports, subpath, conditions);
      return target === undefined ? undefined : join(root, target);
    }
    if (dir === dirname(dir)) return undefined;
  }
}
