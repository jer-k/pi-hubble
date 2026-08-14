import { Result, type Result as ResultType } from "better-result";
import {
  type AppendNoteError,
  type CreateNoteError,
  type DiscoveryError,
  type EditNoteError,
  NoteValidationError,
  type VaultNoteError,
  type VaultOpenErrorType,
} from "./hubble-errors.ts";
import {
  appendToVaultFile,
  editVaultFile,
  type HubbleEdit,
  listNoteFiles,
  type NoteReference,
  readVaultFile,
  writeNewVaultFile,
} from "./hubble-notes.ts";
import {
  assertNotePath,
  canonicalVaultRoot,
  type HubbleNoteFormat,
  noteFormat,
  resolveVaultPath,
  type VaultRoot,
} from "./hubble-paths.ts";

export type { HubbleEdit, NoteReference } from "./hubble-notes.ts";

export interface ReadNote {
  note: NoteReference;
  content: string;
}

export interface NoteSearchMatch {
  line: number;
  text: string;
}

export interface NoteSearchResult {
  note: NoteReference;
  matches: NoteSearchMatch[];
}

export type VaultReadResult = ResultType<ReadNote, VaultNoteError>;
export type VaultSearchResult = ResultType<NoteSearchResult[], DiscoveryError | VaultNoteError | NoteValidationError>;
export type VaultCreateResult = ResultType<NoteReference, CreateNoteError>;
export type VaultEditResult = ResultType<NoteReference, EditNoteError | VaultNoteError>;
export type VaultAppendResult = ResultType<NoteReference, AppendNoteError | VaultNoteError>;
export type VaultListResult = ResultType<NoteReference[], DiscoveryError>;

/**
 * The high-level Hubble seam. Path security, note-format validation, and
 * storage are deliberately hidden behind this small constructed interface.
 */
export class Vault implements VaultRoot {
  readonly root: string;

  /** Creates a Vault around an already canonicalized root. */
  private constructor(root: string) {
    this.root = root;
  }

  /** Opens and canonicalizes a vault root before exposing vault operations. */
  static async open(root: string): Promise<ResultType<Vault, VaultOpenErrorType>> {
    const resolved = await canonicalVaultRoot(root);
    return Result.isError(resolved) ? resolved : Result.ok(new Vault(resolved.value));
  }

  /** Lists all supported notes currently stored in the vault. */
  async list(): Promise<VaultListResult> {
    return listNoteFiles(this);
  }

  /** Searches every supported note's raw text for case-insensitive line matches. */
  async search(query: string, signal?: AbortSignal): Promise<VaultSearchResult> {
    const normalized = query.trim().toLowerCase();
    if (!normalized)
      return Result.err(new NoteValidationError({ reason: "query", message: "query must not be empty." }));

    const files = await this.list();
    if (Result.isError(files)) return files;

    const results: NoteSearchResult[] = [];
    for (const note of files.value) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("The Hubble operation was cancelled.", "AbortError");

      const content = await this.read(note.relative);
      if (Result.isError(content)) return content;

      const matches: NoteSearchMatch[] = [];
      for (const [index, line] of content.value.content.split("\n").entries()) {
        if (line.toLowerCase().includes(normalized)) matches.push({ line: index + 1, text: line });
      }
      if (matches.length > 0) results.push({ note: content.value.note, matches });
    }

    return Result.ok(results);
  }

  /** Resolves, validates, and reads one supported note from the vault. */
  async read(path: string): Promise<VaultReadResult> {
    const resolved = await resolveVaultPath(this, path);
    if (Result.isError(resolved)) return resolved;

    const supported = assertNotePath(resolved.value);
    if (Result.isError(supported)) return supported;

    const content = await readVaultFile(resolved.value);
    if (Result.isError(content)) return content;

    return Result.ok({ note: resolved.value, content: content.value });
  }

  /** Creates a uniquely named note, defaulting to Markdown, in the requested folder. */
  async create(
    title: string,
    content: string,
    folder = "",
    format: HubbleNoteFormat = "markdown"
  ): Promise<VaultCreateResult> {
    return writeNewVaultFile(this, title, content, folder, format);
  }

  /** Applies exact-text edits to one validated supported note. */
  async edit(path: string, edits: HubbleEdit[]): Promise<VaultEditResult> {
    const resolved = await resolveVaultPath(this, path);
    if (Result.isError(resolved)) return resolved;

    const supported = assertNotePath(resolved.value);
    if (Result.isError(supported)) return supported;

    const edited = await editVaultFile(resolved.value, edits);
    if (Result.isError(edited)) return edited;

    return Result.ok(resolved.value);
  }

  /** Appends Markdown to a Markdown note; HTML append is intentionally unsupported. */
  async append(path: string, content: string): Promise<VaultAppendResult> {
    const resolved = await resolveVaultPath(this, path);
    if (Result.isError(resolved)) return resolved;

    const format = noteFormat(resolved.value);
    if (Result.isError(format)) return format;
    if (format.value === "html") {
      return Result.err(
        new NoteValidationError({
          reason: "append",
          path: resolved.value.relative,
          message: "Appending is only supported for Markdown notes.",
        })
      );
    }

    const appended = await appendToVaultFile(resolved.value, content);
    if (Result.isError(appended)) return appended;

    return Result.ok(resolved.value);
  }
}

/** Opens a Hubble vault through the high-level Vault interface. */
export function openVault(root: string): Promise<ResultType<Vault, VaultOpenErrorType>> {
  return Vault.open(root);
}
