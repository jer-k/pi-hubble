import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Result, type Result as ResultType } from "better-result";
import {
  InvalidMarkdownPathError,
  VaultOpenError,
  type VaultOpenErrorType,
  VaultPathError,
  type VaultPathReason,
  type VaultPathResult,
  VaultRootTypeError,
} from "./hubble-errors.ts";
import type { HubblePath, HubbleVault } from "./hubble-types.ts";

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isInside(root: string, candidate: string): boolean {
  const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(rootWithSeparator);
}

function pathError(input: string, reason: VaultPathReason, message: string, cause?: unknown): VaultPathError {
  return new VaultPathError({ input, reason, cause, message });
}

async function canonicalRoot(root: string): Promise<ResultType<string, VaultOpenErrorType>> {
  const resolvedRoot = resolve(root);
  const resolved = await Result.tryPromise({
    try: () => realpath(resolvedRoot),
    catch: (cause) => new VaultOpenError({ root, cause, message: "Could not canonicalize the Hubble vault root." }),
  });
  if (Result.isOk(resolved)) {
    const rootStat = await Result.tryPromise({
      try: () => stat(resolved.value),
      catch: (cause) => new VaultOpenError({ root, cause, message: "Could not inspect the Hubble vault root." }),
    });
    if (Result.isError(rootStat)) return rootStat;
    if (!rootStat.value.isDirectory()) {
      return Result.err(new VaultRootTypeError({ root, message: `Hubble vault is not a directory: ${root}` }));
    }
    return Result.ok(resolved.value);
  }
  if (!isMissingFileError(resolved.error.cause)) return resolved;

  const missingParts: string[] = [];
  let ancestor = resolvedRoot;
  while (true) {
    const resolvedAncestor = await Result.tryPromise({
      try: () => realpath(ancestor),
      catch: (cause) => new VaultOpenError({ root, cause, message: "Could not canonicalize the Hubble vault parent." }),
    });
    if (Result.isOk(resolvedAncestor)) {
      const ancestorStat = await Result.tryPromise({
        try: () => stat(resolvedAncestor.value),
        catch: (cause) => new VaultOpenError({ root, cause, message: "Could not inspect the Hubble vault parent." }),
      });
      if (Result.isError(ancestorStat)) return ancestorStat;
      if (!ancestorStat.value.isDirectory()) {
        return Result.err(
          new VaultRootTypeError({ root, message: `Hubble vault parent is not a directory: ${ancestor}` })
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
          cause: resolvedAncestor.error.cause,
          message: `Could not resolve Hubble vault root: ${root}`,
        })
      );
    }
    missingParts.unshift(basename(ancestor));
    ancestor = parent;
  }
}

async function assertExistingParentInside(
  root: string,
  candidate: string,
  input: string
): Promise<ResultType<void, VaultPathError>> {
  let ancestor = dirname(candidate);
  while (true) {
    if (!isInside(root, ancestor)) return Result.err(pathError(input, "escape", "Hubble path escapes the vault."));

    const resolvedAncestor = await Result.tryPromise({
      try: () => realpath(ancestor),
      catch: (cause) => pathError(input, "filesystem", "Could not resolve the Hubble path parent.", cause),
    });
    if (Result.isOk(resolvedAncestor)) {
      if (!isInside(root, resolvedAncestor.value)) {
        return Result.err(pathError(input, "symlink-escape", "Hubble path escapes the vault through a symlink."));
      }
      return Result.ok();
    }

    if (!isMissingFileError(resolvedAncestor.error.cause) || ancestor === root)
      return Result.err(resolvedAncestor.error);
    const parent = dirname(ancestor);
    if (parent === ancestor)
      return Result.err(pathError(input, "filesystem", "Could not resolve the Hubble path parent."));
    ancestor = parent;
  }
}

export async function openVault(root: string): Promise<ResultType<HubbleVault, VaultOpenErrorType>> {
  const canonical = await canonicalRoot(root);
  if (Result.isError(canonical)) return canonical;
  return Result.ok({ root: canonical.value });
}

