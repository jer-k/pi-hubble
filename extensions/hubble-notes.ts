import { randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import * as nodeFileSystem from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Result, type Result as ResultType } from "better-result";

import {
  type CreateNoteResult,
  type DiscoveryError,
  type EditNoteError,
  EditValidationError,
  ExistingFileError,
  MissingFileError,
  mapFileSystemError,
  NoteNotFoundError,
  NoteReadError,
  type NoteReadResult,
  NoteValidationError,
  NoteWriteError,
  VaultDiscoveryError,
} from "./hubble-errors.ts";
import {
  assertNotePath,
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
  sync(): Promise<void>;
  writeFile(data: string, encoding: "utf8"): Promise<void>;
}

/** Filesystem operations used by note storage and injectable in failure-path tests. */
export interface NoteFileSystem {
  access(path: string, mode: number): Promise<void>;
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
export function applyExactEdits(
  content: string,
  edits: ReadonlyArray<HubbleEdit>,
  path: string
): ResultType<string, EditValidationError> {
  if (edits.length === 0)
    return Result.err(new EditValidationError({ path, reason: "empty", message: "At least one edit is required." }));

  const matches: Array<HubbleEdit & { start: number; end: number }> = [];
  for (const [index, edit] of edits.entries()) {
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
    const second = content.indexOf(edit.oldText, first + 1);
    if (second !== -1) {
      return Result.err(
        new EditValidationError({ path, reason: "duplicate", message: "An edit's oldText is not unique." })
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
  for (const edit of [...sorted].reverse())
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  if (result === content)
    return Result.err(new EditValidationError({ path, reason: "no-op", message: "The edits made no changes." }));
  return Result.ok(result);
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
export async function readVaultFile(
  path: HubblePath,
  fileSystem: NoteFileSystem = nodeFileSystem
): Promise<NoteReadResult> {
  const accessible = await Result.tryPromise({
    try: () => fileSystem.access(path.absolute, constants.R_OK),
    catch: (cause) => noteReadError(path, cause),
  });
  if (Result.isError(accessible)) return accessible;
  const fileStat = await Result.tryPromise({
    try: () => fileSystem.stat(path.absolute),
    catch: (cause) => noteReadError(path, cause),
  });
  if (Result.isError(fileStat)) return fileStat;
  if (!fileStat.value.isFile())
    return Result.err(
      new NoteReadError({ path: path.relative, cause: undefined, message: "The requested Hubble path is not a file." })
    );
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
  if (Result.isOk(removed) || MissingFileError.is(removed.error)) return Result.ok();

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

/** Validates an optional exact filename and resolves the document format used during creation. */
function resolveCreateNoteDestination(
  filename: string | undefined,
  format: HubbleNoteFormat | undefined
): ResultType<CreateNoteDestination, NoteValidationError> {
  if (filename === undefined) return Result.ok({ format: format ?? "markdown" });

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
  if (!trimmedTitle)
    return Result.err(new NoteValidationError({ reason: "title", title, message: "title must not be empty." }));

  const destination = resolveCreateNoteDestination(filename, format);
  if (Result.isError(destination)) return destination;

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

    if (Result.isError(rootCreated)) return rootCreated;

    // Force the vault root through canonical resolution after mkdir. An empty
    // folder normally uses the root fast path, which is useful while the root
    // is missing but must not bypass revalidation before a note is opened.
    const directory = await resolveVaultDirectory(vault, folder.trim() || ".");
    if (Result.isError(directory)) return directory;

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
    if (Result.isError(directoryCreated)) return directoryCreated;

    const slug = slugifyTitle(trimmedTitle);
    const extension = destination.value.format === "html" ? ".html" : ".md";
    const body = buildNewNoteDocument(trimmedTitle, content, destination.value.format);
    const maximumAttempts = destination.value.filename === undefined ? 10_000 : 1;
    for (let suffix = 0; suffix < maximumAttempts; suffix++) {
      const candidateFilename =
        destination.value.filename ?? `${slug}${suffix === 0 ? "" : `-${suffix + 1}`}${extension}`;
      const requestedPath = directory.value.relative
        ? `${directory.value.relative}/${candidateFilename}`
        : candidateFilename;
      const target = await resolveVaultPath(vault, requestedPath);
      if (Result.isError(target)) return target;
      const supported = assertNotePath(target.value);
      if (Result.isError(supported)) return supported;

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
      )
        continue;
      return attempt;
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

/** Raises cancellation only between filesystem operations so the mutation queue remains held while I/O settles. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The Hubble edit was cancelled.", "AbortError");
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
  failure: NoteWriteError,
  fileSystem: NoteFileSystem
): Promise<NoteWriteError> {
  const removed = await Result.tryPromise({
    try: () => fileSystem.unlink(temporaryPath),
    catch: (cause) => mapFileSystemError(temporaryPath, cause),
  });
  if (Result.isOk(removed) || MissingFileError.is(removed.error)) return failure;

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

/**
 * Writes complete replacement content to a sibling temporary file, syncs and closes it,
 * then atomically renames it over the note. The caller must hold Pi's mutation queue.
 */
async function replaceVaultFileAtomically(
  path: HubblePath,
  content: string,
  signal: AbortSignal | undefined,
  fileSystem: NoteFileSystem
): Promise<ResultType<void, NoteWriteError>> {
  throwIfAborted(signal);

  const metadata = await Result.tryPromise({
    try: () => fileSystem.stat(path.absolute),
    catch: (cause) => editWriteError(path, path.absolute, cause, "Could not inspect the Hubble note before editing."),
  });
  if (Result.isError(metadata)) return metadata;

  const temporaryPath = join(
    dirname(path.absolute),
    `.${basename(path.absolute)}.pi-hubble-${process.pid}-${randomUUID()}.tmp`
  );
  const opened = await Result.tryPromise({
    try: () => fileSystem.open(temporaryPath, "wx", 0o600),
    catch: (cause) => editWriteError(path, temporaryPath, cause, "Could not create a temporary Hubble edit file."),
  });
  if (Result.isError(opened)) return opened;

  const handle = opened.value;
  let failure: NoteWriteError | undefined;

  const written = await Result.tryPromise({
    try: () => handle.writeFile(content, "utf8"),
    catch: (cause) => editWriteError(path, temporaryPath, cause, "Could not write the temporary Hubble edit file."),
  });
  if (Result.isError(written)) failure = written.error;

  if (!failure) {
    const permissions = await Result.tryPromise({
      try: () => handle.chmod(metadata.value.mode),
      catch: (cause) =>
        editWriteError(path, temporaryPath, cause, "Could not preserve the Hubble note permissions while editing."),
    });
    if (Result.isError(permissions)) failure = permissions.error;
  }

  if (!failure) {
    const synced = await Result.tryPromise({
      try: () => handle.sync(),
      catch: (cause) => editWriteError(path, temporaryPath, cause, "Could not sync the temporary Hubble edit file."),
    });
    if (Result.isError(synced)) failure = synced.error;
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

  if (failure) return Result.err(await cleanUpFailedEdit(path, temporaryPath, failure, fileSystem));
  if (signal?.aborted) return cancelAtomicEdit(path, temporaryPath, signal, fileSystem);

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
    const current = await Result.tryPromise({
      try: () => fileSystem.readFile(path.absolute, "utf8"),
      catch: (cause) => noteReadError(path, cause),
    });
    if (Result.isError(current)) return current;
    throwIfAborted(signal);

    const writable = await Result.tryPromise({
      try: () => fileSystem.access(path.absolute, constants.W_OK),
      catch: (cause) => editWriteError(path, path.absolute, cause, "The Hubble note is not writable."),
    });
    if (Result.isError(writable)) return writable;
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
    if (Result.isError(next)) return next;
    throwIfAborted(signal);

    return replaceVaultFileAtomically(path, bom + restoreLineEndings(next.value, lineEnding), signal, fileSystem);
  });
}

/** Constructs a contained note reference discovered by the symlink-ignoring vault walk. */
function discoveredNoteReference(vault: VaultRoot, absolute: string): NoteReference {
  const relativePath = relative(vault.root, absolute).split(sep).join("/");
  // SAFETY: listNoteFiles starts at the nominal canonical vault root, descends only real directories, and ignores
  // symbolic links. The discovered absolute path therefore remains inside the vault.
  return { absolute, relative: relativePath } as NoteReference;
}

/** Recursively discovers supported Hubble notes while ignoring symlinks. */
export async function listNoteFiles(
  vault: VaultRoot,
  fileSystem: NoteFileSystem = nodeFileSystem
): Promise<ResultType<NoteReference[], DiscoveryError>> {
  const files: NoteReference[] = [];
  /** Walks one vault directory and adds its supported note files to the discovery list. */
  async function visit(directory: string): Promise<ResultType<void, VaultDiscoveryError>> {
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

    if (Result.isError(entries)) return MissingFileError.is(entries.error.cause) ? Result.ok() : entries;

    for (const entry of entries.value) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        const visited = await visit(absolute);
        if (Result.isError(visited)) return visited;
      } else if (entry.isFile() && isNotePath(entry.name)) {
        files.push(discoveredNoteReference(vault, absolute));
      }
    }

    return Result.ok();
  }

  const rootStat = await Result.tryPromise({
    try: () => fileSystem.stat(vault.root),
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
