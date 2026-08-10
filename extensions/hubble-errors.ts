import { type Result as ResultType, TaggedError } from "better-result";
import type { HubblePath } from "./hubble-paths.ts";

export type VaultPathReason =
  | "empty"
  | "absolute"
  | "escape"
  | "symlink-escape"
  | "not-directory"
  | "not-markdown"
  | "filesystem";

export class VaultPathError extends TaggedError("VaultPathError")<{
  input: string;
  reason: VaultPathReason;
  cause?: unknown;
  message: string;
}> {}

export type NoteValidationReason = "title" | "append" | "query";
export class NoteValidationError extends TaggedError("NoteValidationError")<{
  reason: NoteValidationReason;
  path?: string;
  title?: string;
  message: string;
}> {}

export class NoteWriteError extends TaggedError("NoteWriteError")<{
  operation: "create" | "append" | "edit";
  path: string;
  title?: string;
  cause: unknown;
  message: string;
}> {}
export type VaultOpenReason = "open" | "not-directory";
export class VaultOpenError extends TaggedError("VaultOpenError")<{
  root: string;
  reason: VaultOpenReason;
  cause?: unknown;
  message: string;
}> {}
export class NoteNotFoundError extends TaggedError("NoteNotFoundError")<{ path: string; message: string }> {}
export class NoteReadError extends TaggedError("NoteReadError")<{ path: string; cause: unknown; message: string }> {}

export type EditValidationReason = "empty" | "missing" | "duplicate" | "overlap" | "no-op";
export class EditValidationError extends TaggedError("EditValidationError")<{
  path: string;
  reason: EditValidationReason;
  message: string;
}> {}
export type DiscoveryReason = "scan" | "not-directory";
export class VaultDiscoveryError extends TaggedError("VaultDiscoveryError")<{
  path: string;
  reason: DiscoveryReason;
  cause?: unknown;
  message: string;
}> {}
export class OutputPersistenceError extends TaggedError("OutputPersistenceError")<{
  cause: unknown;
  message: string;
}> {}

export type HubbleFailure = { message: string };
export type CreateNoteError = VaultPathError | NoteValidationError | NoteWriteError;
export type CreateNoteResult = ResultType<HubblePath, CreateNoteError>;
export type VaultOpenErrorType = VaultOpenError;
export type VaultPathResult = ResultType<HubblePath, VaultPathError>;
export type NoteReadResult = ResultType<string, NoteNotFoundError | NoteReadError>;
export type AppendNoteError = NoteValidationError | NoteNotFoundError | NoteReadError | NoteWriteError;
export type EditNoteError = EditValidationError | NoteNotFoundError | NoteReadError | NoteWriteError;
export type DiscoveryError = VaultDiscoveryError;
export type VaultNoteError = VaultPathError | NoteNotFoundError | NoteReadError;

/** Converts a typed Hubble failure into the exception expected by tool callers. */
export function throwHubbleError(error: HubbleFailure): never {
  throw new Error(error.message, { cause: error });
}
