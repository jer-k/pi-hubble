import { type Result as ResultType, TaggedError } from "better-result";
import type { HubblePath } from "./hubble-types.ts";

export type VaultPathReason = "empty" | "absolute" | "escape" | "symlink-escape" | "not-directory" | "filesystem";

export class VaultPathError extends TaggedError("VaultPathError")<{
  input: string;
  reason: VaultPathReason;
  cause?: unknown;
  message: string;
}> {}

export class NoteTitleError extends TaggedError("NoteTitleError")<{
  title: string;
  message: string;
}> {}

export class NoteWriteError extends TaggedError("NoteWriteError")<{
  operation: "create" | "append" | "edit";
  path: string;
  title?: string;
  cause: unknown;
  message: string;
}> {}

export class VaultOpenError extends TaggedError("VaultOpenError")<{
  root: string;
  cause: unknown;
  message: string;
}> {}

export class VaultRootTypeError extends TaggedError("VaultRootTypeError")<{
  root: string;
  message: string;
}> {}

export class InvalidMarkdownPathError extends TaggedError("InvalidMarkdownPathError")<{
  path: string;
  message: string;
}> {}

export class NoteNotFoundError extends TaggedError("NoteNotFoundError")<{
  path: string;
  message: string;
}> {}

export class NoteReadError extends TaggedError("NoteReadError")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export class NoteAppendValidationError extends TaggedError("NoteAppendValidationError")<{
  path: string;
  message: string;
}> {}

export type EditValidationReason = "empty" | "missing" | "duplicate" | "overlap" | "no-op";

export class EditValidationError extends TaggedError("EditValidationError")<{
  path: string;
  reason: EditValidationReason;
  message: string;
}> {}

export class VaultDiscoveryError extends TaggedError("VaultDiscoveryError")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export class OutputPersistenceError extends TaggedError("OutputPersistenceError")<{
  cause: unknown;
  message: string;
}> {}

export type CreateNoteError = VaultPathError | NoteTitleError | NoteWriteError;
export type CreateNoteResult = ResultType<HubblePath, CreateNoteError>;
export type VaultOpenErrorType = VaultOpenError | VaultRootTypeError;
export type VaultPathResult = ResultType<HubblePath, VaultPathError>;
export type NoteReadResult = ResultType<string, NoteNotFoundError | NoteReadError>;
export type AppendNoteError = NoteAppendValidationError | NoteNotFoundError | NoteReadError | NoteWriteError;
export type EditNoteError = EditValidationError | NoteNotFoundError | NoteReadError | NoteWriteError;
export type DiscoveryError = VaultDiscoveryError | VaultRootTypeError;
