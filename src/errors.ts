/** What to fix: the app's setup, a file, or, for `other`, svelte-bun. */
export type SvelteBunErrorKind = "setup" | "compile" | "other";

/** Which failure it is; a code never changes meaning. */
export type SvelteBunErrorCode =
  /** `svelte` doesn't resolve from `root`. */
  | "SB_SVELTE_MISSING"
  /** `svelte.config.js` threw while loading. */
  | "SB_CONFIG_UNREADABLE"
  /** A `svelte.config.js` value has the wrong type. */
  | "SB_CONFIG_INVALID"
  /** A preprocessor or Svelte's compiler threw on a file. */
  | "SB_COMPILE_FAILED"
  /** A bug in svelte-bun. */
  | "SB_INTERNAL";

const KINDS: Record<SvelteBunErrorCode, SvelteBunErrorKind> = {
  SB_SVELTE_MISSING: "setup",
  SB_CONFIG_UNREADABLE: "setup",
  SB_CONFIG_INVALID: "setup",
  SB_COMPILE_FAILED: "compile",
  SB_INTERNAL: "other",
};

/** An error svelte-bun throws, with a stable `code`. */
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
