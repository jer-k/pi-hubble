import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";
import { Result } from "better-result";
import { attachmentValue, type GetRoot, getVault } from "./hubble-boundary.ts";
import { type HubblePath, listMarkdownFiles } from "./hubble-vault.ts";

const MAX_AUTOCOMPLETE_ITEMS = 50;

function extractHubblePrefix(textBeforeCursor: string): string | undefined {
  return textBeforeCursor.match(/(?:^|[ \t])(@hubble(?:\/[^\s]*)?)$/u)?.[1];
}

function autocompleteItems(files: HubblePath[], query: string): AutocompleteItem[] {
  const filtered = query ? fuzzyFilter(files, query, (file) => file.relative) : files;
  return filtered.slice(0, MAX_AUTOCOMPLETE_ITEMS).map((file) => ({
    value: attachmentValue(file.absolute),
    label: `@hubble/${file.relative}`,
    description: "Hubble Markdown note",
  }));
}

export function registerHubbleAutocomplete(pi: ExtensionAPI, getRoot: GetRoot): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["@"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
        const prefix = extractHubblePrefix(beforeCursor);
        if (!prefix) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        const vault = await getVault(getRoot, ctx);
        if (Result.isError(vault) || options.signal.aborted) return { prefix, items: [] };

        const query = prefix.startsWith("@hubble/") ? prefix.slice("@hubble/".length) : "";
        const files = await listMarkdownFiles(vault.value);
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
