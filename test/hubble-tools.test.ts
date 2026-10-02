import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, test } from "vitest";

import type { GetVault } from "../extensions/hubble-config.ts";
import { type OutputFileSystem, registerHubbleTools } from "../extensions/hubble-tools.ts";
import { openVault } from "../extensions/hubble-vault.ts";
import { testCast } from "./test-cast.ts";

type ToolResult = { content: Array<{ type?: "text"; text: string }>; details: object };

type RegisteredTestTool = Pick<ToolDefinition, "execute" | "prepareArguments" | "renderCall" | "renderResult">;

type HubbleToolName =
  | "hubble_list"
  | "hubble_search"
  | "hubble_read"
  | "hubble_create"
  | "hubble_move"
  | "hubble_delete"
  | "hubble_edit";
interface RegisteredHubbleTools {
  readonly hubble_list: RegisteredTestTool;
  readonly hubble_search: RegisteredTestTool;
  readonly hubble_read: RegisteredTestTool;
  readonly hubble_create: RegisteredTestTool;
  readonly hubble_move: RegisteredTestTool;
  readonly hubble_delete: RegisteredTestTool;
  readonly hubble_edit: RegisteredTestTool;
}

type RenderComponent = { render(width: number): string[] };
type RenderTheme = {
  fg(_color: string, text: string): string;
  bold(text: string): string;
};
type RenderContext = {
  expanded: boolean;
  isError: boolean;
  lastComponent: RenderComponent | undefined;
};

type HubbleCreateRenderArguments = {
  readonly title?: string;
  readonly content?: string;
  readonly filename?: string;
  readonly folder?: string;
  readonly format?: "markdown" | "html";
};

function register(getVault: GetVault, outputFileSystem?: OutputFileSystem): RegisteredHubbleTools {
  const tools: Partial<Record<HubbleToolName, RegisteredTestTool>> = {};
  const pi = {
    registerTool(tool: RegisteredTestTool & { name: HubbleToolName }) {
      tools[tool.name] = tool;
    },
  };
  registerHubbleTools(testCast<typeof pi, ExtensionAPI>(pi), getVault, outputFileSystem);

  const registeredTool = (name: HubbleToolName): RegisteredTestTool => {
    const tool = tools[name];

    if (tool === undefined) {
      throw new Error(`${name} was not registered`);
    }

    return tool;
  };
  return {
    hubble_list: registeredTool("hubble_list"),
    hubble_search: registeredTool("hubble_search"),
    hubble_read: registeredTool("hubble_read"),
    hubble_create: registeredTool("hubble_create"),
    hubble_move: registeredTool("hubble_move"),
    hubble_delete: registeredTool("hubble_delete"),
    hubble_edit: registeredTool("hubble_edit"),
  };
}

const focusedContext = { cwd: process.cwd(), isProjectTrusted: () => true };
const context = testCast<typeof focusedContext, ExtensionContext>(focusedContext);
const renderTheme: RenderTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function firstText(result: Awaited<ReturnType<RegisteredTestTool["execute"]>>): string | undefined {
  const content = result.content.at(0);
  return content?.type === "text" ? content.text : undefined;
}

function plainRender(component: RenderComponent): string {
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return component.render(200).join("\n").replaceAll(ansiColor, "");
}

