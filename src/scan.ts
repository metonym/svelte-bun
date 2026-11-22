/** One block of code a Svelte file's imports are in, and how to read it. */
export type ScanPart = { code: string; loader: "js" | "ts" };

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
const TS_LANG = /\blang=["']ts["']/;

/**
 * Finds the code a Svelte file's imports are in, without compiling it: a
 * component's are all in its `<script>` blocks. For a host that hashes a
 * file's import graph, as an incremental build does.
 */
export function scanImports(source: string, path: string): ScanPart[] {
  if (!path.endsWith(".svelte")) {
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
