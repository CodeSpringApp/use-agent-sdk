import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { ManagedSkillPackageInput } from "./types";

export interface ReadSkillDirectoryOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxPackageBytes?: number;
}

/** Reads a local Agent Skills directory without following symbolic links. */
export async function readSkillDirectory(
  directory: string,
  options: ReadSkillDirectoryOptions = {},
): Promise<ManagedSkillPackageInput> {
  const root = resolve(directory);
  const maxFiles = options.maxFiles ?? 128;
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  const maxPackageBytes = options.maxPackageBytes ?? 5 * 1024 * 1024;
  const paths: string[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill package cannot contain symbolic links: ${relative(root, path)}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        paths.push(path);
        if (paths.length > maxFiles) throw new Error(`Skill package exceeds ${maxFiles} files`);
      } else throw new Error(`Skill package contains an unsupported filesystem entry: ${relative(root, path)}`);
    }
  }

  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error("Skill package path must be a directory");
  await visit(root);
  paths.sort((left, right) => {
    const leftPath = relative(root, left).split(sep).join("/");
    const rightPath = relative(root, right).split(sep).join("/");
    if (leftPath === "SKILL.md") return -1;
    if (rightPath === "SKILL.md") return 1;
    return leftPath.localeCompare(rightPath, "en");
  });
  let totalBytes = 0;
  const files = [];
  for (const path of paths) {
    const bytes = await readFile(path);
    if (bytes.byteLength > maxFileBytes) throw new Error(`${relative(root, path)} exceeds the per-file size limit`);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxPackageBytes) throw new Error("Skill package exceeds the total size limit");
    const packagePath = relative(root, path).split(sep).join("/");
    files.push({
      path: packagePath,
      contentBase64: bytes.toString("base64"),
      mediaType: nodeSkillMediaType(packagePath),
    });
  }
  if (!files.some((file) => file.path === "SKILL.md")) throw new Error("Skill package must contain SKILL.md at its root");
  return { files };
}

function nodeSkillMediaType(path: string) {
  switch (extname(path).toLowerCase()) {
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".yaml": case ".yml": return "application/yaml";
    case ".txt": case ".sh": case ".py": case ".js": case ".ts": return "text/plain";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}
