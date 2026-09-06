import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { syncHubbleSkills } from "../scripts/hubble-skill-sync.ts";

const exec = promisify(execFile);

/** Creates an offline Git upstream and an isolated installation destination. */
async function fixture() {
  const base = await fs.mkdtemp(join(tmpdir(), "hubble-sync-test-"));
  const upstreamRepository = join(base, "upstream");
  const repositoryRoot = join(base, "target");
  await fs.mkdir(join(upstreamRepository, "skills", "create-html-app"), { recursive: true });
  await fs.mkdir(repositoryRoot);
  await fs.writeFile(join(upstreamRepository, "skills", "create-html-app", "SKILL.md"), "upstream skill");

  for (const args of [
    ["init", "-b", "main"],
    ["add", "."],
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"],
  ]) {
    await exec("git", args, { cwd: upstreamRepository });
  }

  return {
    repositoryRoot,
    upstreamRepository,
    async [Symbol.asyncDispose]() {
      await fs.rm(base, { recursive: true, force: true });
    },
  };
}

test("syncs and checks a real local upstream without network access", async () => {
  await using f = await fixture();
  expect((await syncHubbleSkills([], f)).status).toBe("ok");
  const installed = join(f.repositoryRoot, "skills", "create-html-app", "SKILL.md");
  expect(await fs.readFile(installed, "utf8")).toBe("upstream skill");
  expect((await syncHubbleSkills(["--check"], f)).status).toBe("ok");
  await fs.writeFile(installed, "local edit");
  expect(await syncHubbleSkills(["--check"], f)).toMatchObject({
    status: "error",
    error: { _tag: "SkillSyncError", reason: "different" },
  });
  expect(await fs.readFile(installed, "utf8")).toBe("local edit");
});

test("returns structured argument, Git, and filesystem failures with causes", async () => {
  await using f = await fixture();

  for (const args of [["--unknown"], ["--ref"], ["--ref", "--check"]]) {
    expect(await syncHubbleSkills(args, f)).toMatchObject({
      status: "error",
      error: { _tag: "SkillSyncError", reason: "arguments" },
    });
  }

  expect(await syncHubbleSkills(["--ref", "missing"], f)).toMatchObject({
    status: "error",
    error: { _tag: "SkillSyncError", reason: "git", cause: expect.any(Error) },
  });
  const cause = new Error("temporary storage unavailable");
  expect(
    await syncHubbleSkills([], {
      ...f,
      fileSystem: {
        ...fs,
        async mkdtemp() {
          throw cause;
        },
      },
    })
  ).toMatchObject({ status: "error", error: { _tag: "SkillSyncError", reason: "filesystem", cause } });
});

test("renders argument failures at the CLI boundary with a nonzero exit status", async () => {
  await expect(exec(process.execPath, ["scripts/sync-hubble-skills.ts", "--invalid"])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Unknown argument: --invalid"),
  });
});

test("rejects upstream symlinks before touching the installed copy", async () => {
  await using f = await fixture();
  await fs.symlink("SKILL.md", join(f.upstreamRepository, "skills", "create-html-app", "alias"));
  await exec("git", ["add", "."], { cwd: f.upstreamRepository });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "symlink"], {
    cwd: f.upstreamRepository,
  });
  expect(await syncHubbleSkills([], f)).toMatchObject({
    status: "error",
    error: { _tag: "SkillSyncError", reason: "upstream-entry" },
  });
  expect(await fs.readdir(f.repositoryRoot)).toEqual([]);
});

