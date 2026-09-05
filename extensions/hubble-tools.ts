import * as nodeFileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  highlightCode,
  keyHint,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Result, type Result as ResultType } from "better-result";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import type { GetVault } from "./hubble-config.ts";
import { type HubbleFailure, OutputPersistenceError, throwHubbleError } from "./hubble-errors.ts";
import { buildNewNoteDocument } from "./hubble-notes.ts";
import type { NoteSearchResult } from "./hubble-vault.ts";

/** Filesystem operations used to persist truncated output and injectable in failure-path tests. */
export interface OutputFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

/** Tool output after applying Pi's context-size limits. */
export interface TruncatedOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

/** Public parameter schema for Hubble note search. */
export const SearchParameters = Type.Object({
  query: Type.String({ description: "Case-insensitive text to find in Hubble notes" }),
  offset: Type.Optional(
    Type.Integer({ minimum: 1, description: "1-based matching-line offset (default: 1); use nextOffset to continue" })
  ),
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
  title: Type.String({
    description: "Note title; used for the heading and, when filename is omitted, the filename slug",
  }),
  content: Type.String({
    description: "Note body without the title heading; Markdown text or an HTML body fragment according to format",
  }),
  filename: Type.Optional(
    Type.String({
      description:
        "Optional exact filename, including .md or .html, without a folder path. Its extension determines the format when format is omitted. Creation fails if it already exists.",
    })
  ),
  folder: Type.Optional(Type.String({ description: "Optional vault-relative folder for the new note" })),
  format: Type.Optional(
    StringEnum(["markdown", "html"] as const, {
      description: "Note format; inferred from filename when provided, otherwise defaults to markdown",
    })
  ),
});

const EditParameters = Type.Object({
  path: Type.String({ description: "Supported note path relative to the Hubble vault" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        description:
          "Exact text for one targeted replacement. It must be unique in the original note and must not overlap with any other edits[].oldText in the same call.",
      }),
      newText: Type.String({ description: "Replacement text for this targeted edit." }),
    }),
    {
      description:
        "One or more targeted replacements. Each edit is matched against the original note, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    }
  ),
});

type HubbleCreateArguments = Static<typeof CreateParameters>;
type HubbleEditArguments = Static<typeof EditParameters>;
type HubbleEditArgumentPreparer = NonNullable<ToolDefinition<typeof EditParameters>["prepareArguments"]>;

const CREATE_PREVIEW_LINES = 10;
const StringValue = Type.String();
const UnpreparedHubbleEditParameters = Type.Object(
  {
    edits: Type.Optional(Type.Unknown()),
    oldText: Type.Optional(Type.Unknown()),
    newText: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true }
);
const NotePathDetails = Type.Object({ path: Type.String() }, { additionalProperties: true });

/** Passes prepared arguments to Pi's mandatory post-prepare Typebox validation. */
const deferToSchemaValidation: HubbleEditArgumentPreparer = (input) => {
  // SAFETY: Pi always validates prepareArguments output against EditParameters before execute runs. Invalid model
  // output must be returned unchanged so that boundary validation, rather than this compatibility shim, reports it.
  return input as HubbleEditArguments;
};

