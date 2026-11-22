// Compiles one Svelte file with no bundler in sight: a `.svelte` component
// or a `.svelte.ts` / `.svelte.js` rune module. The host decides where the
// output goes.

/** Which output Svelte generates: for the browser, or for SSR. */
export type Side = "client" | "server";

/**
 * The parts of `svelte/compiler` svelte-bun calls, typed by shape so any
 * Svelte 5 fits.
 */
export type SvelteCompiler = {
  compile(
    source: string,
    options: Record<string, unknown>,
  ): { js: { code: string }; css: { code: string } | null };
  compileModule(
    source: string,
    options: Record<string, unknown>,
  ): { js: { code: string } };
  preprocess(
    source: string,
    preprocessors: unknown,
    options: { filename: string },
  ): Promise<{ code: string }>;
};

/** How `compileFile` compiles one file. */
export type CompileFileOptions = {
  /** As Svelte's warnings and scoped-CSS hashes should show it. */
  filename: string;
  side: Side;
  /** Svelte's development checks. */
  dev?: boolean;
  /** Svelte's HMR, client side only: the host provides `import.meta.hot`. */
  hmr?: boolean;
  /**
   * `"external"` returns the component's CSS for the host to bundle;
   * `"injected"` puts it in the JS. The default is `"external"`.
   */
  css?: "external" | "injected";
  /** Passed to Svelte's `compile()`; the options above win. */
  compilerOptions?: Readonly<Record<string, unknown>>;
};

/** One compiled file. */
export type CompiledFile = {
  js: string;
  /** The component's CSS, with `css: "external"` and a `<style>` block. */
  css?: string;
};

const RUNE_MODULE = /\.svelte\.[jt]s$/;
const typescript = new Bun.Transpiler({ loader: "ts" });

// Whether a path is a rune module, `.svelte.ts` or `.svelte.js`.
function isRuneModule(path: string): boolean {
  return RUNE_MODULE.test(path);
}

/**
 * Compiles a component or a rune module to JavaScript, and a component's
 * CSS when `css` is `"external"`.
 */
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
    return { js: compiler.compileModule(js, shared).js.code };
  }
  const result = compiler.compile(source, {
    ...shared,
    css: options.css ?? "external",
    hmr: hmr && side === "client",
  });
  const css = result.css?.code;
  return css ? { js: result.js.code, css } : { js: result.js.code };
}
