import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Result, type Result as ResultType } from "better-result";
import { Type } from "typebox";
import type { GetVault } from "./hubble-config.ts";
import { type HubbleFailure, OutputPersistenceError, throwHubbleError } from "./hubble-errors.ts";
import type { NoteSearchResult } from "./hubble-vault.ts";

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
}

export const SearchParameters = Type.Object({
  query: Type.String({ description: "Case-insensitive text to find in Hubble notes" }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 500, description: "Maximum matching lines (default: 100)" })
  ),
});

const ReadParameters = Type.Object({
  path: Type.String({ description: "Supported note path relative to the Hubble vault" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based starting line" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000, description: "Maximum lines to return" })),
});

const CreateParameters = Type.Object({
  title: Type.String({ description: "Note title; used for the heading and filename slug" }),
  content: Type.String({
    description: "Note body without the title heading; Markdown text or an HTML body fragment according to format",
  }),
  folder: Type.Optional(Type.String({ description: "Optional vault-relative folder for the new note" })),
  format: Type.Optional(StringEnum(["markdown", "html"] as const, { description: "Note format (default: markdown)" })),
});

const EditParameters = Type.Object({
  path: Type.String({ description: "Supported note path relative to the Hubble vault" }),
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

/** Returns a successful Result value or raises its Hubble failure for the tool API. */
function unwrap<T, E extends HubbleFailure>(result: ResultType<T, E>): T {
  if (Result.isError(result)) throwHubbleError(result.error);
  return result.value;
}

/** Stops a tool operation immediately when its cancellation signal is aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The Hubble operation was cancelled.", "AbortError");
}

/** Shapes text and metadata into the response format used by Hubble tools. */
function noteResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/** Truncates tool output for model context and saves the complete output when needed. */
export async function truncateOutput(output: string): Promise<ResultType<TruncatedOutput, OutputPersistenceError>> {
  const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncation.truncated) return Result.ok({ text: truncation.content, truncated: false });

  const directory = await Result.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "pi-hubble-")),
    catch: (cause) => new OutputPersistenceError({ cause, message: "Could not persist the full Hubble tool output." }),
  });

  if (Result.isError(directory)) return directory;

  const fullOutputPath = join(directory.value, "output.txt");
  const persisted = await withFileMutationQueue(fullOutputPath, () =>
    Result.tryPromise({
      try: () => writeFile(fullOutputPath, output, "utf8"),
      catch: (cause) =>
        new OutputPersistenceError({ cause, message: "Could not persist the full Hubble tool output." }),
    })
  );

  if (Result.isError(persisted)) return persisted;

  return Result.ok({
    text: `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`,
    truncated: true,
    fullOutputPath,
  });
}

/** Converts note search matches into the line-oriented tool output format. */
function formatSearchResults(results: NoteSearchResult[], limit: number): { lines: string[]; count: number } {
  const lines: string[] = [];
  for (const result of results) {
    for (const match of result.matches) {
      lines.push(`${result.note.relative}:${match.line}: ${match.text.trim()}`);

      if (lines.length >= limit) return { lines, count: lines.length };
    }
  }
  return { lines, count: lines.length };
}

