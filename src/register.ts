// svelte-bun/register: compiles the `.svelte` files Bun's runtime
// imports, in `bun run` and `bun test`, with options from
// svelte.config.js. An app lists it in bunfig.toml:
//
//   preload = ["svelte-bun/register"]

import { svelte } from "./index.ts";

await Bun.plugin(svelte());
