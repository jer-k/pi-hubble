import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Result, type Result as ResultType } from "better-result";
import {
  type AppendNoteError,
  type CreateNoteResult,
  type DiscoveryError,
  type EditNoteError,
  EditValidationError,
  NoteAppendValidationError,
  NoteNotFoundError,
  NoteReadError,
  type NoteReadResult,
  NoteTitleError,
  NoteWriteError,
  VaultDiscoveryError,
  VaultRootTypeError,
} from "./hubble-errors.ts";
import { resolveVaultDirectory } from "./hubble-paths.ts";
import type { HubbleEdit, HubblePath, HubbleVault } from "./hubble-types.ts";

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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

export function applyExactEditsResult(
  content: string,
  edits: HubbleEdit[],
  path: string
): ResultType<string, EditValidationError> {
  if (edits.length === 0) {
    return Result.err(new EditValidationError({ path, reason: "empty", message: "At least one edit is required." }));
  }

  const matches: Array<HubbleEdit & { index: number; start: number; end: number }> = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (!edit.oldText) {
      return Result.err(
        new EditValidationError({
          path,
          reason: "empty",
          message: `edits[${index}].oldText must not be empty in ${path}.`,
        })
      );
    }

    const first = content.indexOf(edit.oldText);
    if (first === -1) {
      return Result.err(
        new EditValidationError({
          path,
          reason: "missing",
          message: `Could not find edits[${index}] in ${path}. oldText must match exactly.`,
        })
      );
    }

    const second = content.indexOf(edit.oldText, first + edit.oldText.length);
    if (second !== -1) {
      return Result.err(
        new EditValidationError({
          path,
          reason: "duplicate",
          message: `edits[${index}].oldText is not unique in ${path}.`,
        })
      );
    }

    matches.push({ ...edit, index, start: first, end: first + edit.oldText.length });
  }

  const sorted = [...matches].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1].end > sorted[index].start) {
      return Result.err(
        new EditValidationError({
          path,
          reason: "overlap",
          message: `edits overlap in ${path}. Use disjoint exact replacements.`,
        })
      );
    }
  }

  let result = content;
  for (const edit of [...sorted].reverse()) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  if (result === content) {
    return Result.err(
      new EditValidationError({ path, reason: "no-op", message: `The edits made no changes to ${path}.` })
    );
  }
  return Result.ok(result);
}

export function applyExactEdits(content: string, edits: HubbleEdit[], path: string): string {
  const result = applyExactEditsResult(content, edits, path);
  if (Result.isError(result)) throw result.error;
  return result.value;
}

function noteReadError(path: HubblePath, cause: unknown): NoteNotFoundError | NoteReadError {
  if (isMissingFileError(cause))
    return new NoteNotFoundError({ path: path.relative, message: `Hubble note was not found: ${path.relative}` });
  return new NoteReadError({ path: path.relative, cause, message: `Could not read Hubble note: ${path.relative}.` });
}

export async function readVaultFile(path: HubblePath): Promise<NoteReadResult> {
  const accessible = await Result.tryPromise({
    try: () => access(path.absolute, constants.R_OK),
    catch: (cause) => noteReadError(path, cause),
  });

  if (Result.isError(accessible)) return accessible;
  const fileStat = await Result.tryPromise({
    try: () => stat(path.absolute),
    catch: (cause) => noteReadError(path, cause),
  });
  if (Result.isError(fileStat)) return fileStat;
  if (!fileStat.value.isFile())
    return Result.err(
      new NoteReadError({
        path: path.relative,
        cause: undefined,
        message: `Hubble path is not a file: ${path.relative}`,
      })
    );
  return withFileMutationQueue(path.absolute, () =>
    Result.tryPromise({ try: () => readFile(path.absolute, "utf8"), catch: (cause) => noteReadError(path, cause) })
  );
}