test("executes list, create, read, edit, and search tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-"));
  const tools = register(async () => openVault(root));
  expect(Object.keys(tools)).toEqual([
    "hubble_list",
    "hubble_search",
    "hubble_read",
    "hubble_create",
    "hubble_move",
    "hubble_delete",
    "hubble_edit",
  ]);

  const created = await tools.hubble_create.execute(
    "create",
    { title: "First Note", content: "Alpha\nBeta" },
    undefined,
    undefined,
    context
  );
  expect(firstText(created)).toBe("Created Hubble note: first-note.md");
  const path = join(root, "first-note.md");
  expect(await readFile(path, "utf8")).toBe("# First Note\n\nAlpha\nBeta");

  const listed = await tools.hubble_list.execute("list", {}, undefined, undefined, context);
  expect(firstText(listed)).toBe("first-note.md");
  expect(listed.details).toEqual({
    folder: undefined,
    noteCount: 1,
    directoryCount: 0,
    truncated: false,
    fullOutputPath: undefined,
  });

  const read = await tools.hubble_read.execute(
    "read",
    { path: "first-note.md", offset: 3, limit: 1 },
    undefined,
    undefined,
    context
  );
  expect(firstText(read)).toContain("Path: first-note.md\n\nAlpha");
  expect(read.details).toMatchObject({ path: "first-note.md", startLine: 3, returnedLines: 1 });

  const edited = await tools.hubble_edit.execute(
    "edit",
    {
      path: "first-note.md",
      edits: [
        { oldText: "Alpha", newText: "Updated" },
        { oldText: "Beta", newText: "Beta\nFinal" },
      ],
    },
    undefined,
    undefined,
    context
  );
  expect(edited.details).toEqual({ path: "first-note.md", editCount: 2 });
  expect(await readFile(path, "utf8")).toContain("Updated\nBeta\nFinal");

  const search = await tools.hubble_search.execute(
    "search",
    { query: "updated", limit: 10 },
    undefined,
    undefined,
    context
  );
  expect(firstText(search)).toContain("first-note.md:3: Updated");
  expect(search.details).toMatchObject({ query: "updated", matchCount: 1, truncated: false });
});

test("lists a recursive folder scope without scanning unrelated entries into the result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-list-folder-"));
  const vault = await openVault(root);

  if (vault.status === "error") {
    throw vault.error;
  }

  await vault.value.create("Direct", "body", "projects");
  await vault.value.create("Nested", "body", "projects/archive");
  await vault.value.create("Outside", "body", "other");
  const tools = register(async () => vault);
  const folder = "@hubble/projects/";
  const listed = await tools.hubble_list.execute("list-folder", { folder }, undefined, undefined, context);

  expect(firstText(listed)).toBe("projects/archive/\nprojects/archive/nested.md\nprojects/direct.md");
  expect(listed.details).toEqual({
    folder,
    noteCount: 2,
    directoryCount: 1,
    truncated: false,
    fullOutputPath: undefined,
  });
});

test("moves and permanently deletes notes through tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-move-delete-"));
  const vault = await openVault(root);

  if (vault.status === "error") {
    throw vault.error;
  }

  await vault.value.create("Source", "body", "inbox");
  await vault.value.create("Archive Placeholder", "body", "archive");
  const tools = register(async () => vault);
  const moved = await tools.hubble_move.execute(
    "move",
    { path: "inbox/source.md", destination: "archive/source-renamed.md" },
    undefined,
    undefined,
    context
  );

  expect(firstText(moved)).toBe("Moved Hubble note: inbox/source.md → archive/source-renamed.md");
  expect(moved.details).toEqual({ source: "inbox/source.md", path: "archive/source-renamed.md" });
  expect(await readFile(join(root, "archive", "source-renamed.md"), "utf8")).toContain("# Source");

  const deleted = await tools.hubble_delete.execute(
    "delete",
    { path: "archive/source-renamed.md" },
    undefined,
    undefined,
    context
  );
  expect(firstText(deleted)).toBe("Deleted Hubble note: archive/source-renamed.md");
  await expect(readFile(join(root, "archive", "source-renamed.md"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("returns whitespace diagnostics from exact-edit tool failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-edit-diagnostic-"));
  const vault = await openVault(root);

  if (vault.status === "error") {
    throw vault.error;
  }

  await vault.value.create("Tasks", "Alpha  \nBeta");
  const tools = register(async () => vault);

  await expect(
    tools.hubble_edit.execute(
      "edit",
      { path: "tasks.md", edits: [{ oldText: "Alpha\nBeta", newText: "Done" }] },
      undefined,
      undefined,
      context
    )
  ).rejects.toThrow(/line 3, column 1.*Visible whitespace uses · for spaces/su);
});

