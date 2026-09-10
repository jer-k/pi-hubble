import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";
import { Result } from "better-result";

import type { GetVault } from "./hubble-config.ts";
import { resolveVaultDirectory, resolveVaultPath } from "./hubble-paths.ts";
import { attachmentValue } from "./hubble-ui.ts";
import type {
  NoteReference,
  Vault,
  VaultDirectoryReference,
  VaultDiscoveryResult,
  VaultEntries,
} from "./hubble-vault.ts";

const MAX_AUTOCOMPLETE_ITEMS = 50;

/** Returns the path portion not already represented by a scoped autocomplete query. */
function scopedDisplayPath(path: string, query: string): string {
  const slashIndex = query.lastIndexOf("/");

  if (slashIndex === -1) {
    return path;
  }

  const typedDirectory = query.slice(0, slashIndex + 1);
  return path.toLowerCase().startsWith(typedDirectory.toLowerCase()) ? path.slice(typedDirectory.length) : path;
}

/** Extracts an active @hubble mention from the text before the cursor. */
function extractHubblePrefix(textBeforeCursor: string): string | undefined {
  return textBeforeCursor.match(/(?:^|[ \t])(@hubble(?:\/[^\s]*)?)$/u)?.[1];
}

type HubbleAutocompleteEntry =
  | { readonly kind: "directory"; readonly reference: VaultDirectoryReference }
  | { readonly kind: "note"; readonly reference: NoteReference };

/** Returns the Hubble-relative path used to match and display one autocomplete entry. */
function entryPath(entry: HubbleAutocompleteEntry): string {
  return entry.kind === "directory" ? `${entry.reference.relative}/` : entry.reference.relative;
}

/** Converts matching vault notes and directories into the capped list shown by autocomplete. */
async function autocompleteItems(vault: Vault, entries: VaultEntries, query: string): Promise<AutocompleteItem[]> {
  const candidates: HubbleAutocompleteEntry[] = [
    ...entries.directories.map((reference) => ({ kind: "directory", reference }) as const),
    ...entries.notes.map((reference) => ({ kind: "note", reference }) as const),
  ].sort((left, right) => entryPath(left).localeCompare(entryPath(right)));
  const matching = query ? fuzzyFilter(candidates, query, entryPath) : candidates;
  const safe: HubbleAutocompleteEntry[] = [];

  for (const entry of matching) {
    const path = entryPath(entry);

    if (entry.kind === "directory" && path.toLowerCase() === query.toLowerCase()) {
      continue;
    }

    const checked =
      entry.kind === "directory"
        ? await resolveVaultDirectory(vault, entry.reference.relative)
        : await resolveVaultPath(vault, entry.reference.relative);

    if (Result.isOk(checked) && checked.value.absolute === entry.reference.absolute) {
      safe.push({ kind: entry.kind, reference: checked.value });
    }

    if (safe.length === MAX_AUTOCOMPLETE_ITEMS) {
      break;
    }
  }

  return safe.map((entry) => {
    const path = entryPath(entry);

    return {
      value: entry.kind === "directory" ? `@hubble/${path}` : attachmentValue(entry.reference.absolute),
      // Omitting descriptions lets Pi allocate the full popup width to long
      // paths instead of restricting labels to its 32-column primary column.
      label: query.includes("/") ? scopedDisplayPath(path, query) : `@hubble/${path}`,
    };
  });
}

/** Registers @hubble note suggestions and delegates non-Hubble completion to Pi. */
export function registerHubbleAutocomplete(pi: ExtensionAPI, getVault: GetVault, now: () => number = Date.now): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.addAutocompleteProvider((current) => {
      let cached:
        | {
            readonly vault: Vault;
            readonly version: number;
            readonly expiresAt: number;
            readonly entries: Promise<VaultDiscoveryResult>;
          }
        | undefined;
      return {
        triggerCharacters: ["@"],
        /** Supplies Hubble note suggestions when the editor is typing an @hubble mention. */
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
          const prefix = extractHubblePrefix(beforeCursor);

          if (!prefix) {
            return current.getSuggestions(lines, cursorLine, cursorCol, options);
          }

          if (options.signal.aborted) {
            return { prefix, items: [] };
          }

          const vault = await getVault(ctx);

          if (Result.isError(vault) || options.signal.aborted) {
            return { prefix, items: [] };
          }

          const query = prefix.startsWith("@hubble/") ? prefix.slice("@hubble/".length) : "";

          if (
            options.force ||
            !cached ||
            cached.vault !== vault.value ||
            cached.version !== vault.value.discoveryVersion ||
            now() >= cached.expiresAt
          ) {
            cached = {
              vault: vault.value,
              version: vault.value.discoveryVersion,
              expiresAt: now() + 1_000,
              entries: vault.value.discover(),
            };
          }

          const pending = cached.entries;
          const entries = await pending;
          // Autocomplete deliberately hides expected Vault failures. Defects still throw.
          if (Result.isError(entries)) {
            if (cached?.entries === pending) {
              cached = undefined;
            }

            return { prefix, items: [] };
          }

          if (options.signal.aborted) {
            return { prefix, items: [] };
          }

          const items = await autocompleteItems(vault.value, entries.value, query);
          return { prefix, items: options.signal.aborted ? [] : items };
        },
        /** Reuses Pi's completion insertion behavior for the selected suggestion. */
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
        /** Preserves Pi's decision about whether file completion should trigger. */
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
      };
    });
  });
}
