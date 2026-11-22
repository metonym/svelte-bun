/** Which output Svelte generates. */
export type Side = "client" | "server";

/** The parts of `svelte/compiler` svelte-bun calls. */
export type SvelteCompiler = {
  compile(
    source: string,
    options: Record<string, unknown>,
  ): {
    js: { code: string };
    css: { code: string } | null;
    warnings: readonly SvelteWarning[];
  };
  compileModule(
    source: string,
    options: Record<string, unknown>,
  ): { js: { code: string }; warnings: readonly SvelteWarning[] };
  preprocess(
    source: string,
    preprocessors: unknown,
    options: { filename: string },
  ): Promise<{ code: string }>;
};

/** Options for `compileFile`. */
export type CompileFileOptions = {
  /** The name Svelte's warnings and scoped-CSS hashes use. */
  filename: string;
  side: Side;
  /** Whether Svelte compiles in its development checks. */
  dev?: boolean;
  /**
   * Whether to compile in Svelte's HMR, client side only; the host provides
   * `import.meta.hot`.
   */
  hmr?: boolean;
  /**
   * `"external"` returns the CSS for the host to bundle; `"injected"`
   * keeps it in the JS.
   * @default "external"
   */
  css?: "external" | "injected";
  /** Passed to Svelte's `compile()`; the options above win. */
  compilerOptions?: Readonly<Record<string, unknown>>;
};

/** The parts of a Svelte warning svelte-bun reports. */
export type SvelteWarning = {
  message: string;
  start?: { line: number; column: number };
};

/** What `compileFile` returns. */
export type CompiledFile = {
  js: string;
  /** Svelte's warnings, each as `file:line:column message`. */
  warnings: string[];
  /** Set with `css: "external"` when the component has a `<style>`. */
  css?: string;
};

const RUNE_MODULE = /\.svelte\.[jt]s$/;
const typescript = new Bun.Transpiler({ loader: "ts" });

function isRuneModule(path: string): boolean {
  return RUNE_MODULE.test(path);
}

/** Compiles a component, or a `.svelte.ts` or `.svelte.js` rune module. */
export function compileFile(
  compiler: SvelteCompiler,
  source: string,
  options: CompileFileOptions,
): CompiledFile {
  const { filename, side, dev = false, hmr = false } = options;
  const shared = { ...options.compilerOptions, filename, generate: side, dev };
  if (isRuneModule(filename)) {
    // compileModule reads JavaScript only.
    const js = filename.endsWith(".ts")
      ? typescript.transformSync(source)
      : source;
    const result = compiler.compileModule(js, shared);
    return {
      js: result.js.code,
      warnings: result.warnings.map((w) => formatWarning(w, filename)),
    };
  }
  const result = compiler.compile(source, {
    ...shared,
    css: options.css ?? "external",
    hmr: hmr && side === "client",
  });
  const warnings = result.warnings.map((w) => formatWarning(w, filename));
  const css = result.css?.code;
  return css
    ? { js: result.js.code, css, warnings }
    : { js: result.js.code, warnings };
}

function formatWarning(warning: SvelteWarning, filename: string): string {
  const at = warning.start
    ? `:${warning.start.line}:${warning.start.column}`
    : "";
  return `${filename}${at} ${warning.message}`;
}