/** Normalizes model-generated edit arguments before Typebox validates the public schema. */
const prepareHubbleEditArguments: HubbleEditArgumentPreparer = (input) => {
  if (!Value.Check(UnpreparedHubbleEditParameters, input)) return deferToSchemaValidation(input);

  const args = { ...input };
  if (Value.Check(StringValue, args.edits)) {
    const serializedEdits = args.edits;
    const parsed = Result.try({
      try: () => JSON.parse(serializedEdits),
      catch: () => undefined,
    });
    if (Result.isOk(parsed) && Array.isArray(parsed.value)) args.edits = parsed.value;
  }

  if (!Value.Check(StringValue, args.oldText) || !Value.Check(StringValue, args.newText)) {
    return deferToSchemaValidation(args);
  }

  const edits = Array.isArray(args.edits) ? [...args.edits] : [];
  edits.push({ oldText: args.oldText, newText: args.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = args;
  return deferToSchemaValidation({ ...rest, edits });
};

/** Returns a successful Result value or raises its Hubble failure for the tool API. */
function unwrap<T, E extends HubbleFailure>(result: ResultType<T, E>): T {
  if (Result.isError(result)) throwHubbleError(result.error);
  return result.value;
}

/** Stops a tool operation immediately when its cancellation signal is aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The Hubble operation was cancelled.", "AbortError");
}

/** Shapes text and typed metadata into the response format used by Hubble tools. */
function noteResult<TDetails extends object>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return { content: [{ type: "text" as const, text }], details };
}

/** Truncates tool output for model context and saves the complete output when needed. */
export async function truncateOutput(
  output: string,
  fileSystem: OutputFileSystem = nodeFileSystem
): Promise<ResultType<TruncatedOutput, OutputPersistenceError>> {
  const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncation.truncated) return Result.ok({ text: truncation.content, truncated: false });

  const directory = await Result.tryPromise({
    try: () => fileSystem.mkdtemp(join(tmpdir(), "pi-hubble-")),
    catch: (cause) => new OutputPersistenceError({ cause, message: "Could not persist the full Hubble tool output." }),
  });

  if (Result.isError(directory)) return directory;

  const fullOutputPath = join(directory.value, "output.txt");
  const persisted = await withFileMutationQueue(fullOutputPath, () =>
    Result.tryPromise({
      try: () => fileSystem.writeFile(fullOutputPath, output, "utf8"),
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

interface FormattedSearchResults {
  readonly lines: ReadonlyArray<string>;
  readonly count: number;
}

/** Converts note search matches into the line-oriented tool output format. */
function formatSearchResults(results: NoteSearchResult[]): FormattedSearchResults {
  const lines = results.flatMap((result) =>
    result.matches.map((match) => `${result.note.relative}:${match.line}: ${match.text.trim()}`)
  );
  return { lines, count: lines.length };
}

/** Registers the Hubble search, read, create, and edit tools. */
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

      const offset = params.offset ?? 1;
      const searched = unwrap(
        await vault.value.searchPage(params.query, { offset, limit: params.limit ?? 100 }, signal)
      );
      const formatted = formatSearchResults(searched.results);
      if (formatted.count === 0)
        return noteResult(
          offset === 1 ? "No Hubble notes matched the query." : "No more Hubble matches at this offset.",
          {
            query: params.query.trim().toLowerCase(),
            matchCount: 0,
          }
        );
      const output = unwrap(await truncateOutput(formatted.lines.join("\n")));

      const nextOffset = searched.hasMore ? offset + formatted.count : undefined;
      const notice =
        nextOffset === undefined
          ? ""
          : `\n\n[More matches available. Continue hubble_search with the same query and offset: ${nextOffset}.]`;
      return noteResult(output.text + notice, {
        nextOffset,
        hasMore: searched.hasMore,
        query: params.query.trim().toLowerCase(),
        matchCount: formatted.count,
        truncated: output.truncated || searched.hasMore,
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
      "Create a new Markdown or HTML note in the configured Hubble vault without overwriting an existing note. An optional filename creates that exact basename; otherwise a filename slug is generated from the title. Markdown is the default, and HTML content is wrapped as a body fragment in a standalone document.",
    promptSnippet: "Create a new Markdown or HTML note in the configured Hubble vault",
    promptGuidelines: [
      "Use hubble_create instead of overwriting an existing note when the user asks for a new Hubble document.",
      "When the user specifies an exact filename for a new Hubble note, pass it to hubble_create as filename instead of creating and editing multiple notes.",
    ],
    parameters: CreateParameters,
    /** Creates a new note in the requested format in the configured vault. */
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);

      const vault = await getVault(ctx);
      if (Result.isError(vault)) throwHubbleError(vault.error);

      const created = unwrap(
        await vault.value.create(params.title, params.content, params.folder, params.format, params.filename)
      );
      return noteResult(`Created Hubble note: ${created.relative}`, { path: created.relative });
    },
    /** Renders the generated document with syntax highlighting and expandable content. */
    renderCall(args, theme, context) {
      const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const partialArgs: Partial<HubbleCreateArguments> = args;
      const title = partialArgs.title ?? "";
      const content = partialArgs.content;
      const filename = partialArgs.filename ?? "";
      const inferredFormat = filename.toLowerCase().endsWith(".html") ? "html" : "markdown";
      const format = partialArgs.format === "html" ? "html" : inferredFormat;
      const folder = partialArgs.folder?.trim() ?? "";
      const destination = filename ? `${folder ? `${folder}/` : ""}${filename}` : folder ? `${folder}/` : "vault root";
      const titleDisplay = title ? JSON.stringify(title) : "...";
      let output = `${theme.fg("toolTitle", theme.bold("hubble_create"))} ${theme.fg("accent", titleDisplay)}`;
      output += theme.fg("dim", ` → ${destination} (${format})`);

      if (title && content !== undefined) {
        const document = buildNewNoteDocument(title, content, format).replaceAll("\r", "").replaceAll("\t", "   ");
        const highlighted = highlightCode(document, format);
        while (highlighted.at(-1) === "") highlighted.pop();
        const visible = context.expanded ? highlighted : highlighted.slice(0, CREATE_PREVIEW_LINES);
        const remaining = highlighted.length - visible.length;
        output += `\n\n${visible.join("\n")}`;
        if (remaining > 0) {
          output += `${theme.fg("muted", `\n... (${remaining} more lines, ${highlighted.length} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
        }
      }

      component.setText(output);
      return component;
    },
    /** Renders the resolved note path after success or the structured tool error after failure. */
    renderResult(result, _options, theme, context) {
      const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      if (context.isError) {
        const message = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        component.setText(theme.fg("error", message));
        return component;
      }

      const details = result.details;
      const path = Value.Check(NotePathDetails, details) ? details.path : undefined;
      component.setText(
        path === undefined
          ? theme.fg("success", "✓ Created Hubble note")
          : `${theme.fg("success", "✓ Created ")}${theme.fg("accent", path)}`
      );
      return component;
    },
  });

  pi.registerTool({
    name: "hubble_edit",
    label: "Hubble Edit",
    description:
      "Edit one Markdown or HTML note using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original note. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    promptSnippet: "Make precise Hubble note edits with exact text replacement, including multiple disjoint edits",
    promptGuidelines: [
      "Use hubble_edit for precise Hubble note changes; edits[].oldText must match exactly.",
      "When changing multiple separate locations in one Hubble note, use one hubble_edit call with multiple entries in edits[] instead of multiple calls.",
      "Each hubble_edit edits[].oldText is matched against the original note, not after earlier edits are applied. Do not emit overlapping or nested edits; merge nearby changes into one edit.",
      "Keep hubble_edit edits[].oldText as small as possible while still being unique in the note. Do not pad with large unchanged regions.",
    ],
    parameters: EditParameters,
    prepareArguments: prepareHubbleEditArguments,
    /** Applies unique exact-text replacements to a vault note through an atomic commit. */
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);

      const vault = await getVault(ctx);
      if (Result.isError(vault)) throwHubbleError(vault.error);

      const edited = unwrap(await vault.value.edit(params.path, params.edits, signal));
      return noteResult(`Updated Hubble note: ${edited.relative}`, {
        path: edited.relative,
        editCount: params.edits.length,
      });
    },
  });
}
