import * as os from "node:os";
import { isAbsolute, resolve } from "node:path";

function expandPath(filePath: string): string {
  // Pi uses a leading @ as a home/path-expansion marker, not a literal filename character.
  const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (normalized === "~") return os.homedir();
  if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
  return normalized;
}

export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
