import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";

import type { BunPlugin, OnLoadArgs } from "bun";

import { type BarrelCache, rewriteBarrelImports } from "./barrel.ts";
import {
  type CompileCache,
  createCompileCache,
  preprocessSalt,
} from "./cache.ts";
import { compileFile, type Side, type SvelteCompiler } from "./component.ts";
import { productionByEnv, warn, workingDirectory } from "./env.ts";
import { SvelteBunError } from "./errors.ts";
import { inlineEsmEnv } from "./esm-env.ts";
import { type ExportsCache, resolveCondition } from "./resolve.ts";

/**
 * The options a plugin compiles with, its own merged over
 * `svelte.config.*`, as `plugin.api.options` gives them to other tools.
 */
export type ResolvedSvelteOptions = {
  readonly root: string;
  readonly extensions: readonly string[];
  readonly preprocess: unknown;
  readonly compilerOptions: Readonly<Record<string, unknown>> | undefined;
  readonly css: "external" | "injected";
  readonly conditions: readonly string[];
  readonly cache: boolean | string;
  readonly cacheKey:
    ((path: string, source: string) => string | undefined) | undefined;
};

/**
 * svelte-bun's plugin, whose `api.options` tells other tools, such as a
 * type checker or an editor's config, what it compiles with.
 */
export type SveltePlugin = BunPlugin & {
  readonly api: { readonly options: ResolvedSvelteOptions };
};

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
  /**
   * The file extensions compiled as components, such as `".md"` for
   * pages a preprocessor turns into components.
   * @default svelte.config.js's, else [".svelte"]
   */
  extensions?: readonly string[];
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
  /**
   * Keep each component's preprocessed and compiled output on disk, so a
   * warm `Bun.build` skips both; `true` for
   * `node_modules/.cache/svelte-bun` under `root`, or a directory. The
   * dev server keeps its own cache in memory.
   * @default false
   */
  cache?: boolean | string;
  /**
   * Inputs from outside the file that change its preprocessed output,
   * such as the source of files a preprocessor inlines, as one string.
   */
  cacheKey?: (path: string, source: string) => string | undefined;
};

type Config = {
  preprocess?: unknown;
  extensions?: readonly string[];
  compilerOptions?: Readonly<Record<string, unknown>>;
};

type Setup = {
  compiler: SvelteCompiler & { VERSION?: string };
  preprocess: unknown;
  compilerOptions: Readonly<Record<string, unknown>> | undefined;
  renderer: string | undefined;
  conditions: readonly string[];
};

const RUNE_MODULE = /\.svelte\.[jt]s$/;
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  if ("extensions" in config) {
    const extensions = config.extensions;
    if (
      !Array.isArray(extensions) ||
      !extensions.every((e) => typeof e === "string" && e.startsWith("."))
    ) {
      throw new SvelteBunError(
        "SB_CONFIG_INVALID",
        `svelte-bun config: ${basename(file)}: extensions is ${JSON.stringify(extensions)}: make it a list such as [".svelte", ".md"]`,
      );
    }
    parsed.extensions = extensions.map(String);
  }
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
    // Node has no import.meta.require; its require loads an ES module
    // config from 22.12.
    module =
      typeof import.meta.require === "function"
        ? import.meta.require(file)
        : createRequire(import.meta.url)(file);
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

// Bun names the side for a build's target as well as the dev server's,
// so a server build compiles server output without being told.
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

// JSON drops a function, so a custom cssHash's source stands in for it:
// a changed cssHash must miss the cache.
function compilerKey(
  options: Readonly<Record<string, unknown>> | undefined,
): string {
  return JSON.stringify(options ?? {}, (_, value: unknown) =>
    typeof value === "function" ? String(value) : value,
  );
}

function printWarning(warning: string, path: string): void {
  if (!NODE_MODULES.test(path)) warn(`svelte: ${warning}`);
}

