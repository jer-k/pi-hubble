import * as fs from "node:fs/promises";
import { join, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentToolResult,
  createAgentSession,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Result, type Result as ResultType } from "better-result";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  BenchmarkError,
  EditValidationError,
  type HubbleFailure,
  NoteConflictError,
  NoteDeleteError,
  NoteMoveError,
  NoteNotFoundError,
  NoteReadError,
  NoteValidationError,
  NoteWriteError,
  OutputPersistenceError,
  VaultDiscoveryError,
  VaultPathError,
} from "../extensions/hubble-errors.ts";
import { buildNewNoteDocument, type HubbleEdit } from "../extensions/hubble-notes.ts";
import { registerHubbleTools } from "../extensions/hubble-tools.ts";
import { Vault } from "../extensions/hubble-vault.ts";
import {
  type BenchmarkDocument,
  type BenchmarkFileSystem,
  type BenchmarkOptions,
  benchmarkDocument,
  benchmarkFileOperation,
  benchmarkSummary,
  runInBenchmarkWorkspace,
  syntheticBenchmarkDocument,
} from "./hubble-benchmark.ts";

const TOOL_NAMES = [
  "hubble_list",
  "hubble_search",
  "hubble_read",
  "hubble_create",
  "hubble_edit",
  "hubble_move",
  "hubble_delete",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];
type BoundTool = AgentSession["agent"]["state"]["tools"][number];
type ToolResult = AgentToolResult<unknown>;
type ToolOutcome = ResultType<ToolResult, BenchmarkError>;
type Verification = ResultType<void, BenchmarkError>;
type ToolFailure =
  | VaultPathError
  | NoteValidationError
  | NoteWriteError
  | NoteReadError
  | NoteNotFoundError
  | EditValidationError
  | NoteConflictError
  | NoteMoveError
  | NoteDeleteError
  | VaultDiscoveryError
  | OutputPersistenceError;

/** Concrete fixture inputs; Pi's registered schema remains authoritative at invocation. */
type ToolArguments =
  | { readonly folder?: string }
  | { readonly query: string; readonly folder?: string; readonly offset?: number; readonly limit?: number }
  | { readonly path: string; readonly offset?: number; readonly limit?: number }
  | { readonly title: string; readonly content: string; readonly folder?: string; readonly filename?: string }
  | { readonly path: string; readonly edits: ReadonlyArray<HubbleEdit> }
  | { readonly path: string; readonly destination: string };

interface Scenario {
  readonly tool: ToolName;
  readonly name: string;
  readonly bytes: number;
  readonly args: (index: number) => ToolArguments;
  readonly prepare?: (index: number) => Promise<Verification>;
  readonly verify: (index: number, outcome: ToolOutcome) => Promise<Verification>;
}

const Details = Type.Record(Type.String(), Type.Unknown());
const PersistedOutput = Type.Object({ fullOutputPath: Type.Optional(Type.String()) }, { additionalProperties: true });
const FailureTag = Type.Object({ _tag: Type.String() }, { additionalProperties: true });
interface SearchNeedles {
  readonly match: string;
  readonly longMatch: string;
  readonly absent: string;
}

/** Chooses fixture queries that cannot accidentally match an arbitrary supplied source document. */
function searchNeedles(document: BenchmarkDocument): SearchNeedles {
  const source = document.document.toLowerCase();
  const unused = (base: string): string => {
    let needle = base;

    while (source.includes(needle)) {
      needle += "-unused";
    }

    return needle;
  };
  return {
    match: unused("benchmark-needle-once"),
    longMatch: unused("benchmark-long-match"),
    absent: unused("benchmark-absent-needle-never-seeded"),
  };
}

/** Reports failed observable assertions without leaking source note contents into diagnostics. */
function check(condition: boolean, message: string, cause?: unknown): Verification {
  return condition ? Result.ok() : Result.err(new BenchmarkError({ reason: "verification", message, cause }));
}

/** Translates expected Vault fixture/verification failures into benchmark failures, preserving the original error. */
function vaultResult<T, E extends HubbleFailure>(result: ResultType<T, E>): ResultType<T, BenchmarkError> {
  return Result.isError(result)
    ? Result.err(new BenchmarkError({ reason: "operation", cause: result.error, message: result.error.message }))
    : result;
}

