import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";

class Sink {
  value = "";
  write(chunk: string): void {
    this.value += chunk;
  }
}

describe("Use Agent CLI", () => {
  test("prints digest-verified packaged skill content offline", async () => {
    const stdout = new Sink();
    const stderr = new Sink();
    const exitCode = await runCli(["skills", "get", "app-builder"], { stdout, stderr, env: {} });

    expect(exitCode).toBe(0);
    expect(stdout.value).toContain("# Build a CodeSpring Agents application");
    expect(stderr.value).toBe("");
  });

  test("does not accept credentials as command arguments", async () => {
    const stdout = new Sink();
    const stderr = new Sink();
    const exitCode = await runCli(["agents", "list", "--api-key", "secret"], {
      stdout,
      stderr,
      env: {},
    });

    expect(exitCode).toBe(3);
    expect(stderr.value).toContain("CODESPRING_AGENTS_API_KEY");
    expect(stderr.value).not.toContain("secret");
  });

  test("installs only the discovery stub at an explicit path", async () => {
    const root = await mkdtemp(join(tmpdir(), "use-agent-cli-"));
    const destination = join(root, "use-agent");
    const stdout = new Sink();
    const stderr = new Sink();
    const exitCode = await runCli(
      ["skills", "install", "--path", destination, "--yes"],
      { stdout, stderr, env: {} },
    );

    expect(exitCode).toBe(0);
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toContain(
      "use-agent skills get app-builder",
    );
    expect(stdout.value).toContain("Installed");
  });
});
