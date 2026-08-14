#!/usr/bin/env node

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRepository = "https://github.com/bholmesdev/hubble-skills.git";
const selectedSkills = ["create-html-app"];

/** Parses supported command-line options for the upstream sync. */
function parseArguments(args) {
  let check = false;
  let ref = "main";

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--ref") {
      const value = args[index + 1];
      if (!value) throw new Error("--ref requires a git ref");
      ref = value;
      index++;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { check, ref };
}

/** Runs git without invoking a shell and returns trimmed standard output. */
async function runGit(args, cwd = repositoryRoot) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Recursively collects file paths beneath a directory in stable order. */
async function collectFiles(directory, baseDirectory = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path, baseDirectory)));
    } else if (entry.isFile()) {
      files.push(relative(baseDirectory, path));
    } else {
      throw new Error(`Upstream skill contains an unsupported filesystem entry: ${path}`);
    }
  }

  return files;
}

/** Reads a directory into a relative-path-to-content snapshot for exact comparison. */
async function snapshotDirectory(directory) {
  try {
    const files = await collectFiles(directory);
    return new Map(await Promise.all(files.map(async (path) => [path, await readFile(join(directory, path))])));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return new Map();
    throw error;
  }
}

/** Checks whether two directory snapshots contain the same paths and bytes. */
function snapshotsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, content] of left) {
    const rightContent = right.get(path);
    if (!rightContent || !content.equals(rightContent)) return false;
  }
  return true;
}

/** Copies the selected upstream skills and records the exact source commit. */
async function stageSkills(sourceDirectory, stagedDirectory, ref) {
  const skillsDirectory = join(stagedDirectory, "skills");
  await mkdir(skillsDirectory, { recursive: true });

  for (const skill of selectedSkills) {
    const source = join(sourceDirectory, "skills", skill);
    await readFile(join(source, "SKILL.md"));
    await cp(source, join(skillsDirectory, skill), { recursive: true });
  }

  const commit = await runGit(["rev-parse", "HEAD"], sourceDirectory);
  await writeFile(
    join(skillsDirectory, "upstream.json"),
    `${JSON.stringify(
      {
        repository: upstreamRepository,
        ref,
        commit,
        skills: selectedSkills,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return commit;
}

/** Fetches upstream into a temporary checkout, then checks or updates vendored skills. */
async function main() {
  const { check, ref } = parseArguments(process.argv.slice(2));
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-hubble-skills-"));
  const sourceDirectory = join(temporaryDirectory, "upstream");
  const stagedDirectory = join(temporaryDirectory, "staged");
  const targetDirectory = join(repositoryRoot, "skills");

  try {
    await mkdir(sourceDirectory, { recursive: true });
    await runGit(["init", "--quiet"], sourceDirectory);
    await runGit(["remote", "add", "origin", upstreamRepository], sourceDirectory);
    await runGit(["fetch", "--quiet", "--depth", "1", "origin", ref], sourceDirectory);
    await runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], sourceDirectory);
    const commit = await stageSkills(sourceDirectory, stagedDirectory, ref);

    const [current, staged] = await Promise.all([
      snapshotDirectory(targetDirectory),
      snapshotDirectory(join(stagedDirectory, "skills")),
    ]);
    if (snapshotsEqual(current, staged)) {
      console.log(`Hubble skills are current at ${commit}.`);
      return;
    }
    if (check) {
      throw new Error(`Vendored Hubble skills differ from ${upstreamRepository}@${commit}`);
    }

    await rm(targetDirectory, { recursive: true, force: true });
    await cp(join(stagedDirectory, "skills"), targetDirectory, { recursive: true });
    console.log(`Synced Hubble skills from ${upstreamRepository}@${commit}.`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
