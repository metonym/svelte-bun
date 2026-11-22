const ESM_ENV_IMPORT = /^import \{([^}]+)\} from ['"]esm-env['"];?$/gm;
const ALIAS = /\s+as\s+/;

/**
 * Inlines `esm-env`'s `DEV`, `BROWSER` and `NODE` in a module that imports
 * them. Bun doesn't fold constants imported from another module, so
 * without this every `if (DEV)` branch of Svelte's runtime ships.
 */
export function inlineEsmEnv(
  source: string,
  env: { dev: boolean; browser: boolean },
): string {
  const values = new Map([
    ["DEV", env.dev],
    ["BROWSER", env.browser],
    ["NODE", !env.browser],
  ]);
  return source.replace(ESM_ENV_IMPORT, (statement, names: string) => {
    const bindings = names
      .split(",")
      .map((name) => name.trim().split(ALIAS))
      .map(([name = "", local = name]) => ({ name, local }));
    if (bindings.some(({ name }) => !values.has(name))) return statement;
    const consts = bindings.map(
      ({ name, local }) => `${local} = ${String(values.get(name))}`,
    );
    return `const ${consts.join(", ")};`;
  });
}
