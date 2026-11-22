# Options

The options `svelte()` takes set how svelte-bun compiles;
the bunfig entry takes none, and reads `svelte.config.js` instead.

```ts
// build.ts
import { svelte } from "svelte-bun";

await Bun.build({
  entrypoints: ["index.html"],
  outdir: "dist",
  plugins: [svelte({ production: true, css: "injected" })],
});
```

| Option | Sets | Default |
| :--- | :--- | :--- |
| `root` | where `svelte.config.js` and `svelte` resolve from | the working directory |
| `production` | no development checks or HMR, Svelte's dev-only runtime code dropped, and `process.env.NODE_ENV` defined as `"production"` | `NODE_ENV === "production"` |
| `side` | `"client"` or `"server"` output | what the dev server asks for, else `"client"` |
| `preprocess` | Svelte preprocessors | `svelte.config.js`'s |
| `compilerOptions` | passed to Svelte's `compile()` | `svelte.config.js`'s |
| `css` | `"external"`: a stylesheet beside the component; `"injected"`: in the JS | `"external"` |
| `conditions` | export conditions packages resolve through, the first match winning | `["svelte"]` |
| `onwarn` | what to do with each Svelte warning, `file:line:column message` | print it, except under `node_modules` |
| `load` | the source to compile in place of a file's own | none |

## `svelte.config.js`

svelte-bun reads the first of `svelte.config.js`,
`.mjs` and `.ts` in `root`, and takes its `preprocess`
and `compilerOptions`.
An option passed to `svelte()` wins over the file.
A config that fails to load fails the build with `SB_CONFIG_UNREADABLE`,
and a `compilerOptions` that isn't an object with `SB_CONFIG_INVALID`.

## `conditions`

Bun's dev server ignores a plugin's export conditions,
and Bun's runtime takes them only from `--conditions`,
so svelte-bun resolves these itself:
a component library that ships its components under `svelte`,
as Carbon and svelte-highlight do, resolves to them, in a build,
the dev server, and `bun run`.

## `css`

With `"external"`, a component's CSS becomes a stylesheet next to it,
`App.svelte.css`, which Bun bundles like any CSS file:
a relative `@import` in the component's `<style>` resolves from the
component's directory.
`"injected"` puts the CSS in the component's JavaScript instead.

## Library barrels

A component library's `index.js` often only re-exports its components.
Bun drops the components an app doesn't use, but keeps their CSS,
so svelte-bun rewrites a component's named import from such a barrel,
`import { Highlight } from "svelte-highlight"`,
to the file it re-exports.
A barrel that does anything else is left alone.

## `load`

`load(path)` returns the source to compile for a `.svelte` file,
or `undefined` to read the file.
It runs before preprocessing, for a source rewriter such as
carbon-preprocess-svelte's:

```ts
// build.ts
import { optimizeCarbonBun } from "carbon-preprocess-svelte";
import { svelte } from "svelte-bun";

const carbon = optimizeCarbonBun();
const result = await Bun.build({
  entrypoints: ["index.html"],
  outdir: "dist",
  metafile: true,
  plugins: [
    carbon,
    svelte({ production: true, load: (path) => carbon.load(path) }),
  ],
});
await carbon.pruneBuild(result);
```

## At runtime

`svelte-bun/register` compiles the `.svelte` files that `bun run`
and `bun test` import, with the options in `svelte.config.js`:

```toml
# bunfig.toml
preload = ["svelte-bun/register"]
```

It registers the same plugin with `Bun.plugin()`,
so `conditions` apply there too, with no `--conditions` flag.

## Custom renderers

A custom renderer renders Svelte components to something other than the
DOM, such as a terminal.
Name its module in `svelte.config.js`:

```js
// svelte.config.js
export default {
  compilerOptions: {
    experimental: { customRenderer: "./src/terminal-renderer.js" },
  },
};
```

A relative path is relative to `root`; Svelte itself refuses one,
since each component would resolve it from its own directory.
With a renderer set, svelte-bun puts `svelte-custom-renderer` first in
`conditions`, so `svelte` resolves to the runtime that output needs,
and emits no CSS, since there's no DOM to style.
Every `.svelte` file compiles with the renderer, library components too:
a component and the snippets it renders must share one.

## Errors

Every error svelte-bun throws is a `SvelteBunError`,
with a `code` from `SvelteBunErrorCode` and a `kind`:
`setup` for something the app is missing,
`compile` for a file Svelte rejected.
`SB_SVELTE_MISSING` means `svelte` doesn't resolve from `root`.

## Not supported

- Svelte 4 and earlier: svelte-bun compiles with Svelte 5's API.
- Node: the plugin uses Bun's plugin API and transpiler.
- A build pipeline: prerendering, hydration,
  and inlining CSS are the app's, or an SSG's.

## Related

- [Compile API](compile.md): the same compile, without the plugin
- [Compared](compared.md): what the dev server breaks, and how