/** Registers the Hubble search, read, create, edit, and append tools. */
export function registerHubbleTools(pi: ExtensionAPI, getVault: GetVault): void {
  pi.registerTool({
    name: "hubble_search",
    label: "Hubble Search",
    description:
      "Search Markdown and HTML notes in the configured Hubble vault. HTML is searched as raw source. Results are limited and truncated to 50KB or 2000 lines.",
    promptSnippet: "Search notes in the configured Hubble vault",
    promptGuidelines: [
      "Use hubble_search before hubble_read when you need to discover a note or locate text in the vault.",
      "Hubble tool paths are relative to the configured vault; do not use absolute paths or paths outside the vault.",
    ],
    parameters: SearchParameters,
    /** Searches vault notes and formats matching lines for the model. */
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);

      const vault = await getVault(ctx);
      if (Result.isError(vault)) throwHubbleError(vault.error);

      const searched = await vault.value.search(params.query, signal);
      const results = unwrap(searched);
      const formatted = formatSearchResults(results, params.limit ?? 100);
      if (formatted.count === 0)
        return noteResult("No Hubble notes matched the query.", {
          query: params.query.trim().toLowerCase(),
          matchCount: 0,
        });
      const output = unwrap(await truncateOutput(formatted.lines.join("\n")));

      return noteResult(output.text, {
        query: params.query.trim().toLowerCase(),
        matchCount: formatted.count,
        truncated: output.truncated,
        fullOutputPath: output.fullOutputPath,
      });
    },
  });

  pi.registerTool({
    name: "hubble_read",
    label: "Hubble Read",
    description:
      "Read a Markdown or HTML note from the configured Hubble vault. The path is vault-relative; output is truncated to 50KB or 2000 lines.",
    promptSnippet: "Read a note from the configured Hubble vault",
    promptGuidelines: [
      "Use hubble_read for notes discovered with hubble_search; pass the vault-relative path returned by Hubble tools.",
    ],
    parameters: ReadParameters,
    /** Reads a vault-relative note, optionally returning only a requested line range. */
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);

      const vault = await getVault(ctx);
      if (Result.isError(vault)) throwHubbleError(vault.error);

      const read = unwrap(await vault.value.read(params.path));
      const allLines = read.content.split("\n");
      const start = (params.offset ?? 1) - 1;
      const selected = params.limit === undefined ? allLines.slice(start) : allLines.slice(start, start + params.limit);
      const output = unwrap(await truncateOutput(selected.join("\n")));

      return noteResult(`Path: ${read.note.relative}\n\n${output.text}`, {
        path: read.note.relative,
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
      "Create a new Markdown or HTML note in the configured Hubble vault without overwriting an existing note. Markdown is the default; HTML content is wrapped as a body fragment in a standalone document.",
    promptSnippet: "Create a new Markdown or HTML note in the configured Hubble vault",
    promptGuidelines: [
      "Use hubble_create instead of overwriting an existing note when the user asks for a new Hubble document.",
    ],
    parameters: CreateParameters,
    /** Creates a new note in the requested format in the configured vault. */
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);

      const vault = await getVault(ctx);
      if (Result.isError(vault)) throwHubbleError(vault.error);

      const created = unwrap(await vault.value.create(params.title, params.content, params.folder, params.format));
      return noteResult(`Created Hubble note: ${created.relative}`, { path: created.relative });
    },
  });

  pi.registerTool({
    name: "hubble_edit",
    label: "Hubble Edit",
    description:
      "Apply one or more unique exact-text replacements to a Markdown or HTML note in the configured Hubble vault.",
    promptSnippet: "Apply exact edits to a Hubble note in the configured vault",
    promptGuidelines: [
      "Use hubble_edit for targeted Hubble note changes; each oldText must match exactly once and edits must not overlap.",
    ],
    parameters: EditParameters,
    /** Applies unique exact-text replacements to a vault note. */
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);

      const vault = await getVault(ctx);
      if (Result.isError(vault)) throwHubbleError(vault.error);

      const edited = unwrap(await vault.value.edit(params.path, params.edits));
      return noteResult(`Updated Hubble note: ${edited.relative}`, {
        path: edited.relative,
        editCount: params.edits.length,
      });
    },
  });

  pi.registerTool({
    name: "hubble_append",
    label: "Hubble Append",
    description:
      "Append Markdown to an existing Markdown note in the configured Hubble vault, preserving the existing content. HTML append is not supported.",
    promptSnippet: "Append Markdown to an existing Hubble Markdown note",
    promptGuidelines: [
      "Use hubble_append only for Markdown notes when adding content without replacing the existing note.",
    ],
    parameters: AppendParameters,
    /** Appends Markdown to an existing vault note. */
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);

      const vault = await getVault(ctx);
      if (Result.isError(vault)) throwHubbleError(vault.error);

      const appended = unwrap(await vault.value.append(params.path, params.content));
      return noteResult(`Appended to Hubble note: ${appended.relative}`, { path: appended.relative });
    },
  });
}
