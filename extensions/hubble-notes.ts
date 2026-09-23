import { randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import * as nodeFileSystem from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Result, type Result as ResultType } from "better-result";

import {
  type CreateNoteResult,
  type DeleteNoteError,
  type DiscoveryError,
  type EditMismatchDiagnostic,
  type EditNoteError,
  EditValidationError,
  ExistingFileError,
  MissingFileError,
  mapFileSystemError,
  type MoveNoteError,
  NoteConflictError,
  NoteDeleteError,
  NoteMoveError,
  NoteNotFoundError,
  NoteReadError,
  type NoteReadResult,
  NoteValidationError,
  NoteWriteError,
  VaultDiscoveryError,
  type VaultPathError,
} from "./hubble-errors.ts";
import {
  assertNotePath,
  canonicalVaultRoot,
  HUBBLE_METADATA_DIRECTORY,
  type HubbleNoteFormat,
  type HubblePath,
  isNotePath,
  resolveVaultDirectory,
  resolveVaultPath,
  type VaultRoot,
} from "./hubble-paths.ts";

/** Open note handle operations required by creation and atomic editing. */
export interface NoteFileHandle {
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
  stat(): Promise<Stats>;
  sync(): Promise<void>;
  writeFile(data: string, encoding: "utf8"): Promise<void>;
}

/** Filesystem operations used by note storage and injectable in failure-path tests. */
export interface NoteFileSystem {
  access(path: string, mode: number): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  mkdir(path: string, options: { readonly recursive: true }): Promise<string | undefined>;
  open(path: string, flags: "wx", mode?: number): Promise<NoteFileHandle>;
  readdir(path: string, options: { readonly withFileTypes: true }): Promise<Dirent[]>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  stat(path: string): Promise<Stats>;
  unlink(path: string): Promise<void>;
}

/** One unique exact-text replacement requested for a note. */
export interface HubbleEdit {
  readonly oldText: string;
  readonly newText: string;
}

/** A vault-contained, canonical note path. */
export type NoteReference = HubblePath;

/** A vault-contained, canonical directory path. */
export type VaultDirectoryReference = HubblePath;

/** Supported notes and directories found during one safe vault scan. */
export interface VaultEntries {
  readonly notes: ReadonlyArray<NoteReference>;
  readonly directories: ReadonlyArray<VaultDirectoryReference>;
}

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

/** Makes otherwise invisible edit text inspectable while bounding error-message size. */
function visibleWhitespace(text: string): string {
  const maximumLength = 500;
  const visible = text.replaceAll(" ", "·").replaceAll("\t", "→").replaceAll("\n", "↵\n");
  return visible.length > maximumLength ? `${visible.slice(0, maximumLength)}…` : visible;
}

/** Finds a likely exact-edit region whose only differences are horizontal whitespace. */
function whitespaceMismatch(content: string, requested: string): EditMismatchDiagnostic | undefined {
  const withoutTrailingWhitespace = (text: string): string => text.replace(/[ \t]+(?=\n|$)/gu, "");
  const withCollapsedWhitespace = (text: string): string =>
    withoutTrailingWhitespace(text)
      .split("\n")
      .map((line) => line.replace(/[ \t]+/gu, " "))
      .join("\n");
  const candidates = [
    { kind: "trailing-whitespace" as const, normalize: withoutTrailingWhitespace },
    { kind: "horizontal-whitespace" as const, normalize: withCollapsedWhitespace },
  ];

  for (const candidate of candidates) {
    const normalizedContent = candidate.normalize(content);
    const normalizedRequested = candidate.normalize(requested);

    if (!normalizedRequested || (normalizedRequested === requested && normalizedContent === content)) {
      continue;
    }

    const index = normalizedContent.indexOf(normalizedRequested);

    if (index === -1) {
      continue;
    }

    const preceding = normalizedContent.slice(0, index);
    const line = preceding.split("\n").length;
    const lastNewline = preceding.lastIndexOf("\n");
    const column = index - lastNewline;
    const contentLines = content.split("\n");
    const requestedLineCount = requested.split("\n").length;
    const actual = contentLines.slice(line - 1, line - 1 + requestedLineCount).join("\n");

    return {
      kind: candidate.kind,
      line,
      column,
      requested: visibleWhitespace(requested),
      actual: visibleWhitespace(actual),
    };
  }

  return undefined;
}

/** Formats a whitespace-only mismatch so tool callers can repair exact edit text. */
function mismatchMessage(path: string, editIndex: number, mismatch: EditMismatchDiagnostic): string {
  const difference = mismatch.kind === "trailing-whitespace" ? "trailing spaces or tabs" : "horizontal spaces or tabs";
  return `Could not find an exact match for edits[${editIndex}].oldText in ${path}. A whitespace-equivalent region at line ${mismatch.line}, column ${mismatch.column} differs in ${difference}. Visible whitespace uses · for spaces, → for tabs, and ↵ for newlines.\nRequested: ${mismatch.requested}\nActual: ${mismatch.actual}`;
}