export async function writeNewVaultFile(
  vault: HubbleVault,
  title: string,
  content: string,
  folder = ""
): Promise<CreateNoteResult> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return Result.err(new NoteTitleError({ title, message: "title must not be empty." }));
  return withFileMutationQueue(vault.root, async () => {
    const rootCreated = await Result.tryPromise({
      try: () => mkdir(vault.root, { recursive: true }),
      catch: (cause) =>
        new NoteWriteError({
          operation: "create",
          path: vault.root,
          title: trimmedTitle,
          cause,
          message: "Could not create the Hubble vault directory.",
        }),
    });
    if (Result.isError(rootCreated)) return rootCreated;
    const directory = await resolveVaultDirectory(vault, folder);
    if (Result.isError(directory)) return directory;
    const directoryCreated = await Result.tryPromise({
      try: () => mkdir(directory.value.absolute, { recursive: true }),
      catch: (cause) =>
        new NoteWriteError({
          operation: "create",
          path: directory.value.relative || vault.root,
          title: trimmedTitle,
          cause,
          message: "Could not create the Hubble note folder.",
        }),
    });
    if (Result.isError(directoryCreated)) return directoryCreated;
    const slug = slugifyTitle(trimmedTitle);
    const body = `# ${trimmedTitle}\n\n${content}`;
    for (let suffix = 0; suffix < 10_000; suffix++) {
      const filename = `${slug}${suffix === 0 ? "" : `-${suffix + 1}`}.md`;
      const absolute = join(directory.value.absolute, filename);
      const opened = await Result.tryPromise({
        try: () => open(absolute, "wx"),
        catch: (cause) =>
          new NoteWriteError({
            operation: "create",
            path: directory.value.relative ? `${directory.value.relative}/${filename}` : filename,
            title: trimmedTitle,
            cause,
            message: "Could not create the Hubble note.",
          }),
      });
      if (Result.isError(opened)) {
        if (isExistingFileError(opened.error.cause)) continue;
        return opened;
      }
      const handle = opened.value;
      let written!: ResultType<void, NoteWriteError>;
      let closed!: ResultType<void, NoteWriteError>;
      try {
        written = await Result.tryPromise({
          try: () => handle.writeFile(body, "utf8"),
          catch: (cause) =>
            new NoteWriteError({
              operation: "create",
              path: directory.value.relative ? `${directory.value.relative}/${filename}` : filename,
              title: trimmedTitle,
              cause,
              message: "Could not write the Hubble note.",
            }),
        });
      } finally {
        closed = await Result.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new NoteWriteError({
              operation: "create",
              path: directory.value.relative ? `${directory.value.relative}/${filename}` : filename,
              title: trimmedTitle,
              cause,
              message: "Could not close the Hubble note.",
            }),
        });
      }
      if (Result.isError(written)) return written;
      if (Result.isError(closed)) return closed;
      const fileRelative = relative(directory.value.absolute, absolute).split(sep).join("/");
      return Result.ok({
        absolute,
        relative: directory.value.relative ? `${directory.value.relative}/${fileRelative}` : fileRelative,
      });
    }
    return Result.err(
      new NoteWriteError({
        operation: "create",
        path: directory.value.relative || vault.root,
        title: trimmedTitle,
        cause: new Error("filename exhaustion"),
        message: `Could not find an unused filename for ${trimmedTitle}.`,
      })
    );
  });
}

export async function appendToVaultFile(path: HubblePath, content: string): Promise<ResultType<void, AppendNoteError>> {
  if (!content)
    return Result.err(new NoteAppendValidationError({ path: path.relative, message: "content must not be empty." }));
  return withFileMutationQueue(path.absolute, async () => {
    const current = await Result.tryPromise({
      try: () => readFile(path.absolute, "utf8"),
      catch: (cause) => noteReadError(path, cause),
    });
    if (Result.isError(current)) return current;
    const separator = current.value.length > 0 && !current.value.endsWith("\n") ? "\n" : "";
    return Result.tryPromise({
      try: () => writeFile(path.absolute, current.value + separator + content, "utf8"),
      catch: (cause) =>
        new NoteWriteError({
          operation: "append",
          path: path.relative,
          cause,
          message: `Could not append to Hubble note: ${path.relative}.`,
        }),
    });
  });
}

export async function editVaultFile(path: HubblePath, edits: HubbleEdit[]): Promise<ResultType<void, EditNoteError>> {
  return withFileMutationQueue(path.absolute, async () => {
    const current = await Result.tryPromise({
      try: () => readFile(path.absolute, "utf8"),
      catch: (cause) => noteReadError(path, cause),
    });
    if (Result.isError(current)) return current;
    const next = applyExactEditsResult(current.value, edits, path.relative);
    if (Result.isError(next)) return next;
    return Result.tryPromise({
      try: () => writeFile(path.absolute, next.value, "utf8"),
      catch: (cause) =>
        new NoteWriteError({
          operation: "edit",
          path: path.relative,
          cause,
          message: `Could not edit Hubble note: ${path.relative}.`,
        }),
    });
  });
}

export async function listMarkdownFiles(vault: HubbleVault): Promise<ResultType<HubblePath[], DiscoveryError>> {
  const files: HubblePath[] = [];
  async function visit(directory: string): Promise<ResultType<void, VaultDiscoveryError>> {
    const entries = await Result.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) =>
        new VaultDiscoveryError({ path: directory, cause, message: `Could not scan the Hubble vault: ${directory}.` }),
    });
    if (Result.isError(entries)) {
      if (isMissingFileError(entries.error.cause)) return Result.ok();
      return entries;
    }
    for (const entry of entries.value) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        const visited = await visit(absolute);
        if (Result.isError(visited)) return visited;
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        files.push({ absolute, relative: relative(vault.root, absolute).split(sep).join("/") });
      }
    }
    return Result.ok();
  }
  const rootStat = await Result.tryPromise({
    try: () => stat(vault.root),
    catch: (cause) =>
      new VaultDiscoveryError({
        path: vault.root,
        cause,
        message: `Could not inspect the Hubble vault: ${vault.root}.`,
      }),
  });
  if (Result.isError(rootStat)) {
    if (isMissingFileError(rootStat.error.cause)) return Result.ok(files);
    return rootStat;
  }
  if (!rootStat.value.isDirectory())
    return Result.err(
      new VaultRootTypeError({ root: vault.root, message: `Hubble vault is not a directory: ${vault.root}` })
    );
  const visited = await visit(vault.root);
  if (Result.isError(visited)) return visited;
  return Result.ok(files.sort((a, b) => a.relative.localeCompare(b.relative)));
}

function isExistingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