test("passes autocomplete folder references directly to hubble_create", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-folder-reference-"));
  const tools = register(async () => openVault(root));
  const created = await tools.hubble_create.execute(
    "create-reference",
    { title: "Referenced", content: "body", folder: '"@hubble/incident response/"' },
    undefined,
    undefined,
    context
  );

  expect(firstText(created)).toBe("Created Hubble note: incident response/referenced.md");
  expect(await readFile(join(root, "incident response", "referenced.md"), "utf8")).toContain("# Referenced");
});

test("restricts tool search recursively to an autocomplete folder reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-search-folder-"));
  const vault = await openVault(root);

  if (vault.status === "error") {
    throw vault.error;
  }

  await vault.value.create("Direct", "flat growth direct", "effect prophet/tickets");
  await vault.value.create("Nested", "flat growth nested", "effect prophet/tickets/TODO");
  await vault.value.create("Outside", "flat growth outside", "effect prophet");
  const tools = register(async () => vault);
  const folder = '"@hubble/effect prophet/tickets/"';
  const search = await tools.hubble_search.execute(
    "search-folder",
    { query: "flat growth", folder },
    undefined,
    undefined,
    context
  );
  const text = firstText(search);

  expect(text).toContain("effect prophet/tickets/direct.md:3: flat growth direct");
  expect(text).toContain("effect prophet/tickets/TODO/nested.md:3: flat growth nested");
  expect(text).not.toContain("effect prophet/outside.md");
  expect(search.details).toMatchObject({ folder, query: "flat growth", matchCount: 2, truncated: false });
});

test("renders expandable Markdown and HTML create previews with resolved success paths", async () => {
  initTheme("dark");
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-render-"));
  const tools = register(async () => openVault(root));
  const registeredRenderCall = tools.hubble_create.renderCall;
  const registeredRenderResult = tools.hubble_create.renderResult;

  if (registeredRenderCall === undefined || registeredRenderResult === undefined) {
    throw new Error("hubble_create did not register its renderers");
  }

  const renderCall = testCast<
    typeof registeredRenderCall,
    (args: HubbleCreateRenderArguments, theme: RenderTheme, context: RenderContext) => RenderComponent
  >(registeredRenderCall);
  const renderResult = testCast<
    typeof registeredRenderResult,
    (
      result: ToolResult,
      options: { expanded: boolean; isPartial: boolean },
      theme: RenderTheme,
      context: RenderContext
    ) => RenderComponent
  >(registeredRenderResult);
  const collapsedContext = { expanded: false, isError: false, lastComponent: undefined };
  const markdown = plainRender(
    renderCall(
      {
        title: "Preview Note",
        content: Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join("\n"),
      },
      renderTheme,
      collapsedContext
    )
  );
  expect(markdown).toContain('hubble_create "Preview Note" → vault root (markdown)');
  expect(markdown).toContain("# Preview Note");
  expect(markdown).toContain("more lines");
  expect(markdown).not.toContain("Line 12");

  const html = plainRender(
    renderCall(
      { title: "HTML & Preview", content: "<p>Alpha</p>", filename: "preview-page.html", folder: "web" },
      renderTheme,
      {
        ...collapsedContext,
        expanded: true,
      }
    )
  );
  expect(html).toContain('hubble_create "HTML & Preview" → web/preview-page.html (html)');
  expect(html).toContain("<!doctype html>");
  expect(html).toContain("<title>HTML &amp; Preview</title>");
  expect(html).toContain("<p>Alpha</p>");

  const success = plainRender(
    renderResult(
      {
        content: [{ type: "text", text: "Created Hubble note: preview-note-2.md" }],
        details: { path: "preview-note-2.md" },
      },
      { expanded: false, isPartial: false },
      renderTheme,
      collapsedContext
    )
  );
  expect(success).toContain("✓ Created preview-note-2.md");
});

