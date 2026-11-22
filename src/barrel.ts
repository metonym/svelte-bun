import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Each barrel's exports: name -> the file and name it re-exports, or
// undefined for a module that does more than re-export.
export type BarrelCache = Map<string, Map<string, Target> | undefined>;

type Target = { file: string; name: string };

const SCRIPT = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g;
// `import { a, b as c } from "lib"`, or `import A from "lib"`.
const IMPORT =
  /^([ \t]*)import\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*from\s*(["'])([^"']+)\4;?/gm;
const REEXPORT = /^export\s*\{([^}]*)\}\s*from\s*(["'])(\.{1,2}\/[^"']+)\2$/;
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const BARE = /^[@a-z]/;
const ALIAS = /\s+as\s+/;

function specifiers(list: string): { name: string; local: string }[] {
  return list
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name = "", local = name] = part.split(ALIAS);
      return { name, local };
    });
}

function readBarrel(file: string): Map<string, Target> | undefined {
  if (!existsSync(file)) return undefined;
  const statements = readFileSync(file, "utf8")
    .replace(COMMENT, "")
    // A statement may span lines: `export {\n  a,\n} from "./a.js"`.
    .split(/;|\n(?=\s*(?:export|import)\b)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  const targets = new Map<string, Target>();
  for (const statement of statements) {
    const reexport = REEXPORT.exec(statement);
    if (!reexport) return undefined;
    const target = join(dirname(file), reexport[3] ?? "");
    for (const { name, local } of specifiers(reexport[1] ?? "")) {
      if (name.startsWith("type ")) continue;
      targets.set(local, { file: target, name });
    }
  }
  return targets;
}

function rewriteImport(
  statement: string,
  indent: string,
  imports: { name: string; local: string }[],
  barrel: Map<string, Target>,
): string {
  if (imports.some(({ name }) => name.startsWith("type "))) return statement;
  const lines = [];
  for (const { name, local } of imports) {
    const target = barrel.get(name);
    if (!target) return statement;
    const from = JSON.stringify(target.file);
    lines.push(
      target.name === "default"
        ? `${indent}import ${local} from ${from};`
        : `${indent}import { ${target.name} as ${local} } from ${from};`,
    );
  }
  return lines.join("\n");
}

// compat: Bun drops a barrel's unused components but keeps their CSS
// imports, so a component imports what it uses from the files a barrel
// that only re-exports points at.
export function rewriteBarrelImports(
  source: string,
  importer: string,
  resolveEntry: (specifier: string, importer: string) => string | undefined,
  cache: BarrelCache,
): string {
  return source.replace(
    SCRIPT,
    (_block, open: string, code: string, close: string) => {
      const rewritten = code.replace(
        IMPORT,
        (
          statement,
          indent: string,
          list: string | undefined,
          defaultName: string | undefined,
          _quote,
          specifier: string,
        ) => {
          if (!BARE.test(specifier)) return statement;
          const entry = resolveEntry(specifier, importer);
          if (entry === undefined || !entry.includes("node_modules")) {
            return statement;
          }
          if (!cache.has(entry)) cache.set(entry, readBarrel(entry));
          const barrel = cache.get(entry);
          const imports = defaultName
            ? [{ name: "default", local: defaultName }]
            : specifiers(list ?? "");
          return barrel
            ? rewriteImport(statement, indent, imports, barrel)
            : statement;
        },
      );
      return `${open}${rewritten}${close}`;
    },
  );
}
