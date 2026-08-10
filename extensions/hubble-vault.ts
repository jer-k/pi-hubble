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
  listMarkdownFiles,
  type NoteReference,
  readVaultFile,
  writeNewVaultFile,
} from "./hubble-notes.ts";
import { assertMarkdownPath, canonicalVaultRoot, resolveVaultPath, type VaultRoot } from "./hubble-paths.ts";

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
 * The high-level Hubble seam. Path security, Markdown validation, and note
 * storage are deliberately hidden behind this small constructed interface.
 */
export class Vault implements VaultRoot {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(root: string): Promise<ResultType<Vault, VaultOpenErrorType>> {
    const resolved = await canonicalVaultRoot(root);
    return Result.isError(resolved) ? resolved : Result.ok(new Vault(resolved.value));
  }

  async list(): Promise<VaultListResult> {
    return listMarkdownFiles(this);
  }

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

  async read(path: string): Promise<VaultReadResult> {
    const resolved = await resolveVaultPath(this, path);
    if (Result.isError(resolved)) return resolved;

    const markdown = assertMarkdownPath(resolved.value);
    if (Result.isError(markdown)) return markdown;

    const content = await readVaultFile(resolved.value);
    if (Result.isError(content)) return content;

    return Result.ok({ note: resolved.value, content: content.value });
  }

  async create(title: string, content: string, folder = ""): Promise<VaultCreateResult> {
    return writeNewVaultFile(this, title, content, folder);
  }

  async edit(path: string, edits: HubbleEdit[]): Promise<VaultEditResult> {
    const resolved = await resolveVaultPath(this, path);
    if (Result.isError(resolved)) return resolved;

    const markdown = assertMarkdownPath(resolved.value);
    if (Result.isError(markdown)) return markdown;

    const edited = await editVaultFile(resolved.value, edits);
    if (Result.isError(edited)) return edited;

    return Result.ok(resolved.value);
  }

  async append(path: string, content: string): Promise<VaultAppendResult> {
    const resolved = await resolveVaultPath(this, path);
    if (Result.isError(resolved)) return resolved;

    const markdown = assertMarkdownPath(resolved.value);
    if (Result.isError(markdown)) return markdown;

    const appended = await appendToVaultFile(resolved.value, content);
    if (Result.isError(appended)) return appended;

    return Result.ok(resolved.value);
  }
}

export function openVault(root: string): Promise<ResultType<Vault, VaultOpenErrorType>> {
  return Vault.open(root);
}