test("renders structured create failures", async () => {
  initTheme("dark");
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-render-error-"));
  const tools = register(async () => openVault(root));
  const registeredRenderResult = tools.hubble_create.renderResult;

  if (registeredRenderResult === undefined) {
    throw new Error("hubble_create did not register renderResult");
  }

  const renderResult = testCast<
    typeof registeredRenderResult,
    (
      result: ToolResult,
      options: { expanded: boolean; isPartial: boolean },
      theme: RenderTheme,
      context: RenderContext
    ) => RenderComponent
  >(registeredRenderResult);
  const rendered = plainRender(
    renderResult(
      { content: [{ type: "text", text: "Could not create the Hubble note." }], details: {} },
      { expanded: false, isPartial: false },
      renderTheme,
      { expanded: false, isError: true, lastComponent: undefined }
    )
  );
  expect(rendered).toContain("Could not create the Hubble note.");
});

test("normalizes stringified and legacy edit arguments like Pi's built-in edit tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-arguments-"));
  const tools = register(async () => openVault(root));
  const prepare = tools.hubble_edit.prepareArguments;

  if (!prepare) {
    throw new Error("hubble_edit did not register prepareArguments");
  }

  expect(prepare({ path: "note.md", edits: '[{"oldText":"Alpha","newText":"Beta"}]' })).toEqual({
    path: "note.md",
    edits: [{ oldText: "Alpha", newText: "Beta" }],
  });
  expect(prepare({ path: "note.md", oldText: "Alpha", newText: "Beta" })).toEqual({
    path: "note.md",
    edits: [{ oldText: "Alpha", newText: "Beta" }],
  });
});

test("creates, reads, edits, and searches HTML through tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-html-tools-"));
  const tools = register(async () => openVault(root));
  const created = await tools.hubble_create.execute(
    "create-html",
    { title: "HTML & Tools", content: "<p>Alpha</p>", filename: "custom-tools.html", folder: "web" },
    undefined,
    undefined,
    context
  );
  expect(firstText(created)).toBe("Created Hubble note: web/custom-tools.html");
  const path = join(root, "web", "custom-tools.html");
  expect(await readFile(path, "utf8")).toContain("<title>HTML &amp; Tools</title>");

  const read = await tools.hubble_read.execute(
    "read-html",
    { path: "web/custom-tools.html" },
    undefined,
    undefined,
    context
  );
  expect(firstText(read)).toContain("Path: web/custom-tools.html");
  expect(firstText(read)).toContain("<p>Alpha</p>");

  await tools.hubble_edit.execute(
    "edit-html",
    { path: "web/custom-tools.html", edits: [{ oldText: "Alpha", newText: "Updated" }] },
    undefined,
    undefined,
    context
  );
  const search = await tools.hubble_search.execute(
    "search-html",
    { query: "updated", limit: 10 },
    undefined,
    undefined,
    context
  );
  expect(firstText(search)).toContain("web/custom-tools.html:9: <p>Updated</p>");
});

test("reports validation failures and honors cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-errors-"));
  const tools = register(async () => openVault(root));
  await expect(tools.hubble_search.execute("search", { query: "   " }, undefined, undefined, context)).rejects.toThrow(
    "query must not be empty."
  );
  await expect(
    tools.hubble_read.execute("read", { path: "not-a-note.txt" }, undefined, undefined, context)
  ).rejects.toThrow("supported format");
  await expect(
    tools.hubble_search.execute(
      "search-folder",
      { query: "anything", folder: "../outside" },
      undefined,
      undefined,
      context
    )
  ).rejects.toThrow("escapes the vault");
  await expect(
    tools.hubble_list.execute("list-folder", { folder: "../outside" }, undefined, undefined, context)
  ).rejects.toThrow("escapes the vault");
  await expect(
    tools.hubble_list.execute("list-missing-folder", { folder: "missing" }, undefined, undefined, context)
  ).rejects.toThrow("The requested Hubble folder does not exist.");

  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    tools.hubble_search.execute("search", { query: "anything" }, controller.signal, undefined, context)
  ).rejects.toThrow("cancelled");
});