/** Validates and applies unique, non-overlapping exact-text replacements. */
export function applyExactEdits(
  content: string,
  edits: ReadonlyArray<HubbleEdit>,
  path: string
): ResultType<string, EditValidationError> {
  if (edits.length === 0) {
    return Result.err(new EditValidationError({ path, reason: "empty", message: "At least one edit is required." }));
  }

  const matches: Array<HubbleEdit & { start: number; end: number }> = [];

  for (const [index, edit] of edits.entries()) {
    if (!edit.oldText) {
      return Result.err(
        new EditValidationError({ path, reason: "empty", message: `edits[${index}].oldText must not be empty.` })
      );
    }

    const first = content.indexOf(edit.oldText);

    if (first === -1) {
      const mismatch = whitespaceMismatch(content, edit.oldText);

      return Result.err(
        mismatch
          ? new EditValidationError({
              path,
              reason: "missing",
              editIndex: index,
              mismatch,
              message: mismatchMessage(path, index, mismatch),
            })
          : new EditValidationError({
              path,
              reason: "missing",
              editIndex: index,
              message: `Could not find an exact match for edits[${index}].oldText in ${path}.`,
            })
      );
    }

    const second = content.indexOf(edit.oldText, first + 1);

    if (second !== -1) {
      return Result.err(
        new EditValidationError({
          path,
          reason: "duplicate",
          editIndex: index,
          message: `edits[${index}].oldText is not unique in ${path}.`,
        })
      );
    }

    matches.push({ ...edit, start: first, end: first + edit.oldText.length });
  }

  const sorted = [...matches].sort((a, b) => a.start - b.start);
  let previousEnd = -1;

  for (const current of sorted) {
    if (previousEnd > current.start) {
      return Result.err(
        new EditValidationError({
          path,
          reason: "overlap",
          message: "Hubble edits must be disjoint; overlapping edits are not allowed.",
        })
      );
    }

    previousEnd = current.end;
  }

  let result = content;

  for (const edit of [...sorted].reverse()) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }

  if (result === content) {
    return Result.err(new EditValidationError({ path, reason: "no-op", message: "The edits made no changes." }));
  }

  return Result.ok(result);
}

/** Maps a filesystem read failure to the appropriate public note error. */
function noteReadError(path: HubblePath, cause: unknown): NoteNotFoundError | NoteReadError {
  const filesystemError = mapFileSystemError(path.absolute, cause);

  if (MissingFileError.is(filesystemError)) {
    return new NoteNotFoundError({ path: path.relative, message: "The requested Hubble note was not found." });
  }

  return new NoteReadError({
    path: path.relative,
    cause: filesystemError,
    message: "Could not read the requested Hubble note.",
  });
}

