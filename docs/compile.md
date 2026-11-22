# Compile API

`svelte-bun/compile` is svelte-bun without the Bun plugin:
the compile step and the import scanner,
for a host that bundles on its own.

```ts
// integration.ts
import { compileFile, scanImports } from "svelte-bun/compile";
import * as compiler from "svelte/compiler";

const source = await Bun.file("src/App.svelte").text();
const { js, css } = compileFile(compiler, source, {
  filename: "src/App.svelte",
  side: "client",
  dev: true,
  hmr: true,
});
const parts = scanImports(source, "src/App.svelte");
```

## `compileFile`

`compileFile(compiler, source, options)` compiles one file
and returns `{ js, css }`.
A `.svelte` file compiles as a component;
a `.svelte.ts` or `.svelte.js` file compiles as a rune module,
with its TypeScript stripped first.

| Option | Sets |
| :--- | :--- |
| `filename` | the name Svelte's warnings and CSS hashes use |
| `side` | `"client"` or `"server"` |
| `dev` | Svelte's development checks |
| `hmr` | Svelte's HMR code, client side only; the host provides `import.meta.hot` |
| `css` | `"external"` returns the CSS as `css`; `"injected"` keeps it in `js` |
| `compilerOptions` | the rest of Svelte's `compile()` options |

`compiler` is the app's own `svelte/compiler`,
so the app's Svelte version compiles its files.

## `scanImports`

`scanImports(source, path)` returns the code a file's imports are in,
without compiling it: each `<script>` block of a component,
with its loader, plus an import of Svelte's client runtime,
which every compiled component has.
A host that hashes a file's import graph, as an incremental build does,
scans these parts with `Bun.Transpiler`.

## Not supported

- HMR transport: Bun's dev server provides `import.meta.hot`;
  another host provides its own.
- Preprocessing: call `compiler.preprocess()` first, as the plugin does.

## Related

- [Options](options.md): the plugin's options
