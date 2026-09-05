import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Result, type Result as ResultType } from "better-result";

import { mapFileSystemError, MissingFileError, SkillSyncError } from "../extensions/hubble-errors.ts";

const execFileAsync = promisify(execFile);
const selectedSkills = ["create-html-app"] as const;

/** Filesystem seam for staging and installing vendored skills, including failure-path tests. */
export interface SkillSyncFileSystem extends Pick<
  typeof fs,
  "mkdir" | "readdir" | "readFile" | "writeFile" | "cp" | "rm" | "rename"
> {
  /** Creates a UTF-8-named temporary directory for staging or installation. */
  mkdtemp(prefix: string): Promise<string>;
}

/** Trusted repository locations and optional filesystem adapter for a sync run. */
export interface SkillSyncOptions {
  readonly repositoryRoot: string;
  readonly upstreamRepository: string;
  readonly fileSystem?: SkillSyncFileSystem;
}

interface SyncArguments {
  readonly check: boolean;
  readonly ref: string;
}

/** Parses CLI options without performing I/O; rejects missing values and option-like refs. */
function parseArguments(args: ReadonlyArray<string>): ResultType<SyncArguments, SkillSyncError> {
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
      if (!value || value.startsWith("-"))
        return Result.err(new SkillSyncError({ reason: "arguments", message: "--ref requires a git ref" }));
      ref = value;
      index++;
      continue;
    }
    return Result.err(new SkillSyncError({ reason: "arguments", message: `Unknown argument: ${argument}` }));
  }
  return Result.ok({ check, ref });
}

/** Maps one filesystem step to a structured failure with its original cause. */
function fileOperation<T>(path: string, action: () => Promise<T>): Promise<ResultType<T, SkillSyncError>> {
  return Result.tryPromise({
    try: action,
    catch: (cause) =>
      new SkillSyncError({
        reason: "filesystem",
        path,
        cause: mapFileSystemError(path, cause),
        message: `Skill sync filesystem operation failed: ${path}`,
      }),
  });
}

/** Runs Git without a shell, returning expected process failures as values. */
async function runGit(args: string[], cwd: string): Promise<ResultType<string, SkillSyncError>> {
  const result = await Result.tryPromise({
    try: () => execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }),
    catch: (cause) =>
      new SkillSyncError({ reason: "git", path: cwd, cause, message: `Skill sync git ${args[0]} failed.` }),
  });
  return Result.isError(result) ? result : Result.ok(result.value.stdout.trim());
}

/** Reads exact relative paths and bytes; a missing root is empty, but missing children remain failures. */
async function snapshotDirectory(
  directory: string,
  fileSystem: SkillSyncFileSystem
): Promise<ResultType<Map<string, Buffer>, SkillSyncError>> {
  const snapshot = new Map<string, Buffer>();
  /** Recurses through real directories and rejects symlinks before copying upstream content. */
  async function visit(path: string, prefix: string): Promise<ResultType<void, SkillSyncError>> {
    const entries = await fileOperation(path, () => fileSystem.readdir(path, { withFileTypes: true }));
    if (Result.isError(entries))
      return prefix === "" && MissingFileError.is(entries.error.cause) ? Result.ok() : entries;
    for (const entry of entries.value.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) {
        const nested = await visit(absolute, relative);
        if (Result.isError(nested)) return nested;
      } else if (entry.isFile()) {
        const content = await fileOperation(absolute, () => fileSystem.readFile(absolute));
        if (Result.isError(content)) return content;
        snapshot.set(relative, content.value);
      } else
        return Result.err(
          new SkillSyncError({
            reason: "upstream-entry",
            path: absolute,
            message: `Skill sync contains an unsupported filesystem entry: ${absolute}`,
          })
        );
    }
    return Result.ok();
  }
  const result = await visit(directory, "");
  return Result.isError(result) ? result : Result.ok(snapshot);
}

/** Compares snapshot paths and bytes without relying on mtimes. */
function snapshotsEqual(left: ReadonlyMap<string, Buffer>, right: ReadonlyMap<string, Buffer>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, content] of left) {
    const other = right.get(path);
    if (!other || !content.equals(other)) return false;
  }
  return true;
}

