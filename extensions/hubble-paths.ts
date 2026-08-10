import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Result, type Result as ResultType } from "better-result";
import { VaultOpenError, type VaultOpenErrorType, VaultPathError, type VaultPathReason } from "./hubble-errors.ts";

export interface HubblePath {
  absolute: string;
  relative: string;
}

export interface VaultRoot {
  root: string;
}

export type VaultPathResult = ResultType<HubblePath, VaultPathError>;

/** Identifies filesystem errors caused by a missing path. */
function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Reports whether a candidate path remains inside the canonical vault root. */
function isInside(root: string, candidate: string): boolean {
  const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(rootWithSeparator);
}

/** Creates a consistent typed error for invalid or unsafe vault paths. */
function pathError(input: string, reason: VaultPathReason, message: string, cause?: unknown): VaultPathError {
  return new VaultPathError({ input, reason, cause, message });
}

/** Resolves a vault root, including roots whose final directories do not exist yet. */
export async function canonicalVaultRoot(root: string): Promise<ResultType<string, VaultOpenErrorType>> {
  const resolvedRoot = resolve(root);
  const resolved = await Result.tryPromise({
    try: () => realpath(resolvedRoot),
    catch: (cause) =>
      new VaultOpenError({ root, reason: "open", cause, message: "Could not open the configured Hubble vault." }),
  });

  if (Result.isOk(resolved)) {
    const rootStat = await Result.tryPromise({
      try: () => stat(resolved.value),
      catch: (cause) =>
        new VaultOpenError({ root, reason: "open", cause, message: "Could not open the configured Hubble vault." }),
    });

    if (Result.isError(rootStat)) return rootStat;

    if (!rootStat.value.isDirectory()) {
      return Result.err(
        new VaultOpenError({
          root,
          reason: "not-directory",
          message: "The configured Hubble vault is not a directory.",
        })
      );
    }

    return Result.ok(resolved.value);
  }

  if (!isMissingFileError(resolved.error.cause)) return resolved;

  const missingParts: string[] = [];
  let ancestor = resolvedRoot;
  while (true) {
    const resolvedAncestor = await Result.tryPromise({
      try: () => realpath(ancestor),
      catch: (cause) =>
        new VaultOpenError({ root, reason: "open", cause, message: "Could not open the configured Hubble vault." }),
    });

    if (Result.isOk(resolvedAncestor)) {
      const ancestorStat = await Result.tryPromise({
        try: () => stat(resolvedAncestor.value),
        catch: (cause) =>
          new VaultOpenError({ root, reason: "open", cause, message: "Could not open the configured Hubble vault." }),
      });

      if (Result.isError(ancestorStat)) return ancestorStat;

      if (!ancestorStat.value.isDirectory()) {
        return Result.err(
          new VaultOpenError({
            root,
            reason: "not-directory",
            message: "The configured Hubble vault is not a directory.",
          })
        );
      }

      return Result.ok(missingParts.reduce((path, part) => join(path, part), resolvedAncestor.value));
    }

    if (!isMissingFileError(resolvedAncestor.error.cause)) return resolvedAncestor;

    const parent = dirname(ancestor);
    if (parent === ancestor) {
      return Result.err(
        new VaultOpenError({
          root,
          reason: "open",
          cause: resolvedAncestor.error.cause,
          message: "Could not open the configured Hubble vault.",
        })
      );
    }
    missingParts.unshift(basename(ancestor));
    ancestor = parent;
  }
}

