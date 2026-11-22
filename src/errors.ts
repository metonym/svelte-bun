/**
 * What a caller does about an error: `setup`, the app is missing
 * something svelte-bun needs; `compile`, Svelte rejected a file; `other`,
 * a failure svelte-bun didn't name.
 */
export type SvelteBunErrorKind = "setup" | "compile" | "other";

/**
 * Which failure it is, stable across releases: a code is never reused for
 * another meaning.
 */
export type SvelteBunErrorCode =
  /** `svelte` isn't installed where the app's root resolves from. */
  | "SB_SVELTE_MISSING"
  /** `svelte.config.js` failed to load: a syntax error, or one it throws. */
  | "SB_CONFIG_UNREADABLE"
  /** `svelte.config.js` loaded, but a key's value is the wrong type. */
  | "SB_CONFIG_INVALID"
  /** A preprocessor or the Svelte compiler threw on a file. */
  | "SB_COMPILE_FAILED"
  /** A failure svelte-bun didn't anticipate: a bug, or the environment. */
  | "SB_INTERNAL";

const KINDS: Record<SvelteBunErrorCode, SvelteBunErrorKind> = {
  SB_SVELTE_MISSING: "setup",
  SB_CONFIG_UNREADABLE: "setup",
  SB_CONFIG_INVALID: "setup",
  SB_COMPILE_FAILED: "compile",
  SB_INTERNAL: "other",
};

/**
 * An error svelte-bun names: its `code` says which failure, its `kind`
 * what to do.
 */
export class SvelteBunError extends Error {
  readonly code: SvelteBunErrorCode;
  readonly kind: SvelteBunErrorKind;
  constructor(
    code: SvelteBunErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SvelteBunError";
    this.code = code;
    this.kind = KINDS[code];
  }
}