/** Normalizes only known throwHubbleError failures; programmer defects remain exceptions. */
function toolFailure(cause: unknown): ToolFailure | undefined {
  const error = cause instanceof Error ? cause.cause : undefined;

  if (
    VaultPathError.is(error) ||
    NoteValidationError.is(error) ||
    NoteWriteError.is(error) ||
    NoteReadError.is(error) ||
    NoteNotFoundError.is(error) ||
    EditValidationError.is(error) ||
    NoteConflictError.is(error) ||
    NoteMoveError.is(error) ||
    NoteDeleteError.is(error) ||
    VaultDiscoveryError.is(error) ||
    OutputPersistenceError.is(error)
  ) {
    return error;
  }

  return undefined;
}

/** Invokes the actual bound tool with its compatibility shim and TypeBox input validation. */
function invoke(tool: BoundTool, args: ToolArguments): Promise<ToolOutcome> {
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;

  if (!Value.Check(tool.parameters, prepared)) {
    throw new Error(`Invalid benchmark fixture arguments for ${tool.name}.`);
  }

  return Result.tryPromise({
    try: () => tool.execute("benchmark", prepared, undefined, undefined),
    catch: (cause) => {
      const failure = toolFailure(cause);

      if (!failure) {
        throw cause;
      }

      return new BenchmarkError({ reason: "operation", cause: failure, message: failure.message });
    },
  });
}

/** Contains third-party SDK initialization failures at the runtime boundary. */
function runtimeOperation<T>(action: () => Promise<T>): Promise<ResultType<T, BenchmarkError>> {
  return Result.tryPromise({
    try: action,
    catch: (cause) =>
      new BenchmarkError({
        reason: "runtime",
        cause,
        message: "Could not initialize the isolated Pi benchmark runtime.",
      }),
  });
}

/** Creates an offline SDK session with only the real Hubble tool registrations and scratch-local output persistence. */
async function openRuntime(workspace: string, vault: Vault): Promise<ResultType<AgentSession, BenchmarkError>> {
  const agentDir = join(workspace, "agent");
  const made = await benchmarkFileOperation(agentDir, () => fs.mkdir(agentDir, { recursive: true }));

  if (Result.isError(made)) {
    return made;
  }

  const modelRuntime = await runtimeOperation(() =>
    ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    })
  );

  if (Result.isError(modelRuntime)) {
    return modelRuntime;
  }

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) =>
        registerHubbleTools(pi, async () => Result.ok(vault), {
          // Keep oversized responses on the measured filesystem and inside the same
          // disposable workspace, rather than leaking Pi output directories in /tmp.
          mkdtemp: () => fs.mkdtemp(join(workspace, "output-")),
          writeFile: fs.writeFile,
        }),
    ],
  });
  const loaded = await runtimeOperation(() => resourceLoader.reload());

  if (Result.isError(loaded)) {
    return loaded;
  }

  const errors = resourceLoader.getExtensions().errors;

  if (errors.length > 0) {
    return Result.err(
      new BenchmarkError({
        reason: "runtime",
        cause: errors,
        message: "The Hubble benchmark extension failed to load.",
      })
    );
  }

  const created = await runtimeOperation(() =>
    createAgentSession({
      cwd: workspace,
      agentDir,
      modelRuntime: modelRuntime.value,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(workspace),
      noTools: "builtin",
    })
  );

  if (Result.isError(created)) {
    return created;
  }

  const { session } = created.value;
  const bound = await runtimeOperation(() => session.bindExtensions({ mode: "print" }));

  if (Result.isError(bound)) {
    session.dispose();
    return bound;
  }

  if (!TOOL_NAMES.every((name) => session.getActiveToolNames().includes(name))) {
    session.dispose();
    return Result.err(
      new BenchmarkError({ reason: "runtime", message: "The SDK did not activate every Hubble tool." })
    );
  }

  return Result.ok(session);
}

