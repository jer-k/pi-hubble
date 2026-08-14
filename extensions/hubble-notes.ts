import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Result, type Result as ResultType } from "better-result";
import {
  type AppendNoteError,
  type CreateNoteResult,
  type DiscoveryError,
  type EditNoteError,
  EditValidationError,
  ExistingFileError,
  mapFileSystemError,
  MissingFileError,
  NoteNotFoundError,
  NoteReadError,
  type NoteReadResult,
  NoteValidationError,
  NoteWriteError,
  VaultDiscoveryError,
} from "./hubble-errors.ts";
import {
  type HubbleNoteFormat,
  type HubblePath,
  isNotePath,
  resolveVaultDirectory,
  type VaultRoot,
} from "./hubble-paths.ts";

export interface HubbleEdit {
  oldText: string;
  newText: string;
}

export type NoteReference = HubblePath;

/** Turns a note title into a filesystem-safe filename slug. */
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

/** Validates and applies unique, non-overlapping exact-text replacements. */
export function applyExactEditsResult(
  content: string,
  edits: HubbleEdit[],
  path: string
): ResultType<string, EditValidationError> {
  if (edits.length === 0)
    return Result.err(new EditValidationError({ path, reason: "empty", message: "At least one edit is required." }));

  const matches: Array<HubbleEdit & { index: number; start: number; end: number }> = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (!edit.oldText) {
      return Result.err(
        new EditValidationError({ path, reason: "empty", message: `edits[${index}].oldText must not be empty.` })
      );
    }
    const first = content.indexOf(edit.oldText);
    if (first === -1) {
      return Result.err(
        new EditValidationError({ path, reason: "missing", message: "Could not find an exact edit match." })
      );
    }
    const second = content.indexOf(edit.oldText, first + edit.oldText.length);
    if (second !== -1) {
      return Result.err(
        new EditValidationError({ path, reason: "duplicate", message: "An edit's oldText is not unique." })
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
          message: "Hubble edits must be disjoint; overlapping edits are not allowed.",
        })
      );
    }
  }

  let result = content;
  for (const edit of [...sorted].reverse())
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  if (result === content)
    return Result.err(new EditValidationError({ path, reason: "no-op", message: "The edits made no changes." }));
  return Result.ok(result);
}

/** Applies exact edits synchronously and throws when the edit set is invalid. */
export function applyExactEdits(content: string, edits: HubbleEdit[], path: string): string {
  const result = applyExactEditsResult(content, edits, path);
  if (Result.isError(result)) throw result.error;
  return result.value;
}

/** Maps a filesystem read failure to the appropriate public note error. */
function noteReadError(path: HubblePath, cause: unknown): NoteNotFoundError | NoteReadError {
  const filesystemError = mapFileSystemError(path.absolute, cause);
  if (MissingFileError.is(filesystemError))
    return new NoteNotFoundError({ path: path.relative, message: "The requested Hubble note was not found." });
  return new NoteReadError({
    path: path.relative,
    cause: filesystemError,
    message: "Could not read the requested Hubble note.",
  });
}

/** Reads one validated vault file while distinguishing missing and unreadable notes. */
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
      new NoteReadError({ path: path.relative, cause: undefined, message: "The requested Hubble path is not a file." })
    );
  return withFileMutationQueue(path.absolute, () =>
    Result.tryPromise({ try: () => readFile(path.absolute, "utf8"), catch: (cause) => noteReadError(path, cause) })
  );
}

/** Escapes text before embedding it in an HTML text context. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Builds a standalone HTML document around a caller-supplied body fragment. */
function htmlDocument(title: string, content: string): string {
  const escapedTitle = escapeHtml(title);
  const bodyContent = content ? `\n${content}` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapedTitle}</title>
</head>
<body>
  <h1>${escapedTitle}</h1>${bodyContent}
