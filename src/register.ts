// bunfig.toml: preload = ["svelte-bun/register"]

import { svelte } from "./index.ts";

await Bun.plugin(svelte());
