import { Result, type Result as ResultType } from "better-result";

import {
  type CreateNoteError,
  type DeleteNoteError,
  type DiscoveryError,
  type EditNoteError,
  type MoveNoteError,
  NoteValidationError,
  type VaultNoteError,
  type VaultPathError,
  type VaultOpenErrorType,
} from "./hubble-errors.ts";
import {
  deleteVaultFile,
  discoverVaultEntries,
  editVaultFile,
  type HubbleEdit,
  listNoteFiles,
  moveVaultFile,
  type NoteFileSystem,
  type NoteReference,
  type VaultEntries,
  readVaultFile,
  writeNewVaultFile,
} from "./hubble-notes.ts";
import {
  assertNotePath,
  canonicalVaultRoot,
  type HubbleNoteFormat,
  noteFormat,
  resolveVaultDirectory,
  resolveVaultPath,
  VaultRoot,
} from "./hubble-paths.ts";

export type { HubbleEdit, NoteReference, VaultDirectoryReference, VaultEntries } from "./hubble-notes.ts";

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
/** A matching-line window, optionally restricted to one recursive vault folder. */
export interface SearchPageOptions {
  /** Optional vault-relative folder or `@hubble/<folder>/` reference to search recursively. */
  readonly folder?: string;
  /** One-based matching-line offset. */
  readonly offset: number;
  /** Maximum matching lines to retain; must be between 1 and 500. */
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
/** Result of moving or renaming one note without overwriting its destination. */
export type VaultMoveResult = ResultType<NoteReference, MoveNoteError>;
/** Result of deleting one existing note. */
export type VaultDeleteResult = ResultType<NoteReference, DeleteNoteError>;
/** Result of recursively listing supported notes. */
export type VaultListResult = ResultType<NoteReference[], DiscoveryError>;
/** Result of recursively discovering supported notes and vault directories in an optional folder. */
export type VaultDiscoveryResult = ResultType<VaultEntries, DiscoveryError | VaultPathError>;

/**
 * The high-level Hubble seam. Path security, note-format validation, and
 * storage are deliberately hidden behind this small constructed interface.
 */
export class Vault extends VaultRoot {
  /** Canonical filesystem root used by this vault. */
  readonly root: string;

  /** Filesystem adapter used for note storage after path resolution. */
  private readonly fileSystem: NoteFileSystem | undefined;
  private discoveryRevision = 0;

  /** Changes after successful note mutations so autocomplete can immediately refresh its entries. */
  get discoveryVersion(): number {
    return this.discoveryRevision;
  }

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

  /** Discovers every supported note and safe directory currently stored in the vault. */
  async discover(signal?: AbortSignal): Promise<VaultDiscoveryResult> {
    return discoverVaultEntries(this, this.fileSystem, signal);
  }

  /** Discovers supported notes and safe directories recursively within one folder scope. */
  async discoverInFolder(folder: string, signal?: AbortSignal): Promise<VaultDiscoveryResult> {
    const directory = await resolveVaultDirectory(this, folder);

    if (Result.isError(directory)) {
      return directory;
    }

    return discoverVaultEntries(this, this.fileSystem, signal, directory.value);
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

  /** Scans only the requested subtree, sharing UI/page matching semantics without retaining skipped matches. */
  private async scan(query: string, signal?: AbortSignal, page?: SearchPageOptions): Promise<VaultSearchPageResult> {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return Result.err(new NoteValidationError({ reason: "query", message: "query must not be empty." }));
    }

    const directory = page?.folder === undefined ? undefined : await resolveVaultDirectory(this, page.folder);

    if (directory && Result.isError(directory)) {
      return directory;
    }

    const entries = await discoverVaultEntries(this, this.fileSystem, signal, directory?.value);

    if (Result.isError(entries)) {
      return entries;
    }

    const notes = entries.value.notes;
    const results: NoteSearchResult[] = [];
    let skipped = 0;
    let retained = 0;

    for (const note of notes) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("The Hubble operation was cancelled.", "AbortError");
      }

      const content = await this.read(note.relative);

      if (Result.isError(content)) {
        return content;
      }

      const matches: NoteSearchMatch[] = [];