</body>
</html>`;
}

/** Creates a uniquely named note in the requested format and optional folder. */
export async function writeNewVaultFile(
  vault: VaultRoot,
  title: string,
  content: string,
  folder = "",
  format: HubbleNoteFormat = "markdown"
): Promise<CreateNoteResult> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle)
    return Result.err(new NoteValidationError({ reason: "title", title, message: "title must not be empty." }));
  return withFileMutationQueue(vault.root, async () => {
    const rootCreated = await Result.tryPromise({
      try: () => mkdir(vault.root, { recursive: true }),
      catch: (cause) =>
        new NoteWriteError({
          operation: "create",
          path: vault.root,
          title: trimmedTitle,
          cause: mapFileSystemError(vault.root, cause),
          message: "Could not create the Hubble vault directory.",
        }),
    });

    if (Result.isError(rootCreated)) return rootCreated;

    // Force the vault root through canonical resolution after mkdir. An empty
    // folder normally uses the root fast path, which is useful while the root
    // is missing but must not bypass revalidation before a note is opened.
    const directory = await resolveVaultDirectory(vault, folder.trim() || ".");
    if (Result.isError(directory)) return directory;

    const directoryCreated = await Result.tryPromise({
      try: () => mkdir(directory.value.absolute, { recursive: true }),
      catch: (cause) =>
        new NoteWriteError({
          operation: "create",
          path: directory.value.relative || vault.root,
          title: trimmedTitle,
          cause: mapFileSystemError(directory.value.absolute, cause),
          message: "Could not create the Hubble note folder.",
        }),
    });
    if (Result.isError(directoryCreated)) return directoryCreated;

    const slug = slugifyTitle(trimmedTitle);
    const extension = format === "html" ? ".html" : ".md";
    const body = format === "html" ? htmlDocument(trimmedTitle, content) : `# ${trimmedTitle}\n\n${content}`;
    for (let suffix = 0; suffix < 10_000; suffix++) {
      const filename = `${slug}${suffix === 0 ? "" : `-${suffix + 1}`}${extension}`;
      const absolute = join(directory.value.absolute, filename);
      const relativePath = directory.value.relative ? `${directory.value.relative}/${filename}` : filename;
      const opened = await Result.tryPromise({
        try: () => open(absolute, "wx"),
        catch: (cause) =>
          new NoteWriteError({
            operation: "create",
            path: relativePath,
            title: trimmedTitle,
            cause: mapFileSystemError(absolute, cause),
            message: "Could not create the Hubble note.",
          }),
      });

      if (Result.isError(opened)) {
        if (ExistingFileError.is(opened.error.cause)) continue;
        return opened;
      }

      const handle = opened.value;
      let written: ResultType<void, NoteWriteError>;
      let closed: ResultType<void, NoteWriteError>;
      try {
        written = await Result.tryPromise({
          try: () => handle.writeFile(body, "utf8"),
          catch: (cause) =>
            new NoteWriteError({
              operation: "create",
              path: relativePath,
              title: trimmedTitle,
              cause: mapFileSystemError(absolute, cause),
              message: "Could not write the Hubble note.",
            }),
        });
      } finally {
        closed = await Result.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new NoteWriteError({
              operation: "create",
              path: relativePath,
              title: trimmedTitle,
              cause: mapFileSystemError(absolute, cause),
              message: "Could not close the Hubble note.",
            }),
        });
      }

      if (Result.isError(written)) return written;
      if (Result.isError(closed)) return closed;

      return Result.ok({ absolute, relative: relativePath });
    }
    return Result.err(
      new NoteWriteError({
        operation: "create",
        path: directory.value.relative || vault.root,
        title: trimmedTitle,
        cause: new Error("filename exhaustion"),
        message: "Could not find an unused Hubble filename.",
      })
    );
  });
}

/** Appends Markdown to an existing vault file without replacing its contents. */
export async function appendToVaultFile(path: HubblePath, content: string): Promise<ResultType<void, AppendNoteError>> {
  if (!content)
    return Result.err(
      new NoteValidationError({ reason: "append", path: path.relative, message: "content must not be empty." })
    );
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
          cause: mapFileSystemError(path.absolute, cause),
          message: "Could not append to the Hubble note.",
        }),
    });
  });
}

/** Applies validated exact edits to an existing vault file. */
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
          cause: mapFileSystemError(path.absolute, cause),
          message: "Could not edit the Hubble note.",
        }),
    });
  });
}

/** Recursively discovers supported Hubble notes while ignoring symlinks. */
export async function listNoteFiles(vault: VaultRoot): Promise<ResultType<NoteReference[], DiscoveryError>> {
  const files: NoteReference[] = [];
  /** Walks one vault directory and adds its supported note files to the discovery list. */
  async function visit(directory: string): Promise<ResultType<void, VaultDiscoveryError>> {
    const entries = await Result.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) =>
        new VaultDiscoveryError({
          path: directory,
          reason: "scan",
          cause: mapFileSystemError(directory, cause),
          message: "Could not scan the configured Hubble vault.",
        }),
    });

    if (Result.isError(entries)) return MissingFileError.is(entries.error.cause) ? Result.ok() : entries;

    for (const entry of entries.value) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        const visited = await visit(absolute);
        if (Result.isError(visited)) return visited;
      } else if (entry.isFile() && isNotePath(entry.name)) {
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
        reason: "scan",
        cause: mapFileSystemError(vault.root, cause),
        message: "Could not inspect the configured Hubble vault.",
      }),
  });

  if (Result.isError(rootStat)) return MissingFileError.is(rootStat.error.cause) ? Result.ok(files) : rootStat;

  if (!rootStat.value.isDirectory())
    return Result.err(
      new VaultDiscoveryError({
        path: vault.root,
        reason: "not-directory",
        message: "The configured Hubble vault is not a directory.",
      })
    );

  const visited = await visit(vault.root);
  if (Result.isError(visited)) return visited;

  return Result.ok(files.sort((a, b) => a.relative.localeCompare(b.relative)));
}
