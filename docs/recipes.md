# Recipes

Recipes are complete setups for jobs svelte-bun leaves to the app:
prerendering, starting the client, build-time data, and types.

## Prerender a page

Build the app, build the component for the server, render it,
and put its `head` and `body` into the built page:

```ts
// build.ts
import { svelte } from "svelte-bun";

await Bun.build({
  entrypoints: ["index.html"],
  outdir: "dist",
  minify: true,
  plugins: [svelte({ production: true })],
});

const server = await Bun.build({
  entrypoints: ["src/App.svelte"],
  outdir: "dist/.server",
  target: "bun",
  plugins: [svelte({ production: true, side: "server" })],
});
const { render } = await import("svelte/server");
const { default: App } = await import(server.outputs[0].path);
const { head, body } = render(App);

const page = Bun.file("dist/index.html");
const html = (await page.text())
  .replace("</head>", `${head}</head>`)
  .replace('<div id="app"></div>', `<div id="app">${body}</div>`);
await Bun.write(page, html);
```

`index.html` holds an empty `<div id="app"></div>` for the markup.

## Start the client

Hydrate the target when it holds prerendered markup,
and mount when it doesn't:

```ts
// src/main.ts
import { hydrate, mount } from "svelte";

import App from "./App.svelte";

const target = document.querySelector("#app") ?? document.body;
(target.firstChild ? hydrate : mount)(App, { target });
```

## Build-time data with a macro

A Bun macro runs while the app builds,
and its return value is inlined into the output:

```ts
// src/data.ts
import { loadExamples } from "./examples.js" with { type: "macro" };

export const examples = loadExamples();
```

With `production: true`, svelte-bun defines `process.env.NODE_ENV` as
`"production"` for the build, so a macro sees it too; without a define,
Bun runs macros with `development`.
Write the macro in JavaScript, with a `.d.ts` beside it:
a TypeScript macro brings its imports into the client's typecheck.

## Import CSS from TypeScript

Svelte's types declare `*.svelte` modules,
and Bun's don't declare `*.css`, so an app that imports a stylesheet
declares it once:

```ts
// src/env.d.ts
declare module "*.css";
```

## Not supported

- Source maps: Bun drops a plugin's source map,
  so an error in a component points at its compiled line.

## Related

- [Options](options.md): what `production` and the other options do
