import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";
import { Result } from "better-result";
import type { GetVault } from "./hubble-config.ts";
import { attachmentValue } from "./hubble-ui.ts";
import type { NoteReference } from "./hubble-vault.ts";

const MAX_AUTOCOMPLETE_ITEMS = 50;

/** Extracts an active @hubble mention from the text before the cursor. */
function extractHubblePrefix(textBeforeCursor: string): string | undefined {
  return textBeforeCursor.match(/(?:^|[ \t])(@hubble(?:\/[^\s]*)?)$/u)?.[1];
}

/** Converts matching vault notes into the capped list shown by autocomplete. */
function autocompleteItems(files: NoteReference[], query: string): AutocompleteItem[] {
  const filtered = query ? fuzzyFilter(files, query, (file) => file.relative) : files;
  return filtered.slice(0, MAX_AUTOCOMPLETE_ITEMS).map((file) => ({
    value: attachmentValue(file.absolute),
    label: `@hubble/${file.relative}`,
    description: "Hubble Markdown note",
  }));
}

/** Registers @hubble note suggestions and delegates non-Hubble completion to Pi. */
export function registerHubbleAutocomplete(pi: ExtensionAPI, getVault: GetVault): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["@"],
      /** Supplies Hubble note suggestions when the editor is typing an @hubble mention. */
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
        const prefix = extractHubblePrefix(beforeCursor);
        if (!prefix) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        if (options.signal.aborted) return { prefix, items: [] };

        const vault = await getVault(ctx);
        if (Result.isError(vault) || options.signal.aborted) return { prefix, items: [] };

        const query = prefix.startsWith("@hubble/") ? prefix.slice("@hubble/".length) : "";
        const files = await vault.value.list();
        // Autocomplete deliberately hides expected Vault failures. Defects still throw.
        if (Result.isError(files)) return { prefix, items: [] };

        return { prefix, items: autocompleteItems(files.value, query) };
      },
      /** Reuses Pi's completion insertion behavior for the selected suggestion. */
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      /** Preserves Pi's decision about whether file completion should trigger. */
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
}
