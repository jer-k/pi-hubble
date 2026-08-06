import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveHubbleRoot } from "./hubble-config.ts";
import {
  appendToVaultFile,
  assertMarkdownPath,
  editVaultFile,
  listMarkdownFiles,
  openVault,
  readVaultFile,
  resolveVaultPath,
  truncateOutput,
  writeNewVaultFile,
  type HubblePath,
  type HubbleVault,
} from "./hubble-vault.ts";
import { HubbleNotePicker } from "./hubble-ui.ts";

const SearchParameters = Type.Object({
  query: Type.String({ description: "Case-insensitive text to find in Markdown notes" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum matching lines (default: 100)" })),
});

const ReadParameters = Type.Object({
  path: Type.String({ description: "Markdown path relative to the Hubble vault" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based starting line" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000, description: "Maximum lines to return" })),
});

const CreateParameters = Type.Object({
  title: Type.String({ description: "Note title; used for the Markdown heading and filename slug" }),
  content: Type.String({ description: "Markdown body, without the title heading" }),
  folder: Type.Optional(Type.String({ description: "Optional vault-relative folder for the new note" })),
});

const EditParameters = Type.Object({
  path: Type.String({ description: "Markdown path relative to the Hubble vault" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "Exact existing text; it must occur once" }),
      newText: Type.String({ description: "Replacement text" }),
    }),
  ),
});

const AppendParameters = Type.Object({
  path: Type.String({ description: "Markdown path relative to the Hubble vault" }),
  content: Type.String({ description: "Markdown to append to the note" }),
});

async function getVault(root: string): Promise<HubbleVault> {
  return openVault(root);
}

function noteResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

const MAX_AUTOCOMPLETE_ITEMS = 50;

function extractHubblePrefix(textBeforeCursor: string): string | undefined {
  return textBeforeCursor.match(/(?:^|[ \t])(@hubble(?:\/[^\s]*)?)$/u)?.[1];
}

function attachmentValue(path: string): string {
  if (path.includes(" ")) return `@"${path.replaceAll('"', '\\\"')}"`;
  return `@${path}`;
}

function autocompleteItems(files: HubblePath[], query: string): AutocompleteItem[] {
  const filtered = query
    ? fuzzyFilter(files, query, (file) => file.relative)
    : files;
  return filtered.slice(0, MAX_AUTOCOMPLETE_ITEMS).map((file) => ({
    value: attachmentValue(file.absolute),
    label: `@hubble/${file.relative}`,
    description: "Hubble Markdown note",
  }));
}

async function selectNotes(
  vault: HubbleVault,
  query: string,
  searchContents: boolean,
): Promise<HubblePath[]> {
  const files = await listMarkdownFiles(vault);
  if (!query || !searchContents) {
    return query ? fuzzyFilter(files, query, (file) => file.relative) : files;
  }

  const normalizedQuery = query.toLowerCase();
  const matches: HubblePath[] = [];
  for (const file of files) {
    const content = await readVaultFile(file);
    if (content.toLowerCase().includes(normalizedQuery)) matches.push(file);
  }
  return matches;
}

function parseHubbleCommand(args: string): { query: string; searchContents: boolean } {
  const trimmed = args.trim();
  const searchMatch = trimmed.match(/^search(?:\s+(.+))?$/iu);
  if (searchMatch) return { query: searchMatch[1]?.trim() ?? "", searchContents: true };

  const openMatch = trimmed.match(/^open(?:\s+(.+))?$/iu);
  if (openMatch) return { query: openMatch[1]?.trim() ?? "", searchContents: false };

  return { query: trimmed, searchContents: false };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseNewCommand(args: string): { title: string; folder?: string } | undefined {
  const match = args.trim().match(/^new(?:\s+([\s\S]*))?$/iu);
  if (!match) return undefined;

  let remainder = match[1]?.trim() ?? "";
  let folder: string | undefined;
  const folderMatch = remainder.match(/(?:^|\s)--folder(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/u);
  if (folderMatch?.index !== undefined) {
    folder = folderMatch[1] ?? folderMatch[2] ?? folderMatch[3] ?? "";
    remainder = `${remainder.slice(0, folderMatch.index)} ${remainder.slice(folderMatch.index + folderMatch[0].length)}`.trim();
  }

  return { title: unquote(remainder), folder };
}

function appendEditorAttachment(ctx: { ui: { getEditorText(): string; setEditorText(text: string): void } }, path: string): void {
  const current = ctx.ui.getEditorText().trimEnd();
  ctx.ui.setEditorText(`${current}${current ? " " : ""}${attachmentValue(path)}`);
}

type HubbleCommandContext = {
  hasUI: boolean;
  isIdle(): boolean;
  ui: {
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    getEditorText(): string;
    setEditorText(text: string): void;
  };
};

async function handleNewNote(
  args: string,
  ctx: HubbleCommandContext,
  pi: ExtensionAPI,
  getRoot: () => Promise<string>,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/hubble new requires interactive UI mode.", "warning");
    return;
  }

  const parsed = parseNewCommand(args);
  if (!parsed) return;

  let title = parsed.title.trim();
  if (!title) {
    const enteredTitle = await ctx.ui.input("Hubble note title", "Leave blank to let the agent choose");
    if (enteredTitle === undefined) return;
    title = enteredTitle.trim();
  }

  let folder = parsed.folder;
  if (folder === undefined) {
    const enteredFolder = await ctx.ui.input("Hubble folder", "Optional vault-relative folder; blank for vault root");
    if (enteredFolder === undefined) return;
    folder = enteredFolder.trim();
  }

  if (!title) {
    if (!ctx.isIdle()) {
      ctx.ui.notify("The agent is busy. Try /hubble new again when it is idle.", "warning");
      return;
    }

    const folderInstruction = folder ? ` Use the vault-relative folder ${JSON.stringify(folder)}.` : " Use the vault root.";
    pi.sendUserMessage(
      `Create a new Hubble note for the current conversation. Choose a concise, useful title yourself and write a clear Markdown body summarizing the relevant investigation.${folderInstruction} Use hubble_create, do not overwrite an existing note, and report the created path when finished.`,
    );
    ctx.ui.notify("Asked the agent to create a Hubble note and choose its title.", "info");
    return;
  }

  const vault = await getVault(await getRoot());
  const note = await writeNewVaultFile(vault, title, "", folder);
  appendEditorAttachment(ctx, note.absolute);
  ctx.ui.notify(`Created Hubble note: ${note.relative}`, "info");
}

export default function (pi: ExtensionAPI): void {
  pi.registerFlag("hubble-dir", {
    description: "Hubble vault root (overrides HUBBLE_DIR and hubble.json)",
    type: "string",
  });

  // Pi applies CLI extension flag values after loading extension factories, so
  // resolve the root lazily when the first tool runs.
  let rootPromise: Promise<string> | undefined;
  const getRoot = (): Promise<string> => {
    rootPromise ??= resolveHubbleRoot(pi.getFlag("hubble-dir"));
    return rootPromise;
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["@"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
        const prefix = extractHubblePrefix(beforeCursor);
        if (!prefix) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        try {
          const vault = await getVault(await getRoot());
          if (options.signal.aborted) return { prefix, items: [] };
          const query = prefix.startsWith("@hubble/") ? prefix.slice("@hubble/".length) : "";
          return { prefix, items: autocompleteItems(await listMarkdownFiles(vault), query) };
        } catch {
          return { prefix, items: [] };
        }
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });

  pi.registerCommand("hubble", {
    description: "Browse and attach a Markdown note from the Hubble vault",
    getArgumentCompletions(prefix) {
      const items: AutocompleteItem[] = [
        { value: "new", label: "new", description: "Create a new Hubble note" },
        { value: "search", label: "search", description: "Search note contents" },
        { value: "open", label: "open", description: "Browse note filenames" },
      ];
      const filtered = fuzzyFilter(items, prefix, (item) => item.value);
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/hubble requires interactive UI mode.", "warning");
        return;
      }

      if (parseNewCommand(args)) {
        await handleNewNote(args, ctx, pi, getRoot);
        return;
      }

      const { query, searchContents } = parseHubbleCommand(args);
      const vault = await getVault(await getRoot());
      const notes = await selectNotes(vault, query, searchContents);
      if (notes.length === 0) {
        ctx.ui.notify(query ? `No Hubble notes matched: ${query}` : "The Hubble vault has no Markdown notes.", "info");
        return;
      }

      const selected = await ctx.ui.custom<HubblePath | undefined>((tui, theme, keybindings, done) =>
        new HubbleNotePicker(tui, theme, keybindings, notes, searchContents ? "" : query, done),
      );
      if (selected) {
        appendEditorAttachment(ctx, selected.absolute);
        ctx.ui.notify(`Attached Hubble note: ${selected.relative}`, "info");
      }
    },
  });

  pi.registerTool({
    name: "hubble_search",
    label: "Hubble Search",
    description: "Search Markdown notes in the configured Hubble vault. Results are limited and truncated to 50KB or 2000 lines.",
    promptSnippet: "Search Markdown notes in the configured Hubble vault",
    promptGuidelines: [
      "Use hubble_search before hubble_read when you need to discover a note or locate text in the vault.",
      "Hubble tool paths are relative to the configured vault; do not use absolute paths or paths outside the vault.",
    ],
    parameters: SearchParameters,
    async execute(_toolCallId, params) {
      const vault = await getVault(await getRoot());
      const query = params.query.trim().toLowerCase();
      if (!query) throw new Error("query must not be empty.");

      const files = await listMarkdownFiles(vault);
      const matches: string[] = [];
      const maxMatches = params.limit ?? 100;

      for (const file of files) {
        const content = await readVaultFile(file);
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (lines[index].toLowerCase().includes(query)) {
            matches.push(`${file.relative}:${index + 1}: ${lines[index].trim()}`);
            if (matches.length >= maxMatches) break;
          }
        }
        if (matches.length >= maxMatches) break;
      }

      if (matches.length === 0) return noteResult("No Hubble notes matched the query.", { query, matchCount: 0 });
      const output = await truncateOutput(matches.join("\n"));
      return noteResult(output.text, {
        query,
        matchCount: matches.length,
        truncated: output.truncated,
        fullOutputPath: output.fullOutputPath,
      });
    },
  });

  pi.registerTool({
    name: "hubble_read",
    label: "Hubble Read",
    description: "Read a Markdown note from the configured Hubble vault. The path is vault-relative; output is truncated to 50KB or 2000 lines.",
    promptSnippet: "Read a Markdown note from the configured Hubble vault",
    promptGuidelines: [
      "Use hubble_read for notes discovered with hubble_search; pass the vault-relative path returned by Hubble tools.",
    ],
    parameters: ReadParameters,
    async execute(_toolCallId, params) {
      const vault = await getVault(await getRoot());
      const path = await resolveVaultPath(vault, params.path);
      assertMarkdownPath(path);
      const content = await readVaultFile(path);
      const allLines = content.split("\n");
      const start = (params.offset ?? 1) - 1;
      const selected = params.limit === undefined
        ? allLines.slice(start)
        : allLines.slice(start, start + params.limit);
      const output = await truncateOutput(selected.join("\n"));

      return noteResult(`Path: ${path.relative}\n\n${output.text}`, {
        path: path.relative,
        startLine: start + 1,
        returnedLines: selected.length,
        totalLines: allLines.length,
        truncated: output.truncated,
        fullOutputPath: output.fullOutputPath,
      });
    },
  });

  pi.registerTool({
    name: "hubble_create",
    label: "Hubble Create",
    description: "Create a new Markdown note in the configured Hubble vault without overwriting an existing note. Filenames are generated from the title.",
    promptSnippet: "Create a new Markdown note in the configured Hubble vault",
    promptGuidelines: [
      "Use hubble_create instead of overwriting an existing note when the user asks for a new Hubble document.",
    ],
    parameters: CreateParameters,
    async execute(_toolCallId, params) {
      const vault = await getVault(await getRoot());
      const path = await writeNewVaultFile(vault, params.title, params.content, params.folder);
      return noteResult(`Created Hubble note: ${path.relative}`, { path: path.relative });
    },
  });

  pi.registerTool({
    name: "hubble_edit",
    label: "Hubble Edit",
    description: "Apply one or more unique exact-text replacements to a Markdown note in the configured Hubble vault.",
    promptSnippet: "Apply exact edits to a Markdown note in the configured Hubble vault",
    promptGuidelines: [
      "Use hubble_edit for targeted Hubble note changes; each oldText must match exactly once and edits must not overlap.",
    ],
    parameters: EditParameters,
    async execute(_toolCallId, params) {
      const vault = await getVault(await getRoot());
      const path = await resolveVaultPath(vault, params.path);
      assertMarkdownPath(path);
      await editVaultFile(path, params.edits);
      return noteResult(`Updated Hubble note: ${path.relative}`, { path: path.relative, editCount: params.edits.length });
    },
  });

  pi.registerTool({
    name: "hubble_append",
    label: "Hubble Append",
    description: "Append Markdown to an existing note in the configured Hubble vault, preserving the existing content.",
    promptSnippet: "Append Markdown to an existing Hubble note",
    promptGuidelines: [
      "Use hubble_append when adding a section or research result to an existing Hubble note without replacing its contents.",
    ],
    parameters: AppendParameters,
    async execute(_toolCallId, params) {
      const vault = await getVault(await getRoot());
      const path = await resolveVaultPath(vault, params.path);
      assertMarkdownPath(path);
      await appendToVaultFile(path, params.content);
      return noteResult(`Appended to Hubble note: ${path.relative}`, { path: path.relative });
    },
  });
}
