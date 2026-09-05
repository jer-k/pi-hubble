import { Result, type Result as ResultType } from "better-result";

import {
  type CreateNoteError,
  type DiscoveryError,
  type EditNoteError,
  NoteValidationError,
  type VaultNoteError,
  type VaultOpenErrorType,
} from "./hubble-errors.ts";
import {
  editVaultFile,
  type HubbleEdit,
  listNoteFiles,
  type NoteFileSystem,
  type NoteReference,
  readVaultFile,
  writeNewVaultFile,
} from "./hubble-notes.ts";
import {
  assertNotePath,
  canonicalVaultRoot,
  type HubbleNoteFormat,
  resolveVaultPath,
  VaultRoot,
} from "./hubble-paths.ts";

export type { HubbleEdit, NoteReference } from "./hubble-notes.ts";

/** A note and its UTF-8 contents read from the vault. */
export interface ReadNote {
  readonly note: NoteReference;
  readonly content: string;
}

/** One line containing a case-insensitive search match. */
export interface NoteSearchMatch {
  readonly line: number;
  readonly text: string;
}

/** All matching lines found in one note. */
export interface NoteSearchResult {
  readonly note: NoteReference;
  readonly matches: ReadonlyArray<NoteSearchMatch>;
}

/** Result of resolving, validating, and reading one note. */
export type VaultReadResult = ResultType<ReadNote, VaultNoteError>;
/** Result of searching every supported note. */
export type VaultSearchResult = ResultType<NoteSearchResult[], DiscoveryError | VaultNoteError | NoteValidationError>;
/** A matching-line window; offsets are 1-based and limits are between 1 and 500. */
export interface SearchPageOptions {
  readonly offset: number;
  readonly limit: number;
}

/** A bounded search page with a lookahead indicating whether more matches exist. */
export interface NoteSearchPage {
  readonly results: NoteSearchResult[];
  readonly hasMore: boolean;
}

/** A search page or a structured input, discovery, or read failure. */
export type VaultSearchPageResult = ResultType<NoteSearchPage, DiscoveryError | VaultNoteError | NoteValidationError>;

/** Result of creating one note without overwriting an existing file. */
export type VaultCreateResult = ResultType<NoteReference, CreateNoteError>;
/** Result of atomically editing one existing note. */
export type VaultEditResult = ResultType<NoteReference, EditNoteError | VaultNoteError>;
/** Result of recursively listing supported notes. */
export type VaultListResult = ResultType<NoteReference[], DiscoveryError>;

/**
 * The high-level Hubble seam. Path security, note-format validation, and
 * storage are deliberately hidden behind this small constructed interface.
 */
export class Vault extends VaultRoot {
  /** Canonical filesystem root used by this vault. */
  readonly root: string;

  /** Filesystem adapter used for note storage after path resolution. */
  private readonly fileSystem: NoteFileSystem | undefined;

  /** Creates a Vault around an already canonicalized root. */
  private constructor(root: string, fileSystem: NoteFileSystem | undefined) {
    super();
    this.root = root;
    this.fileSystem = fileSystem;
  }

  /** Opens and canonicalizes a vault root before exposing vault operations. */
  static async open(root: string, fileSystem?: NoteFileSystem): Promise<ResultType<Vault, VaultOpenErrorType>> {
    const resolved = await canonicalVaultRoot(root);
    return Result.isError(resolved) ? resolved : Result.ok(new Vault(resolved.value, fileSystem));
  }

  /** Lists all supported notes currently stored in the vault. */
  async list(signal?: AbortSignal): Promise<VaultListResult> {
    return listNoteFiles(this, this.fileSystem, signal);
  }

  /** Searches every supported note's raw text for case-insensitive line matches. */
  async search(query: string, signal?: AbortSignal): Promise<VaultSearchResult> {
    const searched = await this.scan(query, signal);
    return Result.isError(searched) ? searched : Result.ok(searched.value.results);
  }

  /** Searches only through the requested page and one lookahead match; returns input, discovery, or read errors. */
  async searchPage(query: string, page: SearchPageOptions, signal?: AbortSignal): Promise<VaultSearchPageResult> {
    if (
      !Number.isSafeInteger(page.offset) ||
      page.offset < 1 ||
      !Number.isSafeInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > 500
    ) {
      return Result.err(
        new NoteValidationError({
          reason: "pagination",
          message: "Search offset must be a positive safe integer and limit must be between 1 and 500.",
        })
      );
    }
    return this.scan(query, signal, page);
  }

  /** Shares matching semantics between complete UI search and bounded tool pages without retaining skipped matches. */
  private async scan(query: string, signal?: AbortSignal, page?: SearchPageOptions): Promise<VaultSearchPageResult> {
    const normalized = query.trim().toLowerCase();
    if (!normalized)
      return Result.err(new NoteValidationError({ reason: "query", message: "query must not be empty." }));

    const files = await this.list(signal);
    if (Result.isError(files)) return files;

    const results: NoteSearchResult[] = [];
    let skipped = 0;
    let retained = 0;
    for (const note of files.value) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("The Hubble operation was cancelled.", "AbortError");

      const content = await this.read(note.relative);
      if (Result.isError(content)) return content;

      const matches: NoteSearchMatch[] = [];
      for (const [index, line] of content.value.content.split("\n").entries()) {
        if (!line.toLowerCase().includes(normalized)) continue;
        if (page && skipped++ < page.offset - 1) continue;
        if (page && retained === page.limit) {
          if (matches.length > 0) results.push({ note: content.value.note, matches });
          return Result.ok({ results, hasMore: true });
        }
        matches.push({ line: index + 1, text: line });
        retained++;
      }
      if (matches.length > 0) results.push({ note: content.value.note, matches });
    }

    return Result.ok({ results, hasMore: false });
  }

  /** Resolves, validates, and reads one supported note from the vault. */
  async read(path: string): Promise<VaultReadResult> {
    const resolved = await resolveVaultPath(this, path);
    if (Result.isError(resolved)) return resolved;

    const supported = assertNotePath(resolved.value);
    if (Result.isError(supported)) return supported;

    const content = await readVaultFile(resolved.value, this.fileSystem);
    if (Result.isError(content)) return content;

    return Result.ok({ note: resolved.value, content: content.value });
  }

  /**
   * Creates a note, defaulting to a title-derived Markdown filename.
   * An optional exact filename determines the format from its extension and fails on collision.
   */
  async create(
    title: string,
    content: string,
    folder = "",
    format?: HubbleNoteFormat,
    filename?: string
  ): Promise<VaultCreateResult> {
    return writeNewVaultFile(this, title, content, folder, format, filename, this.fileSystem);
  }

  /**
   * Applies exact-text edits to one validated supported note.
   * Returns structured path, read, validation, or atomic-write failures.
   */
  async edit(path: string, edits: ReadonlyArray<HubbleEdit>, signal?: AbortSignal): Promise<VaultEditResult> {
    const resolved = await resolveVaultPath(this, path);
    if (Result.isError(resolved)) return resolved;

    const supported = assertNotePath(resolved.value);
    if (Result.isError(supported)) return supported;

    const edited = await editVaultFile(resolved.value, edits, signal, this.fileSystem);
    if (Result.isError(edited)) return edited;

    return Result.ok(resolved.value);
  }
}

/** Opens a Hubble vault through the high-level Vault interface. */
export function openVault(root: string, fileSystem?: NoteFileSystem): Promise<ResultType<Vault, VaultOpenErrorType>> {
  return Vault.open(root, fileSystem);
}
