import { constants, type Dirent } from "node:fs";
import { access, mkdir, mkdtemp, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

export interface HubbleVault {
  root: string;
}

export interface HubblePath {
  absolute: string;
  relative: string;
}

export interface HubbleEdit {
  oldText: string;
  newText: string;
}

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isInside(root: string, candidate: string): boolean {
  const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(rootWithSeparator);
}

function normalizeUserPath(userPath: string): string {
  const normalized = userPath.startsWith("@") ? userPath.slice(1) : userPath;
  if (!normalized.trim()) throw new Error("Hubble path must not be empty.");
  if (isAbsolute(normalized)) {
    throw new Error("Hubble paths must be relative to the vault.");
  }
  return normalized;
}

async function canonicalRoot(root: string): Promise<string> {
  const resolvedRoot = resolve(root);
  try {
    const resolved = await realpath(resolvedRoot);
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory()) throw new Error(`Hubble vault is not a directory: ${root}`);
    return resolved;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  // If the configured root does not exist yet, canonicalize its nearest
  // existing ancestor so a symlink in the parent cannot escape unnoticed.
  const missingParts: string[] = [];
  let ancestor = resolvedRoot;
  while (true) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      const ancestorStat = await stat(resolvedAncestor);
      if (!ancestorStat.isDirectory()) throw new Error(`Hubble vault parent is not a directory: ${ancestor}`);
      return missingParts.reduce((path, part) => join(path, part), resolvedAncestor);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`Could not resolve Hubble vault root: ${root}`);
      missingParts.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function assertExistingParentInside(root: string, candidate: string): Promise<void> {
  let ancestor = dirname(candidate);
  while (!isInside(root, ancestor)) {
    throw new Error("Hubble path escapes the vault.");
  }

  while (true) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      if (!isInside(root, resolvedAncestor)) {
        throw new Error("Hubble path escapes the vault through a symlink.");
      }
      return;
    } catch (error) {
      if (!isMissingFileError(error) || ancestor === root) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("Could not resolve the Hubble path parent.");
      ancestor = parent;
    }
  }
}

export async function openVault(root: string): Promise<HubbleVault> {
  return { root: await canonicalRoot(root) };
}

export async function createVault(root: string): Promise<HubbleVault> {
  await mkdir(root, { recursive: true });
  return { root: await canonicalRoot(root) };
}

export async function resolveVaultPath(vault: HubbleVault, userPath: string): Promise<HubblePath> {
  const normalized = normalizeUserPath(userPath);
  const absolute = resolve(vault.root, normalized);
  if (!isInside(vault.root, absolute)) throw new Error("Hubble path escapes the vault.");

  try {
    const resolvedTarget = await realpath(absolute);
    if (!isInside(vault.root, resolvedTarget)) {
      throw new Error("Hubble path escapes the vault through a symlink.");
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    await assertExistingParentInside(vault.root, absolute);
  }

  return {
    absolute,
    relative: relative(vault.root, absolute).split(sep).join("/"),
  };
}

/** Resolve a vault-relative directory, allowing it not to exist yet. */
export async function resolveVaultDirectory(vault: HubbleVault, userPath: string): Promise<HubblePath> {
  const normalized = userPath.trim();
  if (!normalized) return { absolute: vault.root, relative: "" };
  if (isAbsolute(normalized)) throw new Error("Hubble folders must be relative to the vault.");

  const absolute = resolve(vault.root, normalized);
  if (!isInside(vault.root, absolute)) throw new Error("Hubble folder escapes the vault.");

  try {
    const resolvedTarget = await realpath(absolute);
    if (!isInside(vault.root, resolvedTarget)) {
      throw new Error("Hubble folder escapes the vault through a symlink.");
    }
    const targetStat = await stat(resolvedTarget);
    if (!targetStat.isDirectory()) throw new Error(`Hubble folder is not a directory: ${normalized}`);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    await assertExistingParentInside(vault.root, absolute);
  }

  return {
    absolute,
    relative: relative(vault.root, absolute).split(sep).join("/"),
  };
}

export function assertMarkdownPath(path: HubblePath): void {
  if (extname(path.relative).toLowerCase() !== ".md") {
    throw new Error(`Hubble document must be a Markdown file: ${path.relative}`);
  }
}

export function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "note";
}

