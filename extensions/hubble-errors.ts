import { type Result as ResultType, TaggedError } from "better-result";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { HubblePath } from "./hubble-paths.ts";

/** Filesystem conditions that Hubble callers can recover from directly. */
export type FileSystemFailure = MissingFileError | ExistingFileError;

/** A filesystem operation failed because its target did not exist. */
export class MissingFileError extends TaggedError("MissingFileError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A filesystem creation failed because its target already existed. */
export class ExistingFileError extends TaggedError("ExistingFileError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

const SystemError = Type.Object({ code: Type.String() }, { additionalProperties: true });

/** Reads the recoverable Node error codes used by Hubble. */
function systemErrorCode(cause: unknown): "ENOENT" | "EEXIST" | undefined {
  if (!Value.Check(SystemError, cause)) {
    return undefined;
  }

  if (cause.code === "ENOENT") {
    return "ENOENT";
  }

  if (cause.code === "EEXIST") {
    return "EEXIST";
  }

  return undefined;
}

/** Maps the filesystem failures that callers need to recover from. */
export function mapFileSystemError<T>(path: string, cause: T): FileSystemFailure | T {
  switch (systemErrorCode(cause)) {
    case "ENOENT":
      return new MissingFileError({ path, cause, message: "The requested filesystem path does not exist." });
    case "EEXIST":
      return new ExistingFileError({ path, cause, message: "The requested filesystem path already exists." });
    default:
      return cause;
  }
}

/** Stable classifications for unsafe or invalid vault paths. */
export type VaultPathReason =
  | "empty"
  | "absolute"
  | "escape"
  | "symlink-escape"
  | "not-directory"
  | "invalid-reference"
  | "reserved"
  | "unsupported-note-format"
  | "filesystem";

/** A user-supplied vault path could not be resolved safely. */
export class VaultPathError extends TaggedError("VaultPathError")<{
  readonly input: string;
  readonly reason: VaultPathReason;
  readonly cause?: unknown;
  readonly message: string;
}> {}

/** Stable classifications for invalid note input. */
export type NoteValidationReason = "title" | "query" | "filename" | "format" | "pagination" | "destination";
/** Note input could not be parsed into a valid creation, search, pagination, or move request. */
export class NoteValidationError extends TaggedError("NoteValidationError")<{
  readonly reason: NoteValidationReason;
  readonly path?: string;
  readonly title?: string;
  readonly message: string;
}> {}

/** A note creation or atomic edit filesystem operation failed. */
export class NoteWriteError extends TaggedError("NoteWriteError")<{
  readonly operation: "create" | "edit";
  readonly path: string;
  readonly title?: string;
  readonly cause: unknown;
  readonly message: string;
}> {}
/** Stable classifications for vault-open failures. */
export type VaultOpenReason = "open" | "not-directory";
/** A configured vault root could not be opened as a directory. */
export class VaultOpenError extends TaggedError("VaultOpenError")<{
  readonly root: string;
  readonly reason: VaultOpenReason;
  readonly cause?: unknown;
  readonly message: string;
}> {}
/** A requested note does not exist in the vault. */
export class NoteNotFoundError extends TaggedError("NoteNotFoundError")<{
  readonly path: string;
  readonly message: string;
}> {}
/** An existing note could not be read as a regular UTF-8 file. */
export class NoteReadError extends TaggedError("NoteReadError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A note move failed while linking its new path or removing its old path. */
export class NoteMoveError extends TaggedError("NoteMoveError")<{
  readonly source: string;
  readonly destination: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A note deletion failed after its path was safely resolved. */
export class NoteDeleteError extends TaggedError("NoteDeleteError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A note changed outside Pi while a mutation was being prepared; reread before retrying. */
export class NoteConflictError extends TaggedError("NoteConflictError")<{
  readonly path: string;
  readonly message: string;
}> {}

/** Visible context for an exact-edit failure caused only by horizontal whitespace. */
export interface EditMismatchDiagnostic {
  readonly kind: "trailing-whitespace" | "horizontal-whitespace";
  readonly line: number;
  readonly column: number;
  readonly requested: string;
  readonly actual: string;
}

/** Stable classifications for invalid exact-text edit sets. */
export type EditValidationReason = "empty" | "missing" | "duplicate" | "overlap" | "no-op";
/** Exact-text edits were empty, ambiguous, overlapping, missing, or ineffective. */
export class EditValidationError extends TaggedError("EditValidationError")<{
  readonly path: string;
  readonly reason: EditValidationReason;
  readonly editIndex?: number;
  readonly mismatch?: EditMismatchDiagnostic;
  readonly message: string;
}> {}
/** Stable classifications for vault discovery failures. */
export type DiscoveryReason = "scan" | "not-directory" | "unsafe-path";
/** Supported notes could not be discovered beneath the vault root. */
export class VaultDiscoveryError extends TaggedError("VaultDiscoveryError")<{
  readonly path: string;
  readonly reason: DiscoveryReason;
  readonly cause?: unknown;
  readonly message: string;
}> {}
/** Truncated tool output could not be persisted outside model context. */
export class OutputPersistenceError extends TaggedError("OutputPersistenceError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Minimal failure shape accepted by Pi integration boundaries. */
export type HubbleFailure = { readonly message: string };
/** Expected path, input, and storage failures from note creation. */
export type CreateNoteError = VaultPathError | NoteValidationError | NoteWriteError;
/** Result of creating a vault-contained note. */
export type CreateNoteResult = ResultType<HubblePath, CreateNoteError>;
/** Public alias for vault-open failures. */
export type VaultOpenErrorType = VaultOpenError;
/** Result of resolving a user-supplied vault path. */
export type VaultPathResult = ResultType<HubblePath, VaultPathError>;
/** Result of reading one validated note file. */
export type NoteReadResult = ResultType<string, NoteNotFoundError | NoteReadError>;
/** Expected validation, read, and storage failures from note editing. */
export type EditNoteError =
  | EditValidationError
  | NoteNotFoundError
  | NoteReadError
  | NoteWriteError
  | NoteConflictError;
/** Expected validation, path, conflict, and storage failures from moving a note. */
export type MoveNoteError =
  | VaultPathError
  | NoteValidationError
  | NoteNotFoundError
  | NoteReadError
  | NoteMoveError
  | NoteConflictError;
/** Expected path, read, conflict, and storage failures from deleting a note. */
export type DeleteNoteError = VaultPathError | NoteNotFoundError | NoteReadError | NoteDeleteError | NoteConflictError;
/** Expected failure while discovering notes in a vault. */
export type DiscoveryError = VaultDiscoveryError;
/** Expected path and read failures from a high-level note operation. */
export type VaultNoteError = VaultPathError | NoteNotFoundError | NoteReadError;

/** Converts a typed Hubble failure into the exception expected by tool callers. */
export function throwHubbleError(error: HubbleFailure): never {
  throw new Error(error.message, { cause: error });
}

/** A recoverable CLI, Git, filesystem, or upstream-content failure while syncing vendored skills. */
export class SkillSyncError extends TaggedError("SkillSyncError")<{
  readonly reason: "arguments" | "git" | "filesystem" | "upstream-entry" | "different" | "rollback";
  readonly path?: string;
  readonly cause?: unknown;
  readonly message: string;
}> {}
