import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillDirectory } from "../src/node";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Node skill package helper", () => {
  test("reads a complete directory using portable relative paths", async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, "references"));
    await writeFile(join(directory, "SKILL.md"), "---\nname: node-test\ndescription: Node package fixture.\n---\n\nWork.\n");
    await writeFile(join(directory, "references", "GUIDE.md"), "# Guide\n");
    const result = await readSkillDirectory(directory);
    expect(result.files.map((file) => file.path)).toEqual(["SKILL.md", "references/GUIDE.md"]);
    expect(Buffer.from(result.files[0]!.contentBase64, "base64").toString()).toContain("name: node-test");
  });

  test("rejects symbolic links instead of following them", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "SKILL.md"), "content");
    await symlink(join(directory, "SKILL.md"), join(directory, "linked.md"));
    await expect(readSkillDirectory(directory)).rejects.toThrow("symbolic links");
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "use-agent-skill-"));
  directories.push(directory);
  return directory;
}
