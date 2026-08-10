import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Result, type Result as ResultType, TaggedError } from "better-result";
import type { ConfigError } from "./hubble-config.ts";
import type {
  AppendNoteError,
  CreateNoteError,
  DiscoveryError,
  EditNoteError,
  InvalidMarkdownPathError,
  NoteNotFoundError,
  NoteReadError,
  OutputPersistenceError,
  VaultOpenErrorType,
  VaultPathError,
} from "./hubble-errors.ts";
import { openVault } from "./hubble-paths.ts";
import type { HubbleVault } from "./hubble-types.ts";

export type RootContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;
export type RootResult = ResultType<string, ConfigError>;
export type HubbleError =
  | ConfigError
  | VaultOpenErrorType
  | CreateNoteError
  | VaultPathError
  | InvalidMarkdownPathError
  | NoteReadError
  | NoteNotFoundError
  | AppendNoteError
  | EditNoteError
  | DiscoveryError
  | OutputPersistenceError
  | SearchQueryError;
export type GetRoot = (context: RootContext) => Promise<RootResult>;

export class SearchQueryError extends TaggedError("SearchQueryError")<{
  message: string;
}> {}

export async function getVault(getRoot: GetRoot, context: RootContext): Promise<ResultType<HubbleVault, HubbleError>> {
  const root = await getRoot(context);
  if (Result.isError(root)) return root;
  return openVault(root.value);
}

export function noteResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function unhandledVariant(value: never): never {
  throw new Error(`Unhandled Hubble error variant: ${String(value)}`);
}

export function errorMessage(error: HubbleError): string {
  switch (error._tag) {
    case "ConfigReadError":
      return "Could not read the Hubble configuration. Check its permissions and try again.";
    case "ConfigParseError":
      return "Could not parse the Hubble configuration. Check that it contains valid JSON.";
    case "InvalidConfigError":
      return error.path === "--hubble-dir"
        ? "--hubble-dir requires a non-empty path."
        : 'The Hubble configuration is invalid. Its "root" value must be a non-empty string.';
    case "VaultNotConfiguredError":
      return "Hubble vault is not configured. Set a Hubble root or pass --hubble-dir /path/to/vault.";
    case "VaultOpenError":
      return "Could not open the configured Hubble vault.";
    case "VaultRootTypeError":
      return "The configured Hubble vault is not a directory.";
    case "VaultPathError": {
      const reason = error.reason;
      switch (reason) {
        case "empty":
          return "Hubble path must not be empty.";
        case "absolute":
          return "Hubble paths must be relative to the vault.";
        case "escape":
          return "Hubble path escapes the vault.";
        case "symlink-escape":
          return "Hubble path escapes the vault through a symlink.";
        case "not-directory":
          return "The requested Hubble folder is not a directory.";
        case "filesystem":
          return "Could not resolve the requested Hubble path.";
      }
      return unhandledVariant(reason);
    }
    case "NoteTitleError":
      return "title must not be empty.";
    case "InvalidMarkdownPathError":
      return "Hubble document must be a Markdown file.";
    case "NoteNotFoundError":
      return "The requested Hubble note was not found.";
    case "NoteReadError":
      return "Could not read the requested Hubble note.";
    case "NoteAppendValidationError":
      return "content must not be empty.";
    case "EditValidationError": {
      const reason = error.reason;
      switch (reason) {
        case "empty":
          return "At least one edit with non-empty oldText is required.";
        case "missing":
          return "Could not find an exact edit match in the requested Hubble note.";
        case "duplicate":
          return "An edit's oldText is not unique in the requested Hubble note.";
        case "overlap":
          return "Hubble edits must use disjoint exact replacements.";
        case "no-op":
          return "The Hubble edits made no changes.";
      }
      return unhandledVariant(reason);
    }
    case "NoteWriteError": {
      const operation = error.operation;
      switch (operation) {
        case "create":
          return "Could not create the Hubble note.";
        case "append":
          return "Could not append to the Hubble note.";
        case "edit":
          return "Could not edit the Hubble note.";
      }
      return unhandledVariant(operation);
    }
    case "VaultDiscoveryError":
      return "Could not scan the configured Hubble vault.";
    case "OutputPersistenceError":
      return "Could not persist the full Hubble tool output.";
    case "SearchQueryError":
      return "query must not be empty.";
  }
}

export function throwHubbleError(error: HubbleError): never {
  throw new Error(errorMessage(error), { cause: error });
}

export function unwrapToolResult<T, E extends HubbleError>(result: ResultType<T, E>): T {
  if (Result.isError(result)) throwHubbleError(result.error);
  return result.value;
}

export async function getToolVault(getRoot: GetRoot, context: RootContext): Promise<HubbleVault> {
  return unwrapToolResult(await getVault(getRoot, context));
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The Hubble operation was cancelled.", "AbortError");
}

export function throwCreateToolError(error: CreateNoteError): never {
  throwHubbleError(error);
}

export function attachmentValue(path: string): string {
  if (path.includes(" ") || path.includes('"')) return `@"${path.replaceAll('"', '\\"')}"`;
  return `@${path}`;
}