test("reports omitted search matches and allows retrieving every page", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-search-page-"));
  const vault = await openVault(root);

  if (vault.status === "error") {
    throw vault.error;
  }

  await vault.value.create("Matches", "match one\nmatch two\nmatch three");
  const tools = register(async () => vault);
  const first = await tools.hubble_search.execute("page", { query: "match ", limit: 2 }, undefined, undefined, context);
  // The title matches the trimmed query too; all matching lines participate in pagination.
  expect(first.details).toMatchObject({ matchCount: 2, hasMore: true, truncated: true, nextOffset: 3 });
  expect(firstText(first)).toContain("offset: 3");
  const next = await tools.hubble_search.execute(
    "page",
    { query: "match ", limit: 2, offset: 3 },
    undefined,
    undefined,
    context
  );
  expect(next.details).toMatchObject({ matchCount: 2, hasMore: false, truncated: false });
  expect(firstText(next)).toContain("match two");
  expect(firstText(next)).toContain("match three");
  const end = await tools.hubble_search.execute("page", { query: "match", offset: 5 }, undefined, undefined, context);
  expect(firstText(end)).toBe("No more Hubble matches at this offset.");
});

test.each(["hubble_list", "hubble_search", "hubble_read"] as const)(
  "%s persists oversized responses through the supplied filesystem and preserves its failures",
  async (name) => {
    const base = await mkdtemp(join(tmpdir(), "hubble-tool-output-"));
    const root = join(base, "vault");
    await mkdir(root);
    const content = "# Long response\n\noutput-needle " + "x".repeat(65_536);
    await writeFile(join(root, "long.md"), content);

    if (name === "hubble_list") {
      for (let index = 0; index < 2_001; index++) {
        await writeFile(join(root, `fixture-${index}.md`), "fixture");
      }
    }

    try {
      const opened = await openVault(root);
      const args =
        name === "hubble_list" ? {} : name === "hubble_search" ? { query: "output-needle" } : { path: "long.md" };
      const tools = register(async () => opened, {
        mkdtemp: () => mkdtemp(join(base, "output-")),
        writeFile,
      });
      const result = await tools[name].execute("oversized", args, undefined, undefined, context);
      const detailsSchema = Type.Object(
        { truncated: Type.Literal(true), fullOutputPath: Type.String() },
        { additionalProperties: true }
      );
      expect(Value.Check(detailsSchema, result.details)).toBe(true);

      if (!Value.Check(detailsSchema, result.details)) {
        throw new Error("Expected persisted-output details");
      }

      expect(result.details.fullOutputPath.startsWith(join(base, "output-"))).toBe(true);
      const output = await readFile(result.details.fullOutputPath, "utf8");
      if (name !== "hubble_list") {
        expect(output.length).toBeGreaterThan(50_000);
      }

      if (name === "hubble_read") {
        expect(output).toBe(content);
      } else if (name === "hubble_search") {
        expect(output).toBe(`long.md:3: output-needle ${"x".repeat(65_536)}`);
      } else {
        expect(output.split("\n")).toHaveLength(2_002);
        expect(output).toContain("fixture-2000.md");
      }

      const cause = Object.assign(new Error("output permission denied"), { code: "EACCES" });
      const failingTools = register(async () => opened, {
        async mkdtemp() {
          throw cause;
        },
        writeFile,
      });
      await expect(
        failingTools[name].execute("oversized-failure", args, undefined, undefined, context)
      ).rejects.toMatchObject({ cause: { _tag: "OutputPersistenceError", cause } });
      expect(await readFile(join(root, "long.md"), "utf8")).toBe(content);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
);
