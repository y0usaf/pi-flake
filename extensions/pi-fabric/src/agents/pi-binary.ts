import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface PiBinaryResolutionOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  isExecutable?: (file: string) => boolean;
}

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolvePiBinary = (
  configured?: string,
  options: PiBinaryResolutionOptions = {},
): string => {
  if (configured !== undefined) return configured;
  const env = options.env ?? process.env;
  if (env.PI_FABRIC_PI_BINARY !== undefined) return env.PI_FABRIC_PI_BINARY;

  if (env.LOCALTERM === "1") {
    const shim = path.join(options.homeDirectory ?? homedir(), ".localterm", "shims", "pi");
    if ((options.isExecutable ?? executable)(shim)) return shim;
  }

  return "pi";
};