/** Checks projected tool metadata through its public unknown boundary. */
function verifyDetails(
  result: ToolResult,
  expected: Readonly<Record<string, string | number | boolean | undefined>>
): Verification {
  if (!Value.Check(Details, result.details)) {
    return check(false, "The tool did not return an object of details.");
  }

  for (const [key, value] of Object.entries(expected)) {
    if (result.details[key] !== value) {
      return check(false, `Unexpected tool metadata field: ${key}.`);
    }
  }

  return Result.ok();
}

function toolText(result: ToolResult): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

/** Reads the complete response, including the output file when the public tool truncates it. */
async function completeOutput(workspace: string, result: ToolResult): Promise<ResultType<string, BenchmarkError>> {
  if (!Value.Check(PersistedOutput, result.details)) {
    return Result.err(new BenchmarkError({ reason: "verification", message: "Invalid output persistence metadata." }));
  }

  const path = result.details.fullOutputPath;

  if (path === undefined) {
    return Result.ok(toolText(result));
  }

  if (!path.startsWith(`${workspace}${sep}output-`)) {
    return Result.err(
      new BenchmarkError({ reason: "verification", message: "Tool output escaped the scratch workspace." })
    );
  }

  return benchmarkFileOperation(path, () => fs.readFile(path, "utf8"));
}

async function readEquals(vault: Vault, path: string, expected: string): Promise<Verification> {
  const read = vaultResult(await vault.read(path));
  return Result.isError(read)
    ? read
    : check(read.value.content === expected, "Stored note contents did not match the expected document.");
}

async function expectMissing(vault: Vault, path: string): Promise<Verification> {
  const read = await vault.read(path);
  return check(
    Result.isError(read) && NoteNotFoundError.is(read.error),
    "Expected the note to be absent after mutation.",
    Result.isError(read) ? read.error : undefined
  );
}

async function removeNote(vault: Vault, path: string): Promise<Verification> {
  const removed = vaultResult(await vault.delete(path));
  return Result.isError(removed) ? removed : Result.ok();
}

/** Seeds one explicit note through the public Vault API rather than constructing branded paths or bypassing mutation queues. */
async function seed(
  vault: Vault,
  document: BenchmarkDocument,
  folder: string,
  filename: string
): Promise<Verification> {
  const created = vaultResult(await vault.create(document.title, document.content, folder, "markdown", filename));
  return Result.isError(created) ? created : Result.ok();
}

/** Seeds a stable corpus with one deterministic match per note and an independently predictable listing. */
async function fixtures(
  vault: Vault,
  document: BenchmarkDocument,
  notes: number,
  needles: SearchNeedles
): Promise<ResultType<string[], BenchmarkError>> {
  const synthetic = syntheticBenchmarkDocument();
  const matchingContent = `${needles.match}\n${synthetic.content}`.slice(0, synthetic.content.length);
  const matching = benchmarkDocument(synthetic.title, matchingContent);
  const listing = new Set<string>(["corpus/", "target/", "empty/"]);

  for (let index = 0; index < notes; index++) {
    const folder = `corpus/group-${String(index % 10).padStart(2, "0")}`;
    const filename = `note-${String(index).padStart(4, "0")}.md`;
    const made = await seed(vault, matching, folder, filename);

    if (Result.isError(made)) {
      return made;
    }

    listing.add(`${folder}/`);
    listing.add(`${folder}/${filename}`);
  }

  const large = syntheticBenchmarkDocument(262_144);
  const longContent = `${needles.longMatch} ${"x".repeat(65_536)}`;
  const targets = [
    { document, filename: "ticket.md" },
    { document: large, filename: "large.md" },
    { document: benchmarkDocument(synthetic.title, longContent), filename: "long-match.md" },
  ];

  for (const target of targets) {
    const made = await seed(vault, target.document, "target", target.filename);

    if (Result.isError(made)) {
      return made;
    }

    listing.add(`target/${target.filename}`);
  }

  const empty = await seed(vault, syntheticBenchmarkDocument(1_024), "empty", "temporary.md");

  if (Result.isError(empty)) {
    return empty;
  }

  const removed = await removeNote(vault, "empty/temporary.md");
  return Result.isError(removed) ? removed : Result.ok([...listing].sort((left, right) => left.localeCompare(right)));
}