/** Reads one validated vault file while distinguishing missing and unreadable notes. */
export async function readVaultFile(
  path: HubblePath,
  fileSystem: NoteFileSystem = nodeFileSystem
): Promise<NoteReadResult> {
  const accessible = await Result.tryPromise({
    try: () => fileSystem.access(path.absolute, constants.R_OK),
    catch: (cause) => noteReadError(path, cause),
  });

  if (Result.isError(accessible)) {
    return accessible;
  }

  const fileStat = await Result.tryPromise({
    try: () => fileSystem.stat(path.absolute),
    catch: (cause) => noteReadError(path, cause),
  });

  if (Result.isError(fileStat)) {
    return fileStat;
  }

  if (!fileStat.value.isFile()) {
    return Result.err(
      new NoteReadError({
        path: path.relative,
        cause: undefined,
        message: "The requested Hubble path is not a file.",
      })
    );
  }

  return withFileMutationQueue(path.absolute, () =>
    Result.tryPromise({
      try: () => fileSystem.readFile(path.absolute, "utf8"),
      catch: (cause) => noteReadError(path, cause),
    })
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

/** Builds the complete document written for a new Markdown or HTML note. */
export function buildNewNoteDocument(title: string, content: string, format: HubbleNoteFormat): string {
  const trimmedTitle = title.trim();
  return format === "html" ? htmlDocument(trimmedTitle, content) : `# ${trimmedTitle}\n\n${content}`;
}

/** Removes an incomplete newly created note while preserving creation and cleanup failures. */
async function removeIncompleteNote(
  absolute: string,
  relativePath: string,
  title: string,
  creationError: NoteWriteError,
  fileSystem: NoteFileSystem
): Promise<ResultType<void, NoteWriteError>> {
  const removed = await Result.tryPromise({
    try: () => fileSystem.unlink(absolute),
    catch: (cause) => mapFileSystemError(absolute, cause),
  });

  if (Result.isOk(removed) || MissingFileError.is(removed.error)) {
    return Result.ok();
  }

  return Result.err(
    new NoteWriteError({
      operation: "create",
      path: relativePath,
      title,
      cause: new AggregateError(
        [creationError, removed.error],
        "Hubble note creation failed and the incomplete note could not be removed."
      ),
      message: "Could not remove an incomplete Hubble note after creation failed.",
    })
  );
}

interface CreateNoteDestination {
  readonly filename?: string;
  readonly format: HubbleNoteFormat;
}

/** Revalidates a newly opened create target before any note content is written. */
async function revalidateOpenedCreateTarget(
  vault: VaultRoot,
  requestedPath: string,
  target: HubblePath,
  title: string,
  handle: NoteFileHandle,
  fileSystem: NoteFileSystem
): Promise<ResultType<void, NoteWriteError>> {
  const checked = await resolveVaultPath(vault, requestedPath);

  if (Result.isError(checked)) {
    return Result.err(
      new NoteWriteError({
        operation: "create",
        path: target.relative,
        title,
        cause: checked.error,
        message: "The Hubble note destination changed before it could be written.",
      })
    );
  }

  if (checked.value.absolute !== target.absolute) {
    return Result.err(
      new NoteWriteError({
        operation: "create",
        path: target.relative,
        title,
        cause: new Error(`Create target changed from ${target.absolute} to ${checked.value.absolute}.`),
        message: "The Hubble note destination changed before it could be written.",
      })
    );
  }

  const identity = await Result.tryPromise({
    try: async () => ({ opened: await handle.stat(), resolved: await fileSystem.stat(target.absolute) }),
    catch: (cause) =>
      new NoteWriteError({
        operation: "create",
        path: target.relative,
        title,
        cause: mapFileSystemError(target.absolute, cause),
        message: "Could not verify the opened Hubble note destination.",
      }),
  });

  if (Result.isError(identity)) {
    return identity;
  }

  if (
    identity.value.opened.dev !== identity.value.resolved.dev ||
    identity.value.opened.ino !== identity.value.resolved.ino
  ) {
    return Result.err(
      new NoteWriteError({
        operation: "create",
        path: target.relative,
        title,
        cause: new Error("The opened file no longer matches the resolved Hubble note destination."),
        message: "The Hubble note destination changed before it could be written.",
      })
    );
  }

  return Result.ok();
}

/** Validates an optional exact filename and resolves the document format used during creation. */
function resolveCreateNoteDestination(
  filename: string | undefined,
  format: HubbleNoteFormat | undefined
): ResultType<CreateNoteDestination, NoteValidationError> {
  if (filename === undefined) {
    return Result.ok({ format: format ?? "markdown" });
  }

  const trimmedFilename = filename.trim();

  if (!trimmedFilename) {
    return Result.err(
      new NoteValidationError({ reason: "filename", path: filename, message: "filename must not be empty." })
    );
  }

  const containsControlCharacter = [...filename].some((character) => character.charCodeAt(0) < 32);

  if (
    trimmedFilename !== filename ||
    /[\\/]/u.test(filename) ||
    containsControlCharacter ||
    basename(filename) !== filename
  ) {
    return Result.err(
      new NoteValidationError({
        reason: "filename",
        path: filename,
        message: "filename must be a single file name without path separators or surrounding whitespace.",
      })
    );
  }

  let filenameFormat: HubbleNoteFormat;
  switch (extname(filename).toLowerCase()) {
    case ".md":
      filenameFormat = "markdown";
      break;
    case ".html":
      filenameFormat = "html";
      break;
    default:
      return Result.err(
        new NoteValidationError({
          reason: "filename",
          path: filename,
          message: "filename must end in a supported Hubble note extension (.md or .html).",
        })
      );
  }

  if (format !== undefined && format !== filenameFormat) {
    return Result.err(
      new NoteValidationError({
        reason: "format",
        path: filename,
        message: "filename extension must match the requested Hubble note format.",
      })
    );
  }

  return Result.ok({ filename, format: format ?? filenameFormat });
}

/**
 * Creates a note in the requested folder without overwriting an existing file.
 * When filename is omitted, the title slug is used and collisions receive numeric suffixes.
 * An explicit filename must be a supported basename and fails on collision.
 */
export async function writeNewVaultFile(
  vault: VaultRoot,
  title: string,
  content: string,
  folder = "",
  format?: HubbleNoteFormat,
  filename?: string,
  fileSystem: NoteFileSystem = nodeFileSystem
): Promise<CreateNoteResult> {
  const trimmedTitle = title.trim();

  if (!trimmedTitle) {
    return Result.err(new NoteValidationError({ reason: "title", title, message: "title must not be empty." }));
  }

  const destination = resolveCreateNoteDestination(filename, format);

  if (Result.isError(destination)) {
    return destination;
  }

  return withFileMutationQueue(vault.root, async () => {
    const rootCreated = await Result.tryPromise({
      try: () => fileSystem.mkdir(vault.root, { recursive: true }),
      catch: (cause) =>
        new NoteWriteError({
          operation: "create",
          path: vault.root,
          title: trimmedTitle,
          cause: mapFileSystemError(vault.root, cause),
          message: "Could not create the Hubble vault directory.",
        }),
    });

    if (Result.isError(rootCreated)) {
      return rootCreated;
    }

    // Force the vault root through canonical resolution after mkdir. An empty
    // folder normally uses the root fast path, which is useful while the root
    // is missing but must not bypass revalidation before a note is opened.
    const requestedFolder = folder.trim() || ".";
    const directory = await resolveVaultDirectory(vault, requestedFolder);

    if (Result.isError(directory)) {
      return directory;
    }

    const directoryCreated = await Result.tryPromise({
      try: () => fileSystem.mkdir(directory.value.absolute, { recursive: true }),
      catch: (cause) =>
        new NoteWriteError({
          operation: "create",
          path: directory.value.relative || vault.root,
          title: trimmedTitle,
          cause: mapFileSystemError(directory.value.absolute, cause),
          message: "Could not create the Hubble note folder.",
        }),
    });

    if (Result.isError(directoryCreated)) {
      return directoryCreated;
    }

    const revalidatedDirectory = await resolveVaultDirectory(vault, requestedFolder);

    if (Result.isError(revalidatedDirectory)) {
      return revalidatedDirectory;
    }

    const safeDirectory = revalidatedDirectory.value;
    const slug = slugifyTitle(trimmedTitle);
    const extension = destination.value.format === "html" ? ".html" : ".md";
    const body = buildNewNoteDocument(trimmedTitle, content, destination.value.format);
    const maximumAttempts = destination.value.filename === undefined ? 10_000 : 1;

    for (let suffix = 0; suffix < maximumAttempts; suffix++) {
      const candidateFilename =
        destination.value.filename ?? `${slug}${suffix === 0 ? "" : `-${suffix + 1}`}${extension}`;
      const requestedPath = safeDirectory.relative
        ? `${safeDirectory.relative}/${candidateFilename}`
        : candidateFilename;
      const target = await resolveVaultPath(vault, requestedPath);

      if (Result.isError(target)) {
        return target;
      }

      const supported = assertNotePath(target.value);

      if (Result.isError(supported)) {
        return supported;
      }

      const absolute = target.value.absolute;
      const relativePath = target.value.relative;
      // The root queue allocates names; the file queue also excludes readers and editors.
      const attempt = await withFileMutationQueue(absolute, async (): Promise<CreateNoteResult> => {
        const opened = await Result.tryPromise({
          try: () => fileSystem.open(absolute, "wx"),
          catch: (cause) => {
            const filesystemError = mapFileSystemError(absolute, cause);
            return new NoteWriteError({
              operation: "create",
              path: relativePath,
              title: trimmedTitle,
              cause: filesystemError,
              message:
                destination.value.filename !== undefined && ExistingFileError.is(filesystemError)
                  ? "A Hubble note already exists at the requested filename."
                  : "Could not create the Hubble note.",
            });
          },
        });

        if (Result.isError(opened)) {
          return opened;
        }

        const handle = opened.value;
        let written: ResultType<void, NoteWriteError>;
        let closed: ResultType<void, NoteWriteError>;
        try {
          const revalidatedTarget = await revalidateOpenedCreateTarget(
            vault,
            requestedPath,
            target.value,
            trimmedTitle,
            handle,
            fileSystem
          );
          written = Result.isError(revalidatedTarget)
            ? revalidatedTarget
            : await Result.tryPromise({
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

        if (Result.isError(written)) {
          const removed = await removeIncompleteNote(absolute, relativePath, trimmedTitle, written.error, fileSystem);
          return Result.isError(removed) ? removed : written;
        }

        if (Result.isError(closed)) {
          const removed = await removeIncompleteNote(absolute, relativePath, trimmedTitle, closed.error, fileSystem);
          return Result.isError(removed) ? removed : closed;
        }

        return Result.ok(target.value);
      });

      if (
        Result.isError(attempt) &&
        destination.value.filename === undefined &&
        ExistingFileError.is(attempt.error.cause)
      ) {
        continue;
      }

      return attempt;
    }

    return Result.err(
      new NoteWriteError({
        operation: "create",
        path: safeDirectory.relative || vault.root,
        title: trimmedTitle,
        cause: new Error("filename exhaustion"),
        message: "Could not find an unused Hubble filename.",
      })
    );
  });
}

/** Raises cancellation only between filesystem operations so a held mutation queue remains held while I/O settles. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The Hubble operation was cancelled.", "AbortError");
  }
}

/** Normalizes model-supplied and note line endings before exact edit matching. */
function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Detects the line-ending style that an edited note should retain. */
function detectLineEnding(text: string): "\n" | "\r\n" {
  const firstLf = text.indexOf("\n");
  return firstLf > 0 && text[firstLf - 1] === "\r" ? "\r\n" : "\n";
}

/** Restores the original note's line-ending style after LF-normalized editing. */
function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Creates the public structured failure for one atomic edit filesystem step. */
function editWriteError(path: HubblePath, filesystemPath: string, cause: unknown, message: string): NoteWriteError {
  return new NoteWriteError({
    operation: "edit",
    path: path.relative,
    cause: mapFileSystemError(filesystemPath, cause),
    message,
  });
}

/** Removes an uncommitted edit temporary file and preserves cleanup failures alongside the original failure. */
async function cleanUpFailedEdit(
  path: HubblePath,
  temporaryPath: string,
  failure: NoteWriteError | NoteConflictError,
  fileSystem: NoteFileSystem
): Promise<NoteWriteError | NoteConflictError> {
  const removed = await Result.tryPromise({
    try: () => fileSystem.unlink(temporaryPath),
    catch: (cause) => mapFileSystemError(temporaryPath, cause),
  });

  if (Result.isOk(removed) || MissingFileError.is(removed.error)) {
    return failure;
  }

  return new NoteWriteError({
    operation: "edit",
    path: path.relative,
    cause: new AggregateError([failure, removed.error], "The Hubble edit and temporary-file cleanup both failed."),
    message: "Could not clean up a failed Hubble note edit.",
  });
}

/** Removes an uncommitted temporary file before propagating cancellation. */
async function cancelAtomicEdit(
  path: HubblePath,
  temporaryPath: string,
  signal: AbortSignal,
  fileSystem: NoteFileSystem
): Promise<never> {
  const reason = signal.reason ?? new DOMException("The Hubble edit was cancelled.", "AbortError");
  const removed = await Result.tryPromise({
    try: () => fileSystem.unlink(temporaryPath),
    catch: (cause) => mapFileSystemError(temporaryPath, cause),
  });

  if (Result.isError(removed) && !MissingFileError.is(removed.error)) {
    throw new AggregateError([reason, removed.error], `The edit of ${path.relative} was cancelled but cleanup failed.`);
  }

  throw reason;
}

interface EditSnapshot {
  readonly content: string;
  readonly metadata: Stats;
}

/** Detects external saves or replacements before committing; this is optimistic, not an interprocess lock. */
async function checkEditSnapshot(
  path: HubblePath,
  snapshot: EditSnapshot,
  fileSystem: NoteFileSystem
): Promise<ResultType<void, NoteWriteError | NoteConflictError>> {
  const current = await Result.tryPromise({
    try: async () => ({
      metadata: await fileSystem.stat(path.absolute),
      content: await fileSystem.readFile(path.absolute, "utf8"),
    }),
    catch: (cause) =>
      editWriteError(path, path.absolute, cause, "Could not verify the Hubble note before committing the edit."),
  });

  if (Result.isError(current)) {
    return current;
  }

  const before = snapshot.metadata;
  const after = current.value.metadata;

  if (
    snapshot.content !== current.value.content ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.mode !== after.mode
  ) {
    return Result.err(
      new NoteConflictError({
        path: path.relative,
        message: "The Hubble note changed while editing. Read it again before retrying.",
      })
    );
  }

  return Result.ok();
}

/**
 * Writes complete replacement content to a sibling temporary file, syncs and closes it,
 * then atomically renames it over the note. The caller must hold Pi's mutation queue.
 */
async function replaceVaultFileAtomically(
  path: HubblePath,
  content: string,
  snapshot: EditSnapshot,
  signal: AbortSignal | undefined,
  fileSystem: NoteFileSystem
): Promise<ResultType<void, NoteWriteError | NoteConflictError>> {
  throwIfAborted(signal);

  const temporaryPath = join(
    dirname(path.absolute),
    `.${basename(path.absolute)}.pi-hubble-${process.pid}-${randomUUID()}.tmp`
  );
  const opened = await Result.tryPromise({
    try: () => fileSystem.open(temporaryPath, "wx", 0o600),
    catch: (cause) => editWriteError(path, temporaryPath, cause, "Could not create a temporary Hubble edit file."),
  });

  if (Result.isError(opened)) {
    return opened;
  }

  const handle = opened.value;
  let failure: NoteWriteError | undefined;

  const written = await Result.tryPromise({
    try: () => handle.writeFile(content, "utf8"),
    catch: (cause) => editWriteError(path, temporaryPath, cause, "Could not write the temporary Hubble edit file."),
  });

  if (Result.isError(written)) {
    failure = written.error;
  }

  if (!failure) {
    const permissions = await Result.tryPromise({
      try: () => handle.chmod(snapshot.metadata.mode),
      catch: (cause) =>
        editWriteError(path, temporaryPath, cause, "Could not preserve the Hubble note permissions while editing."),
    });

    if (Result.isError(permissions)) {
      failure = permissions.error;
    }
  }

  if (!failure) {
    const synced = await Result.tryPromise({
      try: () => handle.sync(),
      catch: (cause) => editWriteError(path, temporaryPath, cause, "Could not sync the temporary Hubble edit file."),
    });

    if (Result.isError(synced)) {
      failure = synced.error;
    }
  }

  const closed = await Result.tryPromise({
    try: () => handle.close(),
    catch: (cause) => editWriteError(path, temporaryPath, cause, "Could not close the temporary Hubble edit file."),
  });

  if (Result.isError(closed)) {
    failure = failure
      ? new NoteWriteError({
          operation: "edit",
          path: path.relative,
          cause: new AggregateError([failure, closed.error], "Writing and closing the Hubble edit both failed."),
          message: "Could not finish the temporary Hubble edit file.",
        })
      : closed.error;
  }

  if (failure) {
    return Result.err(await cleanUpFailedEdit(path, temporaryPath, failure, fileSystem));
  }

  if (signal?.aborted) {
    return cancelAtomicEdit(path, temporaryPath, signal, fileSystem);
  }

  const verified = await checkEditSnapshot(path, snapshot, fileSystem);

  if (Result.isError(verified)) {
    return Result.err(await cleanUpFailedEdit(path, temporaryPath, verified.error, fileSystem));
  }

  if (signal?.aborted) {
    return cancelAtomicEdit(path, temporaryPath, signal, fileSystem);
  }

  const committed = await Result.tryPromise({
    try: () => fileSystem.rename(temporaryPath, path.absolute),
    catch: (cause) => editWriteError(path, path.absolute, cause, "Could not commit the Hubble note edit."),
  });

  if (Result.isError(committed)) {
    return Result.err(await cleanUpFailedEdit(path, temporaryPath, committed.error, fileSystem));
  }

  return Result.ok();
}

/**
 * Applies validated exact edits to an existing vault file using an atomic replacement.
 * Returns read, edit-validation, or write failures; cancellation is propagated.
 */
export async function editVaultFile(
  path: HubblePath,
  edits: ReadonlyArray<HubbleEdit>,
  signal?: AbortSignal,
  fileSystem: NoteFileSystem = nodeFileSystem
): Promise<ResultType<void, EditNoteError>> {
  return withFileMutationQueue(path.absolute, async () => {
    throwIfAborted(signal);
    const metadata = await Result.tryPromise({
      try: () => fileSystem.stat(path.absolute),
      catch: (cause) => noteReadError(path, cause),
    });

    if (Result.isError(metadata)) {
      return metadata;
    }

    const current = await Result.tryPromise({
      try: () => fileSystem.readFile(path.absolute, "utf8"),
      catch: (cause) => noteReadError(path, cause),
    });

    if (Result.isError(current)) {
      return current;
    }

    throwIfAborted(signal);

    const writable = await Result.tryPromise({
      try: () => fileSystem.access(path.absolute, constants.W_OK),
      catch: (cause) => editWriteError(path, path.absolute, cause, "The Hubble note is not writable."),
    });

    if (Result.isError(writable)) {
      return writable;
    }

    throwIfAborted(signal);

    const bom = current.value.startsWith("\uFEFF") ? "\uFEFF" : "";
    const content = bom ? current.value.slice(1) : current.value;
    const lineEnding = detectLineEnding(content);
    const normalizedContent = normalizeToLf(content);
    const normalizedEdits = edits.map((edit) => ({
      oldText: normalizeToLf(edit.oldText),
      newText: normalizeToLf(edit.newText),
    }));
    const next = applyExactEdits(normalizedContent, normalizedEdits, path.relative);

    if (Result.isError(next)) {
      return next;
    }

    throwIfAborted(signal);

    return replaceVaultFileAtomically(
      path,
      bom + restoreLineEndings(next.value, lineEnding),
      { content: current.value, metadata: metadata.value },
      signal,
      fileSystem
    );
  });
}

/** Acquires multiple Pi file queues in stable order to prevent move-to-move deadlocks. */
function withFileMutationQueues<T>(paths: ReadonlyArray<string>, operation: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const acquire = (index: number): Promise<T> => {
    const path = ordered[index];
    return path === undefined ? operation() : withFileMutationQueue(path, () => acquire(index + 1));
  };

  return acquire(0);
}

/** Re-resolves a queued mutation path and rejects replacements that changed its canonical target. */
async function revalidateMutationPath(
  vault: VaultRoot,
  path: HubblePath
): Promise<ResultType<void, VaultPathError | NoteConflictError>> {
  const checked = await resolveVaultPath(vault, path.relative);

  if (Result.isError(checked)) {
    return checked;
  }

  if (checked.value.absolute !== path.absolute) {
    return Result.err(
      new NoteConflictError({
        path: path.relative,
        message:
          "The Hubble note path changed before the mutation could be committed. Read the vault again before retrying.",
      })
    );
  }

  return Result.ok();
}

/** Removes a linked move destination after a failed or conflicted move. */
async function rollBackMoveDestination(
  source: HubblePath,
  destination: HubblePath,
  failure: NoteMoveError | NoteConflictError,
  fileSystem: NoteFileSystem
): Promise<NoteMoveError | NoteConflictError> {
  const removed = await Result.tryPromise({
    try: () => fileSystem.unlink(destination.absolute),
    catch: (cause) => mapFileSystemError(destination.absolute, cause),
  });

  if (Result.isOk(removed) || MissingFileError.is(removed.error)) {
    return failure;
  }

  return new NoteMoveError({
    source: source.relative,
    destination: destination.relative,
    cause: new AggregateError(
      [failure, removed.error],
      "The Hubble move failed and its destination could not be removed."
    ),
    message: "Could not roll back a failed Hubble note move.",
  });
}

/**
 * Moves or renames a note without overwriting an existing destination.
 * Missing destination folders are created safely. The operation holds the vault and
 * both file queues, then uses an exclusive hard link followed by source removal.
 * It returns structured path, read, conflict, or move failures.
 */
export async function moveVaultFile(
  vault: VaultRoot,
  source: HubblePath,
  destination: HubblePath,
  signal?: AbortSignal,
  fileSystem: NoteFileSystem = nodeFileSystem
): Promise<ResultType<void, MoveNoteError>> {
  return withFileMutationQueues([vault.root, source.absolute, destination.absolute], async () => {
    throwIfAborted(signal);

    const safeSource = await revalidateMutationPath(vault, source);

    if (Result.isError(safeSource)) {
      return safeSource;
    }

    const sourceMetadata = await Result.tryPromise({
      try: () => fileSystem.stat(source.absolute),
      catch: (cause) => noteReadError(source, cause),
    });

    if (Result.isError(sourceMetadata)) {
      return sourceMetadata;
    }

    if (!sourceMetadata.value.isFile()) {
      return Result.err(
        new NoteReadError({
          path: source.relative,
          cause: undefined,
          message: "The requested Hubble path is not a file.",
        })
      );
    }

    throwIfAborted(signal);

    const requestedDirectory = dirname(destination.relative);
    const destinationDirectory = await resolveVaultDirectory(vault, requestedDirectory);

    if (Result.isError(destinationDirectory)) {
      return destinationDirectory;
    }

    const directoryCreated = await Result.tryPromise({
      try: () => fileSystem.mkdir(destinationDirectory.value.absolute, { recursive: true }),
      catch: (cause) =>
        new NoteMoveError({
          source: source.relative,
          destination: destination.relative,
          cause: mapFileSystemError(destinationDirectory.value.absolute, cause),
          message: "Could not create the Hubble note move destination folder.",
        }),
    });

    if (Result.isError(directoryCreated)) {
      return directoryCreated;
    }

    const safeDirectory = await resolveVaultDirectory(vault, requestedDirectory);

    if (Result.isError(safeDirectory)) {
      return safeDirectory;
    }

    if (safeDirectory.value.absolute !== destinationDirectory.value.absolute) {
      return Result.err(
        new NoteConflictError({
          path: destination.relative,
          message: "The Hubble move destination folder changed before the note could be moved.",
        })
      );
    }

    const safeDestination = await revalidateMutationPath(vault, destination);

    if (Result.isError(safeDestination)) {
      return safeDestination;
    }

    throwIfAborted(signal);

    const linked = await Result.tryPromise({
      try: () => fileSystem.link(source.absolute, destination.absolute),
      catch: (cause) => {
        const filesystemError = mapFileSystemError(destination.absolute, cause);
        return new NoteMoveError({
          source: source.relative,
          destination: destination.relative,
          cause: filesystemError,
          message: ExistingFileError.is(filesystemError)
            ? "A Hubble note already exists at the move destination."
            : "Could not create the Hubble note move destination.",
        });
      },
    });

    if (Result.isError(linked)) {
      return linked;
    }

    const identities = await Result.tryPromise({
      try: async () => ({
        source: await fileSystem.stat(source.absolute),
        destination: await fileSystem.stat(destination.absolute),
      }),
      catch: (cause) =>
        new NoteMoveError({
          source: source.relative,
          destination: destination.relative,
          cause: mapFileSystemError(source.absolute, cause),
          message: "Could not verify the Hubble note move before removing its source.",
        }),
    });

    if (Result.isError(identities)) {
      return Result.err(await rollBackMoveDestination(source, destination, identities.error, fileSystem));
    }

    const before = sourceMetadata.value;
    const currentSource = identities.value.source;
    const currentDestination = identities.value.destination;

    if (
      before.dev !== currentSource.dev ||
      before.ino !== currentSource.ino ||
      currentSource.dev !== currentDestination.dev ||
      currentSource.ino !== currentDestination.ino
    ) {
      const conflict = new NoteConflictError({
        path: source.relative,
        message: "The Hubble note changed while it was being moved. Read the vault again before retrying.",
      });
      return Result.err(await rollBackMoveDestination(source, destination, conflict, fileSystem));
    }

    const removed = await Result.tryPromise({
      try: () => fileSystem.unlink(source.absolute),
      catch: (cause) =>
        new NoteMoveError({
          source: source.relative,
          destination: destination.relative,
          cause: mapFileSystemError(source.absolute, cause),
          message: "Could not remove the original Hubble note after linking its move destination.",
        }),
    });

    if (Result.isError(removed)) {
      return Result.err(await rollBackMoveDestination(source, destination, removed.error, fileSystem));
    }

    return Result.ok();
  });
}

/**
 * Deletes one safely resolved note while holding its Pi queue.
 * Returns structured path, read, conflict, or delete failures.
 */
export async function deleteVaultFile(
  vault: VaultRoot,
  path: HubblePath,
  signal?: AbortSignal,
  fileSystem: NoteFileSystem = nodeFileSystem
): Promise<ResultType<void, DeleteNoteError>> {
  return withFileMutationQueue(path.absolute, async () => {
    throwIfAborted(signal);

    const safePath = await revalidateMutationPath(vault, path);

    if (Result.isError(safePath)) {
      return safePath;
    }

    const metadata = await Result.tryPromise({
      try: () => fileSystem.stat(path.absolute),
      catch: (cause) => noteReadError(path, cause),
    });

    if (Result.isError(metadata)) {
      return metadata;
    }

    if (!metadata.value.isFile()) {
      return Result.err(
        new NoteReadError({
          path: path.relative,
          cause: undefined,
          message: "The requested Hubble path is not a file.",
        })
      );
    }

    throwIfAborted(signal);

    const rechecked = await revalidateMutationPath(vault, path);

    if (Result.isError(rechecked)) {
      return rechecked;
    }

    return Result.tryPromise({
      try: () => fileSystem.unlink(path.absolute),
      catch: (cause) =>
        new NoteDeleteError({
          path: path.relative,
          cause: mapFileSystemError(path.absolute, cause),
          message: "Could not delete the Hubble note.",
        }),
    });
  });
}

/** Revalidates a directory before discovery, rejecting a root or child replaced by a symlink. */
async function checkDiscoveryDirectory(directory: string): Promise<ResultType<void, VaultDiscoveryError>> {
  const checked = await canonicalVaultRoot(directory);

  if (Result.isError(checked)) {
    return Result.err(
      new VaultDiscoveryError({
        path: directory,
        reason: "unsafe-path",
        cause: checked.error,
        message: "Could not safely resolve the Hubble discovery directory.",
      })
    );
  }

  if (checked.value !== directory) {
    return Result.err(
      new VaultDiscoveryError({
        path: directory,
        reason: "unsafe-path",
        message: "The Hubble discovery directory was replaced by a symlink.",
      })
    );
  }

  return Result.ok();
}

/** Recursively discovers supported Hubble notes and directories within an optional resolved scope. */
export async function discoverVaultEntries(
  vault: VaultRoot,
  fileSystem: NoteFileSystem = nodeFileSystem,
  signal?: AbortSignal,
  scope?: HubblePath
): Promise<ResultType<VaultEntries, DiscoveryError>> {
  throwIfAborted(signal);

  const notes: NoteReference[] = [];
  const directories: VaultDirectoryReference[] = [];

  /** Walks one vault directory and adds its safe children to the discovery result. */
  async function visit(directory: string): Promise<ResultType<void, VaultDiscoveryError>> {
    throwIfAborted(signal);
    const checked = await checkDiscoveryDirectory(directory);

    if (Result.isError(checked)) {
      return checked;
    }

    const entries = await Result.tryPromise({
      try: () => fileSystem.readdir(directory, { withFileTypes: true }),
      catch: (cause) =>
        new VaultDiscoveryError({
          path: directory,
          reason: "scan",
          cause: mapFileSystemError(directory, cause),
          message: "Could not scan the configured Hubble vault.",
        }),
    });

    if (Result.isError(entries)) {
      return MissingFileError.is(entries.error.cause) ? Result.ok() : entries;
    }

    for (const entry of entries.value) {
      throwIfAborted(signal);

      if (
        entry.isSymbolicLink() ||
        (directory === vault.root && entry.isDirectory() && entry.name.toLowerCase() === HUBBLE_METADATA_DIRECTORY)
      ) {
        continue;
      }

      const absolute = join(directory, entry.name);
      const relativePath = relative(vault.root, absolute);

      if (entry.isDirectory()) {
        const checkedDirectory = await resolveVaultDirectory(vault, relativePath);

        if (Result.isError(checkedDirectory)) {
          return Result.err(
            new VaultDiscoveryError({
              path: absolute,
              reason: "unsafe-path",
              cause: checkedDirectory.error,
              message: "A Hubble directory changed during discovery.",
            })
          );
        }

        // Ignore entries replaced by an internal symlink after readdir.
        if (checkedDirectory.value.absolute !== absolute) {
          continue;
        }

        directories.push(checkedDirectory.value);
        const visited = await visit(absolute);

        if (Result.isError(visited)) {
          return visited;
        }
      } else if (entry.isFile() && isNotePath(entry.name)) {
        const checkedNote = await resolveVaultPath(vault, relativePath);

        if (Result.isError(checkedNote)) {
          return Result.err(
            new VaultDiscoveryError({
              path: absolute,
              reason: "unsafe-path",
              cause: checkedNote.error,
              message: "A Hubble note changed during discovery.",
            })
          );
        }

        // Ignore entries replaced by an internal symlink after readdir.
        if (checkedNote.value.absolute === absolute) {
          notes.push(checkedNote.value);
        }
      }
    }

    return Result.ok();
  }

  const discoveryRoot = scope?.absolute ?? vault.root;
  const checkedRoot = await checkDiscoveryDirectory(discoveryRoot);

  if (Result.isError(checkedRoot)) {
    return checkedRoot;
  }

  const rootStat = await Result.tryPromise({
    try: () => fileSystem.stat(discoveryRoot),
    catch: (cause) =>
      new VaultDiscoveryError({
        path: discoveryRoot,
        reason: "scan",
        cause: mapFileSystemError(discoveryRoot, cause),
        message: "Could not inspect the requested Hubble discovery scope.",
      }),
  });

  if (Result.isError(rootStat)) {
    if (!MissingFileError.is(rootStat.error.cause)) {
      return rootStat;
    }

    return scope === undefined
      ? Result.ok({ notes, directories })
      : Result.err(
          new VaultDiscoveryError({
            path: discoveryRoot,
            reason: "scan",
            cause: rootStat.error.cause,
            message: "The requested Hubble folder does not exist.",
          })
        );
  }

  if (!rootStat.value.isDirectory()) {
    return Result.err(
      new VaultDiscoveryError({
        path: discoveryRoot,
        reason: "not-directory",
        message: "The requested Hubble discovery scope is not a directory.",
      })
    );
  }

  const visited = await visit(discoveryRoot);

  if (Result.isError(visited)) {
    return visited;
  }

  return Result.ok({
    notes: notes.sort((a, b) => a.relative.localeCompare(b.relative)),
    directories: directories.sort((a, b) => a.relative.localeCompare(b.relative)),
  });
}

/** Recursively lists supported Hubble notes while ignoring symlinks. */
export async function listNoteFiles(
  vault: VaultRoot,
  fileSystem: NoteFileSystem = nodeFileSystem,
  signal?: AbortSignal
): Promise<ResultType<NoteReference[], DiscoveryError>> {
  const entries = await discoverVaultEntries(vault, fileSystem, signal);
  return Result.isError(entries) ? entries : Result.ok([...entries.value.notes]);
}
