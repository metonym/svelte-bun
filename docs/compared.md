# Compared with bun-plugin-svelte

`bun-plugin-svelte` is oven-sh's Svelte plugin for Bun;
this page lists where svelte-bun differs, each case reproduced.

| | `bun-plugin-svelte` 0.0.6 | `svelte-bun` |
| :--- | :--- | :--- |
| components, `<script lang="ts">` | ✓ | ✓ |
| `.svelte.ts` and `.svelte.js` rune modules | ✓ | ✓ |
| server output | ✓ | ✓ |
| HMR in Bun's dev server | ✓ | ✓ |
| `<svelte:head>` in the dev server | crashes | ✓ |
| a library's `svelte` export condition | doesn't resolve | ✓ |
| a relative `@import` in a nested component's `<style>` | doesn't resolve | ✓ |
| preprocessors, `svelte.config.js` | ✗ | ✓ |
| custom renderers (`experimental.customRenderer`) | ✗ | ✓ |
| export conditions in `bun run` without `--conditions` | ✗ | ✓ |
| a one-line preload for `bun run` and `bun test` | ✗ | `svelte-bun/register` |
| Svelte's warnings | ✗ dropped | reported, `file:line:column` |
| `compilerOptions` | 4 of them | all |
| Svelte's dev-only runtime code dropped in production | ✗ | ✓ |
| a hook to rewrite source before compiling | ✗ | `load` |
| a compile API for another host | ✗ | `svelte-bun/compile` |

## The dev server

Each case ran in Bun 1.4.6's dev server, `bun index.html`,
with the plugin in bunfig, on a fixture app opened in WebKit.

- **`<svelte:head>`**: Bun's dev server re-exports Svelte's `document`
  binding before `mount` assigns it, so a component that sets the title
  throws
  `undefined is not an object (evaluating '$.document.title = …')`.
  Fixed in Bun by oven-sh/bun#49464.
- **The `svelte` condition**: the dev server ignores a plugin's
  `conditions`, so a library that ships its components under `svelte`,
  as Carbon and svelte-highlight do, fails with
  `Could not resolve: "fake-lib"`.
  svelte-bun resolves that condition itself.
- **A relative `@import`**: `bun-plugin-svelte` bundles a component's
  CSS from a virtual path, so `@import "./card.css"` in
  `components/Card.svelte` fails with `Could not resolve: "./card.css"`,
  in `Bun.build` too.
  svelte-bun writes the CSS as `Card.svelte.css` beside the component.

## From the source

`bun-plugin-svelte` forwards 4 of Svelte's `compilerOptions`:
`customElement`, `runes`, `modernAst` and `namespace`.
So `experimental.customRenderer` never reaches the compiler,
and it never reads a compile's `warnings`.

## Size

A component with `$state` and `<svelte:head><title>`,
mounted from `index.html`, built with `minify: true`
and each plugin in production mode
(`development: false`, `production: true`), Svelte 5.59.1:

| Plugin | JavaScript | gzip |
| :--- | ---: | ---: |
| `bun-plugin-svelte` 0.0.6 | 56.7 kB | 21.2 kB |
| `svelte-bun` | 49.2 kB | 18.7 kB |

Before oven-sh/bun#49460, Bun didn't fold constants imported from
another module, so Svelte's runtime kept every `if (DEV)` branch
unless the plugin inlined `esm-env`'s values.

## Related

- [Options](options.md): what svelte-bun reads, and from where