/** Wraps successful outcomes for scenario-specific checks; unexpected structured failures still fail the benchmark. */
function success(verify: (index: number, result: ToolResult) => Promise<Verification>): Scenario["verify"] {
  return async (index, outcome) => (Result.isError(outcome) ? outcome : verify(index, outcome.value));
}

/** Confirms semantic failures retain their expected tag; a fast wrong failure is not a valid benchmark sample. */
function rejected(tag: string, verifyState?: () => Promise<Verification>): Scenario["verify"] {
  return async (_index, outcome) => {
    if (Result.isOk(outcome)) {
      return check(false, `Expected ${tag}, but the tool succeeded.`);
    }

    const cause = outcome.error.cause;
    const checked = check(
      outcome.error.reason === "operation" && Value.Check(FailureTag, cause) && cause._tag === tag,
      `Expected the tool to preserve ${tag}.`,
      outcome.error
    );
    return Result.isError(checked) || !verifyState ? checked : verifyState();
  };
}

/** Builds read, discovery, paginated search, mutation, truncation, and structured-failure workloads for all seven tools. */
function scenarios(
  workspace: string,
  vault: Vault,
  document: BenchmarkDocument,
  notes: number,
  listing: ReadonlyArray<string>,
  needles: SearchNeedles
): Scenario[] {
  const large = syntheticBenchmarkDocument(262_144);
  const small = syntheticBenchmarkDocument(1_024);
  const group = "corpus/group-00";
  const groupCount = Math.ceil(notes / 10);
  const corpusPaths = listing.filter((entry) => entry.startsWith("corpus/") && entry.endsWith(".md"));
  const groupPaths = corpusPaths.filter((entry) => entry.startsWith(`${group}/`));
  const pageLimit = Math.min(10, notes);
  const lateOffset = Math.max(1, notes - 9);
  const path = (index: number) => `mutations/sample-${index}.md`;
  const filename = (index: number) => `sample-${index}.md`;
  const prepare = (index: number) => seed(vault, document, "mutations", filename(index));
  const expectedListing = listing.join("\n");

  const listVerify = (expected: ReadonlyArray<string>, noteCount: number, directoryCount: number) =>
    success(async (_index, result) => {
      const details = verifyDetails(result, { noteCount, directoryCount });

      if (Result.isError(details)) {
        return details;
      }

      const output = await completeOutput(workspace, result);
      return Result.isError(output)
        ? output
        : check(output.value === expected.join("\n"), "Listing did not contain exactly the seeded paths.");
    });
  const searchVerify = (count: number, hasMore: boolean, offset: number, paths: ReadonlyArray<string> = corpusPaths) =>
    success(async (_index, result) => {
      const metadata =
        count === 0
          ? { matchCount: 0 }
          : { matchCount: count, hasMore, nextOffset: hasMore ? offset + count : undefined };
      const details = verifyDetails(result, metadata);

      if (Result.isError(details)) {
        return details;
      }

      if (count === 0) {
        return check(toolText(result) === "No Hubble notes matched the query.", "Expected an empty search response.");
      }

      const output = await completeOutput(workspace, result);

      if (Result.isError(output)) {
        return output;
      }

      const matches = output.value.split("\n").filter((line) => line.endsWith(`:3: ${needles.match}`));
      const expected = paths.slice(offset - 1, offset - 1 + count).map((path) => `${path}:3: ${needles.match}`);
      return check(
        matches.join("\n") === expected.join("\n"),
        "Search page did not return the expected fixture paths at this offset."
      );
    });
  const readVerify = (expected: BenchmarkDocument, notePath: string, offset = 1, limit?: number) =>
    success(async (_index, result) => {
      const lines = expected.document.split("\n");
      const selected = limit === undefined ? lines.slice(offset - 1) : lines.slice(offset - 1, offset - 1 + limit);
      const selectedText = selected.join("\n");
      const details = verifyDetails(result, {
        path: notePath,
        startLine: offset,
        returnedLines: selected.length,
        totalLines: lines.length,
        truncated: Buffer.byteLength(selectedText) > DEFAULT_MAX_BYTES || selected.length > DEFAULT_MAX_LINES,
      });

      if (Result.isError(details)) {
        return details;
      }

      const output = await completeOutput(workspace, result);

      if (Result.isError(output)) {
        return output;
      }

      const raw = Value.Check(PersistedOutput, result.details) && result.details.fullOutputPath !== undefined;
      return check(
        output.value === (raw ? selectedText : `Path: ${notePath}\n\n${selectedText}`),
        "Read output did not match the requested document slice."
      );
    });
  const creates = [small, document, large].map((item) => ({
    tool: "hubble_create" as const,
    name: item === document ? "ticket-sized" : item === large ? "256 KiB" : "1 KiB",
    bytes: item.bytes,
    args: (index: number) => ({
      title: item.title,
      content: item.content,
      folder: "mutations",
      filename: filename(index),
    }),
    verify: success(async (index, result) => {
      const details = verifyDetails(result, { path: path(index) });

      if (Result.isError(details)) {
        return details;
      }

      const checked = await readEquals(vault, path(index), item.document);
      return Result.isError(checked) ? checked : removeNote(vault, path(index));
    }),
  }));
  // Use a consistently LF scratch fixture for edits; supplied CRLF documents
  // otherwise acquire a mixed LF heading during creation and are restyled on edit.
  const editFixture = benchmarkDocument(document.title, document.content.replace(/\r\n?/gu, "\n"));
  const prepareEdit = (index: number) => seed(vault, editFixture, "mutations", filename(index));
  const header = `# ${editFixture.title.trim()}\n\n`;
  const editedDocument = editFixture.document.replace(header, "# Edited benchmark\n\n");
  // Unusual supplied documents can repeat their H1. Use the complete document
  // in that case so the edit remains a single, unambiguous exact match.
  const edit =
    editFixture.document.indexOf(header, header.length) === -1
      ? { oldText: header, newText: "# Edited benchmark\n\n" }
      : { oldText: editFixture.document, newText: editedDocument };
  const longOutput = `target/long-match.md:3: ${needles.longMatch} ${"x".repeat(65_536)}`;

  return [
    {
      tool: "hubble_list",
      name: "entire vault",
      bytes: Buffer.byteLength(expectedListing),
      args: () => ({}),
      verify: listVerify(listing, notes + 3, 3 + Math.min(notes, 10)),
    },
    {
      tool: "hubble_list",
      name: "scoped folder",
      bytes: Buffer.byteLength(
        listing.filter((entry) => entry.startsWith(`${group}/`) && entry !== `${group}/`).join("\n")
      ),
      args: () => ({ folder: group }),
      verify: listVerify(
        listing.filter((entry) => entry.startsWith(`${group}/`) && entry !== `${group}/`),
        groupCount,
        0
      ),
    },
    {
      tool: "hubble_list",
      name: "empty folder",
      bytes: 0,
      args: () => ({ folder: "empty" }),
      verify: success(async (_index, result) =>
        verifyDetails(result, { noteCount: 0, directoryCount: 0, truncated: false })
      ),
    },
    {
      tool: "hubble_search",
      name: "first page (10 matches)",
      bytes: 23_688,
      args: () => ({ query: needles.match, limit: pageLimit }),
      verify: searchVerify(pageLimit, notes > pageLimit, 1),
    },
    {
      tool: "hubble_search",
      name: "late page",
      bytes: 23_688,
      args: () => ({ query: needles.match, offset: lateOffset, limit: 10 }),
      verify: searchVerify(notes - lateOffset + 1, false, lateOffset),
    },
    {
      tool: "hubble_search",
      name: "scoped folder",
      bytes: 23_688,
      args: () => ({ query: needles.match, folder: group, limit: 500 }),
      verify: searchVerify(groupCount, false, 1, groupPaths),
    },
    {
      tool: "hubble_search",
      name: "no matches (full scan)",
      bytes: 23_688,
      args: () => ({ query: needles.absent }),
      verify: searchVerify(0, false, 1),
    },
    {
      tool: "hubble_search",
      name: "oversized matching line",
      bytes: Buffer.byteLength(longOutput),
      args: () => ({ query: needles.longMatch, folder: "target" }),
      verify: success(async (_index, result) => {
        const details = verifyDetails(result, { matchCount: 1, hasMore: false, truncated: true });

        if (Result.isError(details)) return details;

        const output = await completeOutput(workspace, result);
        return Result.isError(output)
          ? output
          : check(output.value === longOutput, "Persisted search output did not contain the full matching line.");
      }),
    },
    {
      tool: "hubble_read",
      name: "ticket-sized",
      bytes: document.bytes,
      args: () => ({ path: "target/ticket.md" }),
      verify: readVerify(document, "target/ticket.md"),
    },
    {
      tool: "hubble_read",
      name: "20-line window",
      bytes: document.bytes,
      args: () => ({ path: "target/ticket.md", offset: 3, limit: 20 }),
      verify: readVerify(document, "target/ticket.md", 3, 20),
    },
    {
      tool: "hubble_read",
      name: "256 KiB (truncated output)",
      bytes: large.bytes,
      args: () => ({ path: "target/large.md" }),
      verify: readVerify(large, "target/large.md"),
    },
    ...creates,
    {
      tool: "hubble_create",
      name: "HTML document",
      bytes: Buffer.byteLength(buildNewNoteDocument(document.title, document.content, "html")),
      args: (index) => ({
        title: document.title,
        content: document.content,
        filename: `sample-${index}.html`,
        folder: "mutations",
      }),
      verify: success(async (index, result) => {
        const htmlPath = `mutations/sample-${index}.html`;
        const details = verifyDetails(result, { path: htmlPath });

        if (Result.isError(details)) return details;

        const checked = await readEquals(
          vault,
          htmlPath,
          buildNewNoteDocument(document.title, document.content, "html")
        );
        return Result.isError(checked) ? checked : removeNote(vault, htmlPath);
      }),
    },
    {
      tool: "hubble_edit",
      name: "ticket-sized atomic edit",
      bytes: editFixture.bytes,
      prepare: prepareEdit,
      args: (index) => ({
        path: path(index),
        edits: [edit],
      }),
      verify: success(async (index, result) => {
        const details = verifyDetails(result, { path: path(index), editCount: 1 });

        if (Result.isError(details)) return details;

        const checked = await readEquals(vault, path(index), editedDocument);
        return Result.isError(checked) ? checked : removeNote(vault, path(index));
      }),
    },
    {
      tool: "hubble_move",
      name: "ticket-sized nested move",
      bytes: document.bytes,
      prepare,
      args: (index) => ({ path: path(index), destination: `archive/nested/${filename(index)}` }),
      verify: success(async (index, result) => {
        const destination = `archive/nested/${filename(index)}`;
        const details = verifyDetails(result, { source: path(index), path: destination });

        if (Result.isError(details)) return details;

        const checked = await readEquals(vault, destination, document.document);

        if (Result.isError(checked)) return checked;

        const absent = await expectMissing(vault, path(index));
        return Result.isError(absent) ? absent : removeNote(vault, destination);
      }),
    },
    {
      tool: "hubble_delete",
      name: "ticket-sized delete",
      bytes: document.bytes,
      prepare,
      args: (index) => ({ path: path(index) }),
      verify: success(async (index, result) => {
        const details = verifyDetails(result, { path: path(index) });
        return Result.isError(details) ? details : expectMissing(vault, path(index));
      }),
    },
    {
      tool: "hubble_list",
      name: "reject traversal",
      bytes: 0,
      args: () => ({ folder: "../outside" }),
      verify: rejected("VaultPathError"),
    },
    {
      tool: "hubble_search",
      name: "reject empty query",
      bytes: 0,
      args: () => ({ query: " " }),
      verify: rejected("NoteValidationError"),
    },
    {
      tool: "hubble_read",
      name: "missing note",
      bytes: 0,
      args: () => ({ path: "missing.md" }),
      verify: rejected("NoteNotFoundError"),
    },
    {
      tool: "hubble_create",
      name: "existing exact filename",
      bytes: document.bytes,
      args: () => ({ title: document.title, content: document.content, folder: "target", filename: "ticket.md" }),
      verify: rejected("NoteWriteError", () => readEquals(vault, "target/ticket.md", document.document)),
    },
    {
      tool: "hubble_edit",
      name: "missing exact match",
      bytes: document.bytes,
      args: () => ({
        path: "target/ticket.md",
        edits: [{ oldText: `${document.document}\nextra`, newText: "replacement" }],
      }),
      verify: rejected("EditValidationError", () => readEquals(vault, "target/ticket.md", document.document)),
    },
    {
      tool: "hubble_move",
      name: "existing destination",
      bytes: document.bytes,
      args: () => ({ path: "target/ticket.md", destination: "target/large.md" }),
      verify: rejected("NoteMoveError", async () => {
        const source = await readEquals(vault, "target/ticket.md", document.document);
        return Result.isError(source) ? source : readEquals(vault, "target/large.md", large.document);
      }),
    },
    {
      tool: "hubble_delete",
      name: "missing note",
      bytes: 0,
      args: () => ({ path: "missing.md" }),
      verify: rejected("NoteNotFoundError"),
    },
  ];
}

