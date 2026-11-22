// The one module that reads the environment and writes to the terminal,
// so what a build depends on from outside is in one place.

/** Whether `NODE_ENV` is `production`. */
export function productionByEnv(): boolean {
  // eslint-disable-next-line no-restricted-properties -- the one env reader
  return process.env.NODE_ENV === "production";
}

/** Prints a warning for the person running the build. */
export function warn(message: string): void {
  // eslint-disable-next-line no-console -- a build's warnings are for the person running it
  console.warn(message);
}

/** The directory the process runs in, where an app's root defaults to. */
export function workingDirectory(): string {
  return process.cwd();
}