export async function createVault(root: string): Promise<ResultType<HubbleVault, VaultOpenErrorType>> {
  const created = await Result.tryPromise({
    try: () => mkdir(root, { recursive: true }),
    catch: (cause) => new VaultOpenError({ root, cause, message: "Could not create the Hubble vault." }),
  });
  if (Result.isError(created)) return created;
  return openVault(root);
}

export async function resolveVaultPath(vault: HubbleVault, userPath: string): Promise<VaultPathResult> {
  const normalized = userPath.startsWith("@") ? userPath.slice(1) : userPath;
  if (!normalized.trim()) return Result.err(pathError(normalized, "empty", "Hubble path must not be empty."));
  if (isAbsolute(normalized))
    return Result.err(pathError(normalized, "absolute", "Hubble paths must be relative to the vault."));

  const absolute = resolve(vault.root, normalized);
  if (!isInside(vault.root, absolute))
    return Result.err(pathError(normalized, "escape", "Hubble path escapes the vault."));

  const resolvedTarget = await Result.tryPromise({
    try: () => realpath(absolute),
    catch: (cause) => pathError(normalized, "filesystem", "Could not resolve the Hubble path.", cause),
  });
  if (Result.isError(resolvedTarget)) {
    if (!isMissingFileError(resolvedTarget.error.cause)) return resolvedTarget;
    const parent = await assertExistingParentInside(vault.root, absolute, normalized);
    if (Result.isError(parent)) return parent;
  } else if (!isInside(vault.root, resolvedTarget.value)) {
    return Result.err(pathError(normalized, "symlink-escape", "Hubble path escapes the vault through a symlink."));
  }

  return Result.ok({ absolute, relative: relative(vault.root, absolute).split(sep).join("/") });
}

export async function resolveVaultDirectory(
  vault: HubbleVault,
  userPath: string
): Promise<ResultType<HubblePath, VaultPathError>> {
  const normalized = userPath.trim();
  if (!normalized) return Result.ok({ absolute: vault.root, relative: "" });
  if (isAbsolute(normalized))
    return Result.err(pathError(normalized, "absolute", "Hubble folders must be relative to the vault."));

  const absolute = resolve(vault.root, normalized);
  if (!isInside(vault.root, absolute))
    return Result.err(pathError(normalized, "escape", "Hubble folder escapes the vault."));

  const resolvedTarget = await Result.tryPromise({
    try: () => realpath(absolute),
    catch: (cause) => pathError(normalized, "filesystem", "Could not resolve the Hubble folder.", cause),
  });
  if (Result.isError(resolvedTarget)) {
    if (isMissingFileError(resolvedTarget.error.cause)) {
      const parent = await assertExistingParentInside(vault.root, absolute, normalized);
      return parent.status === "error"
        ? parent
        : Result.ok({ absolute, relative: relative(vault.root, absolute).split(sep).join("/") });
    }
    return Result.err(resolvedTarget.error);
  }

  if (!isInside(vault.root, resolvedTarget.value)) {
    return Result.err(pathError(normalized, "symlink-escape", "Hubble folder escapes the vault through a symlink."));
  }
  const targetStat = await Result.tryPromise({
    try: () => stat(resolvedTarget.value),
    catch: (cause) => pathError(normalized, "filesystem", "Could not inspect the Hubble folder.", cause),
  });
  if (Result.isError(targetStat)) return Result.err(targetStat.error);
  if (!targetStat.value.isDirectory())
    return Result.err(pathError(normalized, "not-directory", `Hubble folder is not a directory: ${normalized}`));

  return Result.ok({ absolute, relative: relative(vault.root, absolute).split(sep).join("/") });
}

export function assertMarkdownPath(path: HubblePath): ResultType<void, InvalidMarkdownPathError> {
  if (!(extname(path.relative.toLowerCase()) === ".md")) {
    return Result.err(
      new InvalidMarkdownPathError({
        path: path.relative,
        message: `Hubble document must be a Markdown file: ${path.relative}`,
      })
    );
  }
  return Result.ok();
}