/** Verifies that the existing ancestor of a missing target stays within the vault. */
async function assertExistingAncestorInside(
  root: string,
  candidate: string,
  input: string
): Promise<ResultType<void, VaultPathError>> {
  let ancestor = dirname(candidate);
  while (true) {
    if (!isInside(root, ancestor)) return Result.err(pathError(input, "escape", "Hubble path escapes the vault."));
    const resolvedAncestor = await Result.tryPromise({
      try: () => realpath(ancestor),
      catch: (cause) => pathError(input, "filesystem", "Could not resolve the requested Hubble path.", cause),
    });

    if (Result.isOk(resolvedAncestor)) {
      return isInside(root, resolvedAncestor.value)
        ? Result.ok()
        : Result.err(pathError(input, "symlink-escape", "Hubble path escapes the vault through a symlink."));
    }

    if (!isMissingFileError(resolvedAncestor.error.cause)) return Result.err(resolvedAncestor.error);
    // A canonicalized Vault may legitimately have a missing root. Let note
    // operations resolve to the filesystem so they can return NoteNotFound.

    if (ancestor === root) return Result.ok();

    const parent = dirname(ancestor);
    if (parent === ancestor)
      return Result.err(pathError(input, "filesystem", "Could not resolve the requested Hubble path."));

    ancestor = parent;
  }
}

/** Resolves a note or folder path while enforcing vault containment and symlink safety. */
async function resolveContained(
  vault: VaultRoot,
  userPath: string,
  policy: "note" | "folder"
): Promise<VaultPathResult> {
  const normalized = policy === "note" && userPath.startsWith("@") ? userPath.slice(1) : userPath.trim();
  if (!normalized) {
    return policy === "folder"
      ? Result.ok({ absolute: vault.root, relative: "" })
      : Result.err(pathError(normalized, "empty", "Hubble path must not be empty."));
  }

  if (isAbsolute(normalized)) {
    return Result.err(
      pathError(
        normalized,
        "absolute",
        `Hubble ${policy === "folder" ? "folders" : "paths"} must be relative to the vault.`
      )
    );
  }

  const absolute = resolve(vault.root, normalized);
  if (!isInside(vault.root, absolute))
    return Result.err(pathError(normalized, "escape", "Hubble path escapes the vault."));

  const resolvedTarget = await Result.tryPromise({
    try: () => realpath(absolute),
    catch: (cause) => pathError(normalized, "filesystem", `Could not resolve the requested Hubble ${policy}.`, cause),
  });

  if (Result.isError(resolvedTarget)) {
    if (!isMissingFileError(resolvedTarget.error.cause)) return resolvedTarget;

    const parent = await assertExistingAncestorInside(vault.root, absolute, normalized);
    if (Result.isError(parent)) return parent;
  } else if (!isInside(vault.root, resolvedTarget.value)) {
    return Result.err(pathError(normalized, "symlink-escape", `Hubble ${policy} escapes the vault through a symlink.`));
  }

  if (policy === "folder" && Result.isOk(resolvedTarget)) {
    const targetStat = await Result.tryPromise({
      try: () => stat(resolvedTarget.value),
      catch: (cause) => pathError(normalized, "filesystem", "Could not inspect the requested Hubble folder.", cause),
    });

    if (Result.isError(targetStat)) return targetStat;

    if (!targetStat.value.isDirectory())
      return Result.err(pathError(normalized, "not-directory", "The requested Hubble folder is not a directory."));
  }

  return Result.ok({ absolute, relative: relative(vault.root, absolute).split(sep).join("/") });
}

/** Resolves a user-supplied note path relative to the vault. */
export function resolveVaultPath(vault: VaultRoot, userPath: string): Promise<VaultPathResult> {
  return resolveContained(vault, userPath, "note");
}

/** Resolves a user-supplied folder path relative to the vault. */
export function resolveVaultDirectory(vault: VaultRoot, userPath: string): Promise<VaultPathResult> {
  return resolveContained(vault, userPath, "folder");
}

/** Ensures a resolved vault target points to a Markdown document. */
export function assertMarkdownPath(path: HubblePath): ResultType<void, VaultPathError> {
  if (extname(path.relative.toLowerCase()) !== ".md") {
    return Result.err(pathError(path.relative, "not-markdown", "Hubble document must be a Markdown file."));
  }
  return Result.ok();
}
