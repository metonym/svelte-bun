import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import pkg from "../package.json" with { type: "json" };
import type { CompiledFile } from "./component.ts";

// A preprocessed source, or a compiled one, on disk under a hash of
// everything it was made from, so a warm `Bun.build` skips the work.

type Part = string | number | boolean | undefined;

export type CompileCache = {
  preprocessed(key: readonly Part[]): string | undefined;
  savePreprocessed(key: readonly Part[], code: string): void;
  compiled(key: readonly Part[]): CompiledFile | undefined;
  saveCompiled(key: readonly Part[], file: CompiledFile): void;
};

// What decides a preprocessor's output beyond the file: the config that
// names the preprocessors, and the lockfile that pins their versions,
// since the functions themselves can't be hashed.
const SALT_FILES = [
  "svelte.config.js",
  "svelte.config.mjs",
  "svelte.config.ts",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

function hashOf(parts: readonly Part[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const part of parts) {
    // A separator no part contains, so ["ab", "c"] and ["a",
    // "bc"] differ.
    hasher.update(`${part === undefined ? "\u0001" : String(part)}\u0000`);
  }
  return hasher.digest("hex");
}

// Only what exists counts, so adding a lockfile later misses once.
export function preprocessSalt(root: string): string {
  return hashOf(
    SALT_FILES.map((name) => {
      const path = join(root, name);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    }),
  );
}

function isCompiled(value: unknown): value is CompiledFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "js" in value &&
    typeof value.js === "string" &&
    "warnings" in value &&
    Array.isArray(value.warnings)
  );
}

// One file per entry, so builds can share the folder; a broken entry is
// a miss.
export function createCompileCache(dir: string): CompileCache {
  mkdirSync(dir, { recursive: true });
  const read = (name: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      return undefined;
    }
  };
  // Written beside its name and renamed into place, so a build that
  // reads the entry never sees half of it.
  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value));
      renameSync(temporary, path);
    } catch {
      // A cache that can't be written only costs the next build time.
    }
  };
  const named = (level: string, key: readonly Part[]) =>
    `${hashOf([pkg.version, level, ...key])}.json`;
  return {
    preprocessed(key) {
      const value = read(named("preprocess", key));
      return typeof value === "string" ? value : undefined;
    },
    savePreprocessed(key, code) {
      write(named("preprocess", key), code);
    },
    compiled(key) {
      const value = read(named("compile", key));
      return isCompiled(value) ? value : undefined;
    },
    saveCompiled(key, file) {
      write(named("compile", key), file);
    },
  };
}
