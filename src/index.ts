import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { BunPlugin, OnLoadArgs } from "bun";

import { compileFile, type Side, type SvelteCompiler } from "./component.ts";
import { productionByEnv, workingDirectory } from "./env.ts";
import { SvelteBunError } from "./errors.ts";
import { inlineEsmEnv } from "./esm-env.ts";
import { type ExportsCache, resolveCondition } from "./resolve.ts";

/** How the plugin compiles; each key also reads from `svelte.config.js`. */
export type SvelteBunOptions = {
  /**
   * Where `svelte.config.js` and the app's `svelte` resolve from. The
   * default is the working directory.
   */
  root?: string;
  /**
   * Production output: no dev checks or HMR, and Svelte's dev-only code
   * dropped. The default is `NODE_ENV === "production"`.
   */
  production?: boolean;
  /**
   * The output to generate. The default is what the dev server asks for,
   * else `"client"`.
   */
  side?: Side;
  /** Svelte preprocessors. The default is `svelte.config.js`'s. */
  preprocess?: unknown;
  /** Passed to Svelte's `compile()`. The default is `svelte.config.js`'s. */
  compilerOptions?: Readonly<Record<string, unknown>>;
  /**
   * `"external"` bundles a component's CSS as a stylesheet beside it, so
   * its relative `@import`s resolve; `"injected"` puts it in the JS. The
   * default is `"external"`.
   */
  css?: "external" | "injected";
  /**
   * The source to compile in place of a `.svelte` file's own, or
   * `undefined` for its own, before preprocessing: for a source rewriter
   * such as carbon-preprocess-svelte's `optimizeCarbonBun()`.
   */
  load?: (path: string) => { code: string } | string | undefined;
};

type Config = {
  preprocess?: unknown;
  compilerOptions?: Readonly<Record<string, unknown>>;
};

type Setup = {
  compiler: SvelteCompiler;
  preprocess: unknown;
  compilerOptions: Readonly<Record<string, unknown>> | undefined;
};

const SVELTE = /\.svelte(\.[jt]s)?$/;
const SVELTE_CSS = /\.svelte\.css$/;
const BARE = /^[@a-z]/;
const SVELTE_RUNTIME = /[\\/]node_modules[\\/]svelte[\\/]src[\\/].+\.js$/;
const LIVE_GLOBAL = /\$\.(document|window)\b/g;
const CONFIG_FILES = [
  "svelte.config.js",
  "svelte.config.mjs",
  "svelte.config.ts",
];

// The config module's default export, read as svelte-bun reads it.
function parseConfig(module: unknown, file: string): Config {
  const config =
    typeof module === "object" && module !== null && "default" in module
      ? module.default
      : undefined;
  if (typeof config !== "object" || config === null) return {};
  const parsed: Config = {};
  if ("preprocess" in config) parsed.preprocess = config.preprocess;
  if ("compilerOptions" in config) {
    const options = config.compilerOptions;
    if (typeof options !== "object" || options === null) {
      throw new SvelteBunError(
        "SB_CONFIG_INVALID",
        `svelte-bun config: ${basename(file)}: compilerOptions is ${String(options)}: make it an object`,
      );
    }
    parsed.compilerOptions = Object.fromEntries(Object.entries(options));
  }
  return parsed;
}

async function loadConfig(root: string): Promise<Config> {
  const file = CONFIG_FILES.map((name) => join(root, name)).find((path) =>
    existsSync(path),
  );
  if (!file) return {};
  let module: unknown;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (cause) {
    throw new SvelteBunError(
      "SB_CONFIG_UNREADABLE",
      `svelte-bun config: ${basename(file)} failed to load: fix the error it throws`,
      { cause },
    );
  }
  return parseConfig(module, file);
}

function isCompiler(module: unknown): module is SvelteCompiler {
  return (
    typeof module === "object" &&
    module !== null &&
    "compile" in module &&
    typeof module.compile === "function" &&
    "compileModule" in module &&
    typeof module.compileModule === "function" &&
    "preprocess" in module &&
    typeof module.preprocess === "function"
  );
}

async function loadCompiler(root: string): Promise<SvelteCompiler> {
  let module: unknown;
  try {
    module = await import(Bun.resolveSync("svelte/compiler", root));
  } catch (cause) {
    throw new SvelteBunError(
      "SB_SVELTE_MISSING",
      `svelte-bun: svelte isn't installed in ${root}: run \`bun add -d svelte\``,
      { cause },
    );
  }
  if (!isCompiler(module)) {
    throw new SvelteBunError(
      "SB_SVELTE_MISSING",
      `svelte-bun: the svelte in ${root} has no Svelte 5 compiler: run \`bun add -d svelte@5\``,
    );
  }
  return module;
}

