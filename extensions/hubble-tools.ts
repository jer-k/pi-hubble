import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Result } from "better-result";
import { Type } from "typebox";
import {
  type GetRoot,
  getToolVault,
  noteResult,
  SearchQueryError,
  throwCreateToolError,
  throwHubbleError,
  throwIfAborted,
  unwrapToolResult,
} from "./hubble-boundary.ts";
import {
  appendToVaultFile,
  assertMarkdownPath,
  editVaultFile,
  listMarkdownFiles,
  readVaultFile,
  resolveVaultPath,
  truncateOutput,
  writeNewVaultFile,
} from "./hubble-vault.ts";

const SearchParameters = Type.Object({
  query: Type.String({ description: "Case-insensitive text to find in Markdown notes" }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 500, description: "Maximum matching lines (default: 100)" })
  ),
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
    })
  ),
});
const AppendParameters = Type.Object({
  path: Type.String({ description: "Markdown path relative to the Hubble vault" }),
  content: Type.String({ description: "Markdown to append to the note" }),
});

export function registerHubbleTools(pi: ExtensionAPI, getRoot: GetRoot): void {
  pi.registerTool({
    name: "hubble_search",
    label: "Hubble Search",
    description:
      "Search Markdown notes in the configured Hubble vault. Results are limited and truncated to 50KB or 2000 lines.",
    promptSnippet: "Search Markdown notes in the configured Hubble vault",
    promptGuidelines: [
      "Use hubble_search before hubble_read when you need to discover a note or locate text in the vault.",
      "Hubble tool paths are relative to the configured vault; do not use absolute paths or paths outside the vault.",
    ],
    parameters: SearchParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      const vault = await getToolVault(getRoot, ctx);
      const query = params.query.trim().toLowerCase();
      if (!query) throwHubbleError(new SearchQueryError({ message: "query must not be empty." }));
      const files = unwrapToolResult(await listMarkdownFiles(vault));
      const matches: string[] = [];
      const maxMatches = params.limit ?? 100;
      for (const file of files) {
        throwIfAborted(signal);
        const content = unwrapToolResult(await readVaultFile(file));
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
      const output = unwrapToolResult(await truncateOutput(matches.join("\n")));
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
    description:
      "Read a Markdown note from the configured Hubble vault. The path is vault-relative; output is truncated to 50KB or 2000 lines.",
    promptSnippet: "Read a Markdown note from the configured Hubble vault",
    promptGuidelines: [
      "Use hubble_read for notes discovered with hubble_search; pass the vault-relative path returned by Hubble tools.",
    ],
    parameters: ReadParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      const vault = await getToolVault(getRoot, ctx);
      const path = unwrapToolResult(await resolveVaultPath(vault, params.path));
      unwrapToolResult(assertMarkdownPath(path));
      const content = unwrapToolResult(await readVaultFile(path));
      const allLines = content.split("\n");
      const start = (params.offset ?? 1) - 1;
      const selected = params.limit === undefined ? allLines.slice(start) : allLines.slice(start, start + params.limit);
      const output = unwrapToolResult(await truncateOutput(selected.join("\n")));
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
    description:
      "Create a new Markdown note in the configured Hubble vault without overwriting an existing note. Filenames are generated from the title.",
    promptSnippet: "Create a new Markdown note in the configured Hubble vault",
    promptGuidelines: [
      "Use hubble_create instead of overwriting an existing note when the user asks for a new Hubble document.",
    ],
    parameters: CreateParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      const vault = await getToolVault(getRoot, ctx);
      const result = await writeNewVaultFile(vault, params.title, params.content, params.folder);
      if (Result.isError(result)) throwCreateToolError(result.error);
      return noteResult(`Created Hubble note: ${result.value.relative}`, { path: result.value.relative });
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      const vault = await getToolVault(getRoot, ctx);
      const path = unwrapToolResult(await resolveVaultPath(vault, params.path));
      unwrapToolResult(assertMarkdownPath(path));
      unwrapToolResult(await editVaultFile(path, params.edits));
      return noteResult(`Updated Hubble note: ${path.relative}`, {
        path: path.relative,
        editCount: params.edits.length,
      });
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      const vault = await getToolVault(getRoot, ctx);
      const path = unwrapToolResult(await resolveVaultPath(vault, params.path));
      unwrapToolResult(assertMarkdownPath(path));
      unwrapToolResult(await appendToVaultFile(path, params.content));
      return noteResult(`Appended to Hubble note: ${path.relative}`, { path: path.relative });
    },
  });
}
