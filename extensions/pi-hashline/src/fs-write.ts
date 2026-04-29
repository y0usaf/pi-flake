import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readlink, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

export async function resolveMutationTargetPath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  const { root } = parse(absolutePath);
  const parts = absolutePath.slice(root.length).split(sep).filter((part) => part.length > 0);
  const visitedSymlinks = new Set<string>();

  async function resolveFromParts(currentPath: string, remainingParts: string[]): Promise<string> {
    if (remainingParts.length === 0) return currentPath;

    const [nextPart, ...tail] = remainingParts;
    const candidatePath = join(currentPath, nextPart!);

    try {
      const candidateStats = await lstat(candidatePath);
      if (!candidateStats.isSymbolicLink()) {
        return resolveFromParts(candidatePath, tail);
      }

      if (visitedSymlinks.has(candidatePath)) {
        const error = new Error(`Too many symbolic links while resolving ${path}`) as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      }
      visitedSymlinks.add(candidatePath);

      const linkTargetPath = resolve(dirname(candidatePath), await readlink(candidatePath));
      const targetRoot = parse(linkTargetPath).root;
      const targetParts = linkTargetPath
        .slice(targetRoot.length)
        .split(sep)
        .filter((part) => part.length > 0);
      return resolveFromParts(targetRoot, [...targetParts, ...tail]);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return join(candidatePath, ...tail);
      }
      throw error;
    }
  }

  return resolveFromParts(root, parts);
}

export async function writeTextFileAtomically(path: string, content: string): Promise<void> {
  const targetPath = await resolveMutationTargetPath(path);
  const currentStat = await stat(targetPath);

  if (currentStat.nlink > 1) {
    await writeFile(targetPath, content, "utf-8");
    return;
  }

  const dir = dirname(targetPath);
  const tempPath = join(dir, `.pi-hashline-${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(tempPath, content, "utf-8");
  await chmod(tempPath, currentStat.mode & 0o7777);
  await rename(tempPath, targetPath);
}