/** Stages validated upstream skills and their commit metadata before changing the installed copy. */
async function stageSkills(
  source: string,
  staged: string,
  ref: string,
  options: SkillSyncOptions,
  fileSystem: SkillSyncFileSystem
): Promise<ResultType<string, SkillSyncError>> {
  const made = await fileOperation(staged, () => fileSystem.mkdir(staged, { recursive: true }));
  if (Result.isError(made)) return made;
  for (const skill of selectedSkills) {
    const sourceSkill = join(source, "skills", skill);
    const snapshot = await snapshotDirectory(sourceSkill, fileSystem);
    if (Result.isError(snapshot)) return snapshot;
    if (!snapshot.value.has("SKILL.md"))
      return Result.err(
        new SkillSyncError({
          reason: "upstream-entry",
          path: sourceSkill,
          message: "Upstream skill is missing SKILL.md.",
        })
      );
    const copied = await fileOperation(sourceSkill, () =>
      fileSystem.cp(sourceSkill, join(staged, skill), { recursive: true })
    );
    if (Result.isError(copied)) return copied;
  }
  const commit = await runGit(["rev-parse", "HEAD"], source);
  if (Result.isError(commit)) return commit;
  const encoded = Result.try({
    try: () =>
      JSON.stringify(
        { repository: options.upstreamRepository, ref, commit: commit.value, skills: selectedSkills },
        null,
        2
      ),
    catch: (cause) =>
      new SkillSyncError({ reason: "filesystem", cause, message: "Could not serialize skill sync metadata." }),
  });
  if (Result.isError(encoded)) return encoded;
  const metadata = join(staged, "upstream.json");
  const written = await fileOperation(metadata, () => fileSystem.writeFile(metadata, `${encoded.value}\n`, "utf8"));
  return Result.isError(written) ? written : commit;
}

/** Fetches, stages, and compares upstream before installing or reporting check-mode drift. */
async function syncInDirectory(
  args: SyncArguments,
  options: SkillSyncOptions,
  temporary: string,
  fileSystem: SkillSyncFileSystem
): Promise<ResultType<string, SkillSyncError>> {
  const source = join(temporary, "upstream");
  const staged = join(temporary, "staged");
  const target = join(options.repositoryRoot, "skills");
  const made = await fileOperation(source, () => fileSystem.mkdir(source, { recursive: true }));
  if (Result.isError(made)) return made;
  for (const command of [
    ["init", "--quiet"],
    ["remote", "add", "origin", options.upstreamRepository],
    ["fetch", "--quiet", "--depth", "1", "origin", args.ref],
    ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
  ]) {
    const ran = await runGit(command, source);
    if (Result.isError(ran)) return ran;
  }
  const commit = await stageSkills(source, staged, args.ref, options, fileSystem);
  if (Result.isError(commit)) return commit;
  const current = await snapshotDirectory(target, fileSystem);
  if (Result.isError(current)) return current;
  const next = await snapshotDirectory(staged, fileSystem);
  if (Result.isError(next)) return next;
  if (snapshotsEqual(current.value, next.value)) return Result.ok(`Hubble skills are current at ${commit.value}.`);
  if (args.check)
    return Result.err(
      new SkillSyncError({
        reason: "different",
        message: `Vendored Hubble skills differ from ${options.upstreamRepository}@${commit.value}`,
      })
    );
  const removed = await fileOperation(target, () => fileSystem.rm(target, { recursive: true, force: true }));
  if (Result.isError(removed)) return removed;
  const copied = await fileOperation(target, () => fileSystem.cp(staged, target, { recursive: true }));
  return Result.isError(copied)
    ? copied
    : Result.ok(`Synced Hubble skills from ${options.upstreamRepository}@${commit.value}.`);
}

/** Syncs or checks vendored skills, cleans temporary resources, and returns expected failures without throwing. */
export async function syncHubbleSkills(
  args: ReadonlyArray<string>,
  options: SkillSyncOptions
): Promise<ResultType<string, SkillSyncError>> {
  const parsed = parseArguments(args);
  if (Result.isError(parsed)) return parsed;
  const fileSystem = options.fileSystem ?? fs;
  const temporary = await fileOperation(tmpdir(), () => fileSystem.mkdtemp(join(tmpdir(), "pi-hubble-skills-")));
  if (Result.isError(temporary)) return temporary;
  let result: ResultType<string, SkillSyncError>;
  let cleaned: ResultType<void, SkillSyncError>;
  try {
    result = await syncInDirectory(parsed.value, options, temporary.value, fileSystem);
  } finally {
    cleaned = await fileOperation(temporary.value, () =>
      fileSystem.rm(temporary.value, { recursive: true, force: true })
    );
  }
  if (Result.isError(cleaned))
    return Result.err(
      new SkillSyncError({
        reason: "filesystem",
        path: temporary.value,
        cause: Result.isError(result)
          ? new AggregateError([result.error, cleaned.error], "Sync and cleanup failed")
          : cleaned.error,
        message: "Could not clean up skill sync temporary files.",
      })
    );
  return result;
}
