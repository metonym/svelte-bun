import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { BunPlugin, OnLoadArgs } from "bun";

import { type BarrelCache, rewriteBarrelImports } from "./barrel.ts";
import { compileFile, type Side, type SvelteCompiler } from "./component.ts";
import { productionByEnv, warn, workingDirectory } from "./env.ts";
import { SvelteBunError } from "./errors.ts";
import { inlineEsmEnv } from "./esm-env.ts";
import { type ExportsCache, resolveCondition } from "./resolve.ts";

/** Options for `svelte()`; the bunfig entries read `svelte.config.js`. */
export type SvelteBunOptions = {
  /**
   * Where `svelte.config.js` and `svelte` resolve from.
   * @default the working directory
   */
  root?: string;
  /**
   * Whether to drop Svelte's dev checks, HMR, and dev-only runtime code.
   * @default NODE_ENV === "production"
   */
  production?: boolean;
  /** @default what the dev server asks for, else "client" */
  side?: Side;
  /** @default svelte.config.js's */
  preprocess?: unknown;
  /** @default svelte.config.js's */
  compilerOptions?: Readonly<Record<string, unknown>>;
  /**
   * `"external"` writes the CSS beside the component, so its relative
   * `@import`s resolve; `"injected"` keeps it in the JS.
   * @default "external"
   */
  css?: "external" | "injected";
  /**
   * Export conditions, first match wins; a custom renderer puts
   * `svelte-custom-renderer` first.
   * @default ["svelte"]
   */
  conditions?: readonly string[];
  /** @default prints each warning, except under node_modules */
  onwarn?: (warning: string, path: string) => void;
  /**
   * Source to compile instead of the file's, before preprocessing, as
   * carbon-preprocess-svelte's `optimizeCarbonBun()` provides.
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
  renderer: string | undefined;
  conditions: readonly string[];
};

const SVELTE = /\.svelte(\.[jt]s)?$/;
const SVELTE_CSS = /\.svelte\.css$/;
const BARE = /^[@a-z]/;
// Svelte's runtime, not its compiler. At runtime the hook runs on every
// module Bun loads, so it stays synchronous: a module an async onLoad
// returns is async, so is each importer, and import.meta.require can't
// load the compiler then.
const SVELTE_RUNTIME =
  /[\\/]node_modules[\\/]svelte[\\/]src[\\/](?!compiler[\\/]).+\.js$/;
const LIVE_GLOBAL = /\$\.(document|window)\b/g;
const NODE_MODULES = /[\\/]node_modules[\\/]/;
const RELATIVE = /^\.\.?([\\/]|$)/;
const CONFIG_FILES = [
  "svelte.config.js",
  "svelte.config.mjs",
  "svelte.config.ts",
];

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

// Synchronous, since onResolve is: Bun's require loads ESM too.
function loadConfig(root: string): Config {
  const file = CONFIG_FILES.map((name) => join(root, name)).find((path) =>
    existsSync(path),
  );
  if (!file) return {};
  let module: unknown;
  try {
    module = import.meta.require(file);
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

function loadCompiler(root: string): SvelteCompiler {
  let module: unknown;
  try {
    module = import.meta.require(Bun.resolveSync("svelte/compiler", root));
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

// Svelte refuses a relative customRenderer, which each component would
// resolve from its own directory; here it's relative to root.
function withRenderer(
  compilerOptions: Readonly<Record<string, unknown>> | undefined,
  root: string,
): Pick<Setup, "compilerOptions" | "renderer"> {
  const given = compilerOptions?.experimental;
  const experimental: object =
    typeof given === "object" && given !== null ? given : {};
  const renderer =
    "customRenderer" in experimental &&
    typeof experimental.customRenderer === "string"
      ? experimental.customRenderer
      : undefined;
  if (renderer === undefined || !RELATIVE.test(renderer)) {
    return { compilerOptions, renderer };
  }
  const absolute = resolve(root, renderer);
  return {
    compilerOptions: {
      ...compilerOptions,
      experimental: { ...experimental, customRenderer: absolute },
    },
    renderer: absolute,
  };
}

// Bun's dev server passes `side` and `hmr` to onLoad; Bun.build doesn't.
function devServerSide(args: OnLoadArgs): Side | undefined {
  if (!("side" in args)) return undefined;
  return args.side === "server" ? "server" : "client";
}

function devServerHmr(args: OnLoadArgs): boolean {
  return "hmr" in args ? args.hmr !== false : true;
}

// Svelte's client runtime as `from` resolves it, by real path, so a
// symlink to the same copy is the same; undefined where Svelte doesn't
// resolve at all.
function runtimeFrom(from: string): string | undefined {
  try {
    return realpathSync(Bun.resolveSync("svelte/internal/client", from));
  } catch {
    return undefined;
  }
}

// A person fixes a duplicate by its package folder, not by the file
// inside it, so the message names the folder.
const packageOf = (runtime: string): string =>
  runtime.slice(0, runtime.search(/[\\/]src[\\/]internal[\\/]/)) || runtime;

function printWarning(warning: string, path: string): void {
  if (!NODE_MODULES.test(path)) warn(`svelte: ${warning}`);
}

/** Svelte for `Bun.build`, Bun's dev server, and Bun's runtime. */
export function svelte(options: SvelteBunOptions = {}): BunPlugin {
  const root = options.root ?? workingDirectory();
  const production = options.production ?? productionByEnv();
  const onwarn = options.onwarn ?? printWarning;
  const stylesheets = new Map<string, { css: string; from: string }>();
  const exportsCache: ExportsCache = new Map();
  const barrelCache: BarrelCache = new Map();
  // A component's directory → the Svelte runtime it resolves, so each
  // directory resolves once.
  const runtimes = new Map<string, string | undefined>();
  let rootRuntime: string | undefined | null = null;
  // Two copies of Svelte in one bundle render nothing, with a TypeError
  // that names neither; here the error names both. A resolve hook that
  // dedupes `svelte` instead would make every hot update in Bun's dev
  // server a full reload (docs/compared.md).
  const checkRuntime = (path: string) => {
    if (rootRuntime === null) rootRuntime = runtimeFrom(join(root, "x"));
    const dir = dirname(path);
    if (!runtimes.has(dir)) runtimes.set(dir, runtimeFrom(path));
    const runtime = runtimes.get(dir);
    if (runtime === undefined || rootRuntime === undefined) return;
    if (runtime === rootRuntime) return;
    throw new SvelteBunError(
      "SB_DUPLICATE_SVELTE",
      `svelte-bun: two copies of Svelte: ${path} loads ${packageOf(runtime)}, and ${root} loads ${packageOf(rootRuntime)}; a page with two runtimes renders nothing: install Svelte once`,
    );
  };
  // Read on first use, not when the module loads, because importing
  // `svelte` from svelte-bun creates the default export too.
  let setup: Setup | undefined;
  const ready = (): Setup => {
    if (setup) return setup;
    const config = loadConfig(root);
    const { compilerOptions, renderer } = withRenderer(
      options.compilerOptions ?? config.compilerOptions,
      root,
    );
    const conditions = options.conditions ?? ["svelte"];
    setup = {
      compiler: loadCompiler(root),
      preprocess: options.preprocess ?? config.preprocess,
      compilerOptions,
      renderer,
      conditions: renderer
        ? ["svelte-custom-renderer", ...conditions]
        : conditions,
    };
    return setup;
  };

  const resolveEntry = (specifier: string, importer: string) => {
    const viaCondition = resolveCondition(
      specifier,
      importer,
      ready().conditions,
      exportsCache,
    );
    if (viaCondition !== undefined) return viaCondition;
    try {
      return Bun.resolveSync(specifier, dirname(importer));
    } catch {
      return undefined;
    }
  };

  return {
    name: "svelte-bun",
    setup(build) {
      // compat: Bun runs a build's macros, and leaves
      // process.env.NODE_ENV in its output, as development unless the
      // build defines it. Bun.plugin() at runtime has no config, though
      // the type says it does.
      const config: { define?: Record<string, string> } | undefined =
        build.config;
      const define = config?.define ?? {};
      if (config && production && !("process.env.NODE_ENV" in define)) {
        config.define = {
          ...define,
          "process.env.NODE_ENV": JSON.stringify("production"),
        };
      }

      build.onResolve({ filter: BARE }, (args) => {
        const path = resolveCondition(
          args.path,
          args.importer,
          ready().conditions,
          exportsCache,
        );
        return path === undefined ? undefined : { path };
      });

      build.onLoad({ filter: SVELTE }, async (args) => {
        const { compiler, preprocess, compilerOptions, renderer } = ready();
        checkRuntime(args.path);
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
          if (args.path.endsWith(".svelte")) {
            source = rewriteBarrelImports(
              source,
              args.path,
              resolveEntry,
              barrelCache,
            );
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
        for (const warning of out.warnings) onwarn(warning, args.path);
        let js = out.js;
        // compat: Bun's dev server re-exports Svelte's `$document` and
        // `$window` by value, before `mount` assigns them, so the client
        // reads the globals instead.
        if (side === "client" && fromDevServer !== undefined) {
          js = js.replace(LIVE_GLOBAL, "$1");
        }
        // A custom renderer has no DOM for CSS to style.
        if (side === "client" && out.css !== undefined && !renderer) {
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
        // compat: Bun doesn't fold a constant imported from another
        // module, so Svelte's `if (DEV)` branches would ship.
        const browser = (options.side ?? "client") === "client";
        build.onLoad({ filter: SVELTE_RUNTIME }, (args) => ({
          contents: inlineEsmEnv(readFileSync(args.path, "utf8"), {
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