test("preserves both Git and temporary cleanup failures", async () => {
  await using f = await fixture();
  const cleanupCause = new Error("cleanup failed");
  const temporary = await fs.mkdtemp(join(tmpdir(), "hubble-sync-cleanup-"));
  try {
    const result = await syncHubbleSkills(["--ref", "missing"], {
      ...f,
      fileSystem: {
        ...fs,
        async mkdtemp() {
          return temporary;
        },
        async rm() {
          throw cleanupCause;
        },
      },
    });
    expect(result.status).toBe("error");

    if (result.status !== "error" || !(result.error.cause instanceof AggregateError)) {
      throw new Error("Expected aggregate cleanup failure");
    }

    expect(result.error.cause.errors).toMatchObject([
      { _tag: "SkillSyncError", reason: "git" },
      { _tag: "SkillSyncError", cause: cleanupCause },
    ]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
test.each(["copy", "install", "rollback"] as const)("preserves the previous skills when %s fails", async (failure) => {
  await using f = await fixture();
  const target = join(f.repositoryRoot, "skills");
  await fs.mkdir(target);
  await fs.writeFile(join(target, "previous.md"), "previous bytes");
  const cause = new Error("injected installation failure");
  const rollbackCause = new Error("injected rollback failure");
  const result = await syncHubbleSkills([], {
    ...f,
    fileSystem: {
      ...fs,
      async cp(from, to, options) {
        if (failure === "copy" && String(to).endsWith("incoming")) {
          await fs.mkdir(to, { recursive: true });
          await fs.writeFile(join(String(to), "partial"), "incomplete");
          throw cause;
        }

        await fs.cp(from, to, options);
      },
      async rename(from, to) {
        if (String(from).endsWith("incoming")) {
          throw cause;
        }

        if (failure === "rollback" && String(from).endsWith("previous")) {
          throw rollbackCause;
        }

        await fs.rename(from, to);
      },
    },
  });
  expect(result.status).toBe("error");

  if (result.status !== "error") {
    throw new Error("Expected install failure");
  }

  if (failure === "rollback") {
    expect(result.error.reason).toBe("rollback");
    const backup = result.error.path;

    if (!backup) {
      throw new Error("Expected retained backup path");
    }

    expect(await fs.readFile(join(backup, "previous.md"), "utf8")).toBe("previous bytes");
    expect(result.error.cause).toBeInstanceOf(AggregateError);

    if (result.error.cause instanceof AggregateError) {
      expect(result.error.cause.errors).toMatchObject([{ cause }, { cause: rollbackCause }]);
    }
  } else {
    expect(result.error).toMatchObject({ reason: "filesystem", cause });
    expect(await fs.readFile(join(target, "previous.md"), "utf8")).toBe("previous bytes");
    expect(await fs.readdir(f.repositoryRoot)).toEqual(["skills"]);
  }
});

test("replaces existing skills completely and removes the backup after success", async () => {
  await using f = await fixture();
  const target = join(f.repositoryRoot, "skills");
  await fs.mkdir(target);
  await fs.writeFile(join(target, "obsolete.md"), "old");
  expect((await syncHubbleSkills([], f)).status).toBe("ok");
  expect(await fs.readdir(target)).toEqual(["create-html-app", "upstream.json"]);
  expect(await fs.readdir(f.repositoryRoot)).toEqual(["skills"]);
});

test("keeps the recovery path visible when rollback and temporary cleanup both fail", async () => {
  await using f = await fixture();
  await fs.mkdir(join(f.repositoryRoot, "skills"));
  await fs.writeFile(join(f.repositoryRoot, "skills", "previous.md"), "recover me");
  const failedCleanup: string[] = [];
  try {
    const result = await syncHubbleSkills([], {
      ...f,
      fileSystem: {
        ...fs,
        async rename(from, to) {
          if (String(from).endsWith("incoming") || String(from).endsWith("previous")) {
            throw new Error("rename failed");
          }

          await fs.rename(from, to);
        },
        async rm(path, options) {
          if (String(path).includes("pi-hubble-skills-")) {
            failedCleanup.push(String(path));
            throw new Error("cleanup failed");
          }

          await fs.rm(path, options);
        },
      },
    });
    expect(result.status).toBe("error");
    const recoveryDirectory = (await fs.readdir(f.repositoryRoot)).find((name) => name.startsWith(".hubble-skills-"));

    if (!recoveryDirectory || result.status !== "error") {
      throw new Error("Expected recovery directory");
    }

    const backup = join(f.repositoryRoot, recoveryDirectory, "previous");
    expect(result.error.message).toContain(backup);
    expect(await fs.readFile(join(backup, "previous.md"), "utf8")).toBe("recover me");
  } finally {
    for (const path of failedCleanup) {
      await fs.rm(path, { recursive: true, force: true });
    }
  }
});