      for (const [index, line] of content.value.content.split("\n").entries()) {
        if (!line.toLowerCase().includes(normalized)) {
          continue;
        }

        if (page && skipped++ < page.offset - 1) {
          continue;
        }

        if (page && retained === page.limit) {
          if (matches.length > 0) {
            results.push({ note: content.value.note, matches });
          }

          return Result.ok({ results, hasMore: true });
        }

        matches.push({ line: index + 1, text: line });
        retained++;
      }

      if (matches.length > 0) {
        results.push({ note: content.value.note, matches });
      }
    }

    return Result.ok({ results, hasMore: false });
  }

  /** Resolves, validates, and reads one supported note from the vault. */
  async read(path: string): Promise<VaultReadResult> {
    const resolved = await resolveVaultPath(this, path);

    if (Result.isError(resolved)) {
      return resolved;
    }

    const supported = assertNotePath(resolved.value);

    if (Result.isError(supported)) {
      return supported;
    }

    const content = await readVaultFile(resolved.value, this.fileSystem);

    if (Result.isError(content)) {
      return content;
    }

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
    const created = await writeNewVaultFile(this, title, content, folder, format, filename, this.fileSystem);

    if (Result.isOk(created)) {
      this.discoveryRevision++;
    }

    return created;
  }

  /**
   * Applies exact-text edits to one validated supported note.
   * Returns structured path, read, validation, or atomic-write failures.
   */
  async edit(path: string, edits: ReadonlyArray<HubbleEdit>, signal?: AbortSignal): Promise<VaultEditResult> {
    const resolved = await resolveVaultPath(this, path);

    if (Result.isError(resolved)) {
      return resolved;
    }

    const supported = assertNotePath(resolved.value);

    if (Result.isError(supported)) {
      return supported;
    }

    const edited = await editVaultFile(resolved.value, edits, signal, this.fileSystem);

    if (Result.isError(edited)) {
      return edited;
    }

    return Result.ok(resolved.value);
  }

  /**
   * Moves or renames a note, creating missing parent folders without overwriting.
   * Returns structured path, validation, read, conflict, or storage failures.
   */
  async move(path: string, destination: string, signal?: AbortSignal): Promise<VaultMoveResult> {
    const source = await resolveVaultPath(this, path);

    if (Result.isError(source)) {
      return source;
    }

    const supportedSource = noteFormat(source.value);

    if (Result.isError(supportedSource)) {
      return supportedSource;
    }

    const target = await resolveVaultPath(this, destination);

    if (Result.isError(target)) {
      return target;
    }

    const supportedTarget = noteFormat(target.value);

    if (Result.isError(supportedTarget)) {
      return supportedTarget;
    }

    if (source.value.absolute === target.value.absolute) {
      return Result.err(
        new NoteValidationError({
          reason: "destination",
          path: target.value.relative,
          message: "The Hubble move destination must differ from its source.",
        })
      );
    }

    if (supportedSource.value !== supportedTarget.value) {
      return Result.err(
        new NoteValidationError({
          reason: "format",
          path: target.value.relative,
          message: "A Hubble note move cannot change the note format.",
        })
      );
    }

    const moved = await moveVaultFile(this, source.value, target.value, signal, this.fileSystem);

    if (Result.isError(moved)) {
      return moved;
    }

    this.discoveryRevision++;
    return Result.ok(target.value);
  }

  /** Permanently deletes one supported vault note, returning structured path, read, conflict, or storage failures. */
  async delete(path: string, signal?: AbortSignal): Promise<VaultDeleteResult> {
    const resolved = await resolveVaultPath(this, path);

    if (Result.isError(resolved)) {
      return resolved;
    }

    const supported = assertNotePath(resolved.value);

    if (Result.isError(supported)) {
      return supported;
    }

    const deleted = await deleteVaultFile(this, resolved.value, signal, this.fileSystem);

    if (Result.isError(deleted)) {
      return deleted;
    }

    this.discoveryRevision++;
    return Result.ok(resolved.value);
  }
}

/** Opens a Hubble vault through the high-level Vault interface. */
export function openVault(root: string, fileSystem?: NoteFileSystem): Promise<ResultType<Vault, VaultOpenErrorType>> {
  return Vault.open(root, fileSystem);
}