/** Svelte for `Bun.build`, Bun's dev server, and Bun's runtime. */
export function svelte(options: SvelteBunOptions = {}): SveltePlugin {
  const root = options.root ?? workingDirectory();
  const production = options.production ?? productionByEnv();
  const onwarn = options.onwarn ?? printWarning;
  const stylesheets = new Map<string, { css: string; from: string }>();
  const exportsCache: ExportsCache = new Map();
  const barrelCache: BarrelCache = new Map();
  let diskCache: { cache: CompileCache; salt: string } | null | undefined;
  const cacheOf = () => {
    if (diskCache !== undefined) return diskCache;
    const dir =
      typeof options.cache === "string"
        ? resolve(root, options.cache)
        : options.cache
          ? join(root, "node_modules/.cache/svelte-bun")
          : undefined;
    diskCache = dir
      ? { cache: createCompileCache(dir), salt: preprocessSalt(root) }
      : null;
    return diskCache;
  };
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
  let config: Config | undefined;
  const configOf = (): Config => (config ??= loadConfig(root));
  const ready = (): Setup => {
    if (setup) return setup;
    const config = configOf();
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

  // As vite-plugin-svelte gives its options, read when asked, so creating
  // the plugin loads no config.
  const api = {
    get options(): ResolvedSvelteOptions {
      const config = configOf();
      return Object.freeze({
        root,
        extensions: options.extensions ?? config.extensions ?? [".svelte"],
        preprocess: options.preprocess ?? config.preprocess,
        compilerOptions: options.compilerOptions ?? config.compilerOptions,
        css: options.css ?? "external",
        conditions: options.conditions ?? ["svelte"],
        cache: options.cache ?? false,
        cacheKey: options.cacheKey,
      });
    },
  };

  return {
    name: "svelte-bun",
    api,
    setup(build) {
      // The extensions decide the hooks' filters, so they're read here,
      // when the plugin is used, not on import.
      const extensions = options.extensions ??
        configOf().extensions ?? [".svelte"];
      const ends = extensions.map(escapeRegExp).join("|");
      const component = new RegExp(`(${ends})$`);
      const COMPONENT_OR_RUNES = new RegExp(`(${ends})$|${RUNE_MODULE.source}`);
      const COMPONENT_CSS = new RegExp(`(${ends})\\.css$`);
      // compat: Bun runs a build's macros, and leaves
      // process.env.NODE_ENV in its output, as development unless the
      // build defines it. Bun.plugin() at runtime has no config, though
      // the type says it does.
      const config: { define?: Record<string, string> } | undefined =
        build.config;
      const define = config?.define ?? {};
      // compat: Bun passes each onLoad a side in Bun.build too, by target,
      // so only the config tells the dev server, which names no
      // entrypoints, from a build; at runtime there's no config.
      const inDevServer = config !== undefined && !("entrypoints" in config);
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

      build.onLoad({ filter: COMPONENT_OR_RUNES }, async (args) => {
        const { compiler, preprocess, compilerOptions, renderer } = ready();
        checkRuntime(args.path);
        const side = options.side ?? devServerSide(args) ?? "client";
        const loaded = options.load?.(args.path);
        const replaced = typeof loaded === "string" ? loaded : loaded?.code;
        let source = replaced ?? (await Bun.file(args.path).text());
        // Not in the dev server, which keeps compiled modules in memory
        // already, and whose HMR output a cache would have to key too.
        const disk = inDevServer ? null : cacheOf();
        let out;
        try {
          if (preprocess !== undefined && component.test(args.path)) {
            const filename = args.path;
            const key = [
              args.path,
              source,
              disk?.salt,
              options.cacheKey?.(args.path, source),
            ];
            const hit = disk?.cache.preprocessed(key);
            if (hit !== undefined) source = hit;
            else {
              source = (
                await compiler.preprocess(source, preprocess, { filename })
              ).code;
              disk?.cache.savePreprocessed(key, source);
            }
          }
          if (component.test(args.path)) {
            source = rewriteBarrelImports(
              source,
              args.path,
              resolveEntry,
              barrelCache,
            );
          }
          const hmr = !production && inDevServer && devServerHmr(args);
          const key = [
            args.path,
            source,
            compiler.VERSION,
            side,
            !production,
            hmr,
            options.css,
            compilerKey(compilerOptions),
          ];
          const hit = disk?.cache.compiled(key);
          if (hit) out = hit;
          else {
            out = compileFile(compiler, source, {
              filename: args.path,
              side,
              dev: !production,
              // Only the dev server provides `import.meta.hot`.
              hmr,
              ...(options.css ? { css: options.css } : {}),
              ...(compilerOptions ? { compilerOptions } : {}),
            });
            disk?.cache.saveCompiled(key, out);
          }
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
        if (side === "client" && inDevServer) {
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

      build.onResolve({ filter: COMPONENT_CSS }, (args) => ({
        path: join(dirname(args.importer), args.path),
      }));
      build.onLoad({ filter: COMPONENT_CSS }, (args) => {
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

const plugin: SveltePlugin = svelte();

// eslint-disable-next-line import/no-default-export -- bunfig's [serve.static] plugins loads a module's default export, and passes no options
export { plugin as default };