/** Measures only validated bound-tool invocation; fixture reset, result verification, and output cleanup are excluded. */
async function measure(
  workspace: string,
  document: BenchmarkDocument,
  options: BenchmarkOptions
): Promise<ResultType<string, BenchmarkError>> {
  const opened = vaultResult(await Vault.open(join(workspace, "vault")));

  if (Result.isError(opened)) {
    return opened;
  }

  const vault = opened.value;
  const needles = searchNeedles(document);
  const seeded = await fixtures(vault, document, options.notes, needles);

  if (Result.isError(seeded)) {
    return seeded;
  }

  const runtime = await openRuntime(workspace, vault);

  if (Result.isError(runtime)) {
    return runtime;
  }

  const session = runtime.value;
  const rows: string[] = [];
  try {
    for (const scenario of scenarios(workspace, vault, document, options.notes, seeded.value, needles)) {
      const tool = session.agent.state.tools.find((candidate) => candidate.name === scenario.tool);

      if (!tool) {
        throw new Error(`Validated tool ${scenario.tool} disappeared from the SDK runtime.`);
      }

      const samples: number[] = [];
      for (let index = -2; index < options.iterations; index++) {
        const prepared = scenario.prepare ? await scenario.prepare(index) : Result.ok();

        if (Result.isError(prepared)) {
          return prepared;
        }

        const args = scenario.args(index);
        const start = performance.now();
        const outcome = await invoke(tool, args);
        const elapsed = performance.now() - start;
        const verified = await scenario.verify(index, outcome);

        if (Result.isError(verified)) {
          return Result.err(
            new BenchmarkError({
              reason: verified.error.reason,
              cause: verified.error,
              message: `${scenario.tool} (${scenario.name}): ${verified.error.message}`,
            })
          );
        }

        if (index >= 0) {
          samples.push(elapsed);
        }
      }

      rows.push(benchmarkSummary(`${scenario.tool}: ${scenario.name}`, scenario.bytes, samples, 52));
    }
  } finally {
    session.dispose();
  }

  return Result.ok(
    [
      `Node ${process.version}; ${process.platform}/${process.arch}; ${options.iterations} measured iterations; two warmups per scenario.`,
      `Corpus: ${options.notes} synthetic 23,688-byte notes, plus 3 target notes; ticket payload: ${document.bytes} bytes.`,
      "Includes input preparation/validation, bound SDK tool execution, response formatting, and output persistence.",
      "Excludes fixture setup/reset, verification, SDK startup, cleanup, rendering, model generation, and network latency.",
      "Bytes describe payload size (per corpus note for search) or complete response size for listing/long-match search.",
      "Scenario                                                bytes  median ms     p95 ms",
      ...rows,
    ].join("\n")
  );
}

/**
 * Benchmarks all seven registered Hubble tools in an offline Pi SDK runtime, returning a report or structured benchmark failure.
 * Supports shared --iterations/--source/--temp-parent options and --notes (1–5000) for corpus scaling.
 * Reads sources without modifying them and removes the isolated vault, SDK resources, and persisted oversized outputs afterward.
 */
export function runToolBenchmark(
  args: ReadonlyArray<string>,
  fileSystem?: BenchmarkFileSystem
): Promise<ResultType<string, BenchmarkError>> {
  return runInBenchmarkWorkspace(args, measure, fileSystem);
}
