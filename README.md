# svelte-bun

Svelte for Bun.build and Bun's dev server.

svelte-bun compiles Svelte 5 components and rune modules for Bun's dev
server and `Bun.build`, from one line of bunfig.
It reads `svelte.config.js`, so your preprocessors
and compiler options work as they do under Vite,
and it handles the cases where Bun's dev server breaks a Svelte app.
When Svelte rejects a file, the build fails with the file
and Svelte's message.

| On Bun 1.4.6, Svelte 5.59.1 | `bun-plugin-svelte` 0.0.6 | `svelte-bun` |
| :--- | :--- | :--- |
| `<svelte:head>` in the dev server | `undefined is not an object (evaluating '$.document.title = …')` | ✓ |
| a library's `svelte` export condition | `Could not resolve: "fake-lib"` | ✓ |
| `@import "./card.css"` in a component in a subdirectory | `Could not resolve: "./card.css"` | ✓ |
| preprocessors and `svelte.config.js` | ✗ | ✓ |
| a minimal app, `minify: true`, production | 21.2 kB gzip | 18.7 kB gzip |

## Quick start

```sh
bun add -d svelte-bun svelte
```

```toml
# bunfig.toml
[serve.static]
plugins = ["svelte-bun"]
```

```sh
bun index.html
```

Bun's dev server serves `index.html`,
compiling each `.svelte` file it reaches, with hot updates.
Options come from `svelte.config.js`, since bunfig can't pass any:

```js
// svelte.config.js
import { optimizeImports } from "carbon-preprocess-svelte";

export default {
  preprocess: [optimizeImports()],
  compilerOptions: { runes: true },
};
```

## From code

A production build, and a server build for prerendering:

```ts
// build.ts
import { svelte } from "svelte-bun";

await Bun.build({
  entrypoints: ["index.html"],
  outdir: "dist",
  minify: true,
  plugins: [svelte({ production: true })],
});

await Bun.build({
  entrypoints: ["src/ssr.ts"],
  outdir: "dist/server",
  target: "bun",
  plugins: [svelte({ production: true, side: "server" })],
});
```

`production` drops Svelte's development checks and the dev-only code in
its runtime; it defaults to `NODE_ENV === "production"`.
A host with its own bundler compiles files through `svelte-bun/compile`
instead.

## Docs

- [Options](https://github.com/metonym/svelte-bun/blob/master/docs/options.md):
  every option, `svelte.config.js`, and the `load` hook
- [Compile API](https://github.com/metonym/svelte-bun/blob/master/docs/compile.md):
  `compileFile()` and `scanImports()`, for another host
- [Compared](https://github.com/metonym/svelte-bun/blob/master/docs/compared.md):
  what differs from `bun-plugin-svelte`, and how it was measured

These docs ship in the package, at `node_modules/svelte-bun/docs/`.