export function applyExactEdits(content: string, edits: HubbleEdit[], path: string): string {
  if (edits.length === 0) throw new Error("At least one edit is required.");

  const matches = edits.map((edit, index) => {
    if (!edit.oldText) throw new Error(`edits[${index}].oldText must not be empty in ${path}.`);
    const first = content.indexOf(edit.oldText);
    if (first === -1) {
      throw new Error(`Could not find edits[${index}] in ${path}. oldText must match exactly.`);
    }
    const second = content.indexOf(edit.oldText, first + edit.oldText.length);
    if (second !== -1) {
      throw new Error(`edits[${index}].oldText is not unique in ${path}.`);
    }
    return { ...edit, index, start: first, end: first + edit.oldText.length };
  });

  const sorted = [...matches].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1].end > sorted[index].start) {
      throw new Error(`edits overlap in ${path}. Use disjoint exact replacements.`);
    }
  }

  let result = content;
  for (const edit of [...sorted].reverse()) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  if (result === content) throw new Error(`The edits made no changes to ${path}.`);
  return result;
}

export async function readVaultFile(path: HubblePath): Promise<string> {
  await access(path.absolute, constants.R_OK);
  const fileStat = await stat(path.absolute);
  if (!fileStat.isFile()) throw new Error(`Hubble path is not a file: ${path.relative}`);
  return withFileMutationQueue(path.absolute, () => readFile(path.absolute, "utf8"));
}

export async function writeNewVaultFile(
  vault: HubbleVault,
  title: string,
  content: string,
  folder = ""
): Promise<HubblePath> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error("title must not be empty.");

  return withFileMutationQueue(vault.root, async () => {
    await mkdir(vault.root, { recursive: true });
    const directory = await resolveVaultDirectory(vault, folder);
    await mkdir(directory.absolute, { recursive: true });
    const slug = slugifyTitle(trimmedTitle);
    const body = `# ${trimmedTitle}\n\n${content}`;

    for (let suffix = 0; suffix < 10_000; suffix++) {
      const filename = `${slug}${suffix === 0 ? "" : `-${suffix + 1}`}.md`;
      const absolute = join(directory.absolute, filename);
      try {
        const handle = await open(absolute, "wx");
        try {
          await handle.writeFile(body, "utf8");
        } finally {
          await handle.close();
        }
        const fileRelative = relative(directory.absolute, absolute).split(sep).join("/");
        return {
          absolute,
          relative: directory.relative ? `${directory.relative}/${fileRelative}` : fileRelative,
        };
      } catch (error) {
        if (!isExistingFileError(error)) throw error;
      }
    }

    throw new Error(`Could not find an unused filename for ${trimmedTitle}.`);
  });
}

export async function appendToVaultFile(path: HubblePath, content: string): Promise<void> {
  if (!content) throw new Error("content must not be empty.");
  await withFileMutationQueue(path.absolute, async () => {
    const current = await readFile(path.absolute, "utf8");
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await writeFile(path.absolute, current + separator + content, "utf8");
  });
}

export async function editVaultFile(path: HubblePath, edits: HubbleEdit[]): Promise<void> {
  await withFileMutationQueue(path.absolute, async () => {
    const current = await readFile(path.absolute, "utf8");
    const next = applyExactEdits(current, edits, path.relative);
    await writeFile(path.absolute, next, "utf8");
  });
}

export async function listMarkdownFiles(vault: HubbleVault): Promise<HubblePath[]> {
  const files: HubblePath[] = [];

  async function visit(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }

    for (const entry of entries) {
      // Skip symlinks during discovery. Explicit paths are checked separately.
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        files.push({
          absolute,
          relative: relative(vault.root, absolute).split(sep).join("/"),
        });
      }
    }
  }

  try {
    const rootStat = await stat(vault.root);
    if (!rootStat.isDirectory()) throw new Error(`Hubble vault is not a directory: ${vault.root}`);
  } catch (error) {
    if (isMissingFileError(error)) return files;
    throw error;
  }

  await visit(vault.root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

export async function truncateOutput(output: string): Promise<TruncatedOutput> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return { text: truncation.content, truncated: false };

  const directory = await mkdtemp(join(tmpdir(), "pi-hubble-"));
  const fullOutputPath = join(directory, "output.txt");
  await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, output, "utf8"));

  const text = `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
  return { text, truncated: true, fullOutputPath };
}

function isExistingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