// Bun's dev server passes `side` and `hmr` to onLoad; Bun.build doesn't.
function devServerSide(args: OnLoadArgs): Side | undefined {
  if (!("side" in args)) return undefined;
  return args.side === "server" ? "server" : "client";
}

function devServerHmr(args: OnLoadArgs): boolean {
  return "hmr" in args ? args.hmr !== false : true;
}

/** Svelte for `Bun.build` and Bun's dev server. */
export function svelte(options: SvelteBunOptions = {}): BunPlugin {
  const root = options.root ?? workingDirectory();
  const production = options.production ?? productionByEnv();
  const stylesheets = new Map<string, { css: string; from: string }>();
  const exportsCache: ExportsCache = new Map();
  // Loaded on first use: the dev server loads plugins before the app runs.
  let setup: Promise<Setup> | undefined;
  const ready = (): Promise<Setup> =>
    (setup ??= (async () => {
      const config = await loadConfig(root);
      return {
        compiler: await loadCompiler(root),
        preprocess: options.preprocess ?? config.preprocess,
        compilerOptions: options.compilerOptions ?? config.compilerOptions,
      };
    })());

  return {
    name: "svelte-bun",
    setup(build) {
      build.onResolve({ filter: BARE }, (args) => {
        const path = resolveCondition(args.path, args.importer, exportsCache);
        return path === undefined ? undefined : { path };
      });

      build.onLoad({ filter: SVELTE }, async (args) => {
        const { compiler, preprocess, compilerOptions } = await ready();
        const fromDevServer = devServerSide(args);
        const side = options.side ?? fromDevServer ?? "client";
        const loaded = options.load?.(args.path);
        const replaced = typeof loaded === "string" ? loaded : loaded?.code;
        let source = replaced ?? (await Bun.file(args.path).text());
        let out;
        try {
          if (preprocess !== undefined && args.path.endsWith(".svelte")) {
            const filename = args.path;
            source = (
              await compiler.preprocess(source, preprocess, { filename })
            ).code;
          }
          out = compileFile(compiler, source, {
            filename: args.path,
            side,
            dev: !production,
            // Only the dev server provides `import.meta.hot`.
            hmr:
              !production && fromDevServer !== undefined && devServerHmr(args),
            ...(options.css ? { css: options.css } : {}),
            ...(compilerOptions ? { compilerOptions } : {}),
          });
        } catch (cause) {
          throw new SvelteBunError(
            "SB_COMPILE_FAILED",
            `svelte-bun: ${args.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
        let js = out.js;
        // compat: Bun's dev server re-exports Svelte's `$document` and
        // `$window` by value, before `mount` assigns them, so the client
        // reads the globals instead.
        if (side === "client" && fromDevServer !== undefined) {
          js = js.replace(LIVE_GLOBAL, "$1");
        }
        if (side === "client" && out.css !== undefined) {
          // Beside the component, so the CSS's relative `@import`s resolve.
          const id = `${args.path}.css`;
          stylesheets.set(id, { css: out.css, from: args.path });
          js += `\nimport ${JSON.stringify(`./${basename(id)}`)};`;
        }
        return { contents: js, loader: "js" };
      });

      build.onResolve({ filter: SVELTE_CSS }, (args) => ({
        path: join(dirname(args.importer), args.path),
      }));
      build.onLoad({ filter: SVELTE_CSS }, (args) => {
        const entry = stylesheets.get(args.path);
        if (!entry) {
          throw new SvelteBunError(
            "SB_INTERNAL",
            `svelte-bun: no CSS was compiled for ${args.path}`,
          );
        }
        return { contents: entry.css, loader: "css", watchFiles: [entry.from] };
      });

      if (production) {
        const browser = (options.side ?? "client") === "client";
        build.onLoad({ filter: SVELTE_RUNTIME }, async (args) => ({
          contents: inlineEsmEnv(await Bun.file(args.path).text(), {
            dev: false,
            browser,
          }),
          loader: "js",
        }));
      }
    },
  };
}

const plugin: BunPlugin = svelte();

// eslint-disable-next-line import/no-default-export -- bunfig's [serve.static] plugins loads a module's default export, and passes no options
export { plugin as default };
