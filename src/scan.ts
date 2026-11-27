/** Code a Svelte file's imports are in, and its loader. */
export type ScanPart = { code: string; loader: "js" | "ts" };

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
const TS_LANG = /\blang=["']ts["']/;

/**
 * Finds the code a Svelte file's imports are in, without compiling it. A
 * file ending in one of `extensions` is a component; any other, script.
 */
export function scanImports(
  source: string,
  path: string,
  extensions: readonly string[] = [".svelte"],
): ScanPart[] {
  if (!extensions.some((extension) => path.endsWith(extension))) {
    return [{ code: source, loader: path.endsWith(".ts") ? "ts" : "js" }];
  }
  const parts: ScanPart[] = [...source.matchAll(SCRIPT)].map((match) => ({
    code: match[2] ?? "",
    loader: TS_LANG.test(match[1] ?? "") ? "ts" : "js",
  }));
  // A compiled component imports Svelte's runtime too.
  parts.push({ code: 'import "svelte/internal/client";', loader: "js" });
  return parts;
}
