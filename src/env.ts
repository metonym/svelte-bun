export function productionByEnv(): boolean {
  // eslint-disable-next-line no-restricted-properties -- the one env reader
  return process.env.NODE_ENV === "production";
}

export function warn(message: string): void {
  // eslint-disable-next-line no-console -- a build's warnings are for the person running it
  console.warn(message);
}

export function workingDirectory(): string {
  return process.cwd();
}
