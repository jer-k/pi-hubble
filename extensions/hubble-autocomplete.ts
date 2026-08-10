import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";
import { Result } from "better-result";
import type { GetVault } from "./hubble-config.ts";
import { attachmentValue } from "./hubble-ui.ts";
import type { NoteReference } from "./hubble-vault.ts";

const MAX_AUTOCOMPLETE_ITEMS = 50;

function extractHubblePrefix(textBeforeCursor: string): string | undefined {
  return textBeforeCursor.match(/(?:^|[ \t])(@hubble(?:\/[^\s]*)?)$/u)?.[1];
}

function autocompleteItems(files: NoteReference[], query: string): AutocompleteItem[] {
  const filtered = query ? fuzzyFilter(files, query, (file) => file.relative) : files;
  return filtered.slice(0, MAX_AUTOCOMPLETE_ITEMS).map((file) => ({
    value: attachmentValue(file.absolute),
    label: `@hubble/${file.relative}`,
    description: "Hubble Markdown note",
  }));
}

export function registerHubbleAutocomplete(pi: ExtensionAPI, getVault: GetVault): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["@"],
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
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
}
