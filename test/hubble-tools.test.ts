import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import type { GetVault } from "../extensions/hubble-config.ts";
import { registerHubbleTools } from "../extensions/hubble-tools.ts";
import { openVault } from "../extensions/hubble-vault.ts";

type ToolResult = { content: Array<{ type?: "text"; text: string }>; details: unknown };

type ToolExecutor = (...args: unknown[]) => Promise<ToolResult>;

type RegisteredTestTool = {
  execute: ToolExecutor;
  prepareArguments?: (input: unknown) => unknown;
  renderCall?: unknown;
  renderResult?: unknown;
};

type HubbleToolName = "hubble_search" | "hubble_read" | "hubble_create" | "hubble_edit";
type RegisteredHubbleTools = Readonly<Record<HubbleToolName, RegisteredTestTool>>;

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

function register(getVault: GetVault): RegisteredHubbleTools {
  const tools: Partial<Record<HubbleToolName, RegisteredTestTool>> = {};
  const pi = {
    registerTool(tool: {
      name: HubbleToolName;
      execute: ToolExecutor;
      prepareArguments?: (input: unknown) => unknown;
      renderCall?: unknown;
      renderResult?: unknown;
    }) {
      tools[tool.name] = tool;
    },
  };
  registerHubbleTools(pi as unknown as ExtensionAPI, getVault);

  const registeredTool = (name: HubbleToolName): RegisteredTestTool => {
    const tool = tools[name];
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  };
  return {
    hubble_search: registeredTool("hubble_search"),
    hubble_read: registeredTool("hubble_read"),
    hubble_create: registeredTool("hubble_create"),
    hubble_edit: registeredTool("hubble_edit"),
  };
}

const context = { cwd: process.cwd(), isProjectTrusted: () => true };
const renderTheme: RenderTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function plainRender(component: RenderComponent): string {
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return component.render(200).join("\n").replaceAll(ansiColor, "");
}

test("executes create, read, edit, and search tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-"));
  const tools = register(async () => openVault(root));
  expect(Object.keys(tools)).toEqual(["hubble_search", "hubble_read", "hubble_create", "hubble_edit"]);

  const created = await tools.hubble_create.execute(
    "create",
    { title: "First Note", content: "Alpha\nBeta" },
    undefined,
    undefined,
    context
  );
  expect(created.content.at(0)?.text).toBe("Created Hubble note: first-note.md");
  const path = join(root, "first-note.md");
  expect(await readFile(path, "utf8")).toBe("# First Note\n\nAlpha\nBeta");

  const read = await tools.hubble_read.execute(
    "read",
    { path: "first-note.md", offset: 3, limit: 1 },
    undefined,
    undefined,
    context
  );
  expect(read.content.at(0)?.text).toContain("Path: first-note.md\n\nAlpha");
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
  expect(search.content.at(0)?.text).toContain("first-note.md:3: Updated");
  expect(search.details).toMatchObject({ query: "updated", matchCount: 1, truncated: false });
});

test("renders expandable Markdown and HTML create previews with resolved success paths", async () => {
  initTheme("dark");
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-render-"));
  const tools = register(async () => openVault(root));
  const renderCall = tools.hubble_create.renderCall as (
    args: HubbleCreateRenderArguments,
    theme: RenderTheme,
    context: RenderContext
  ) => RenderComponent;
  const renderResult = tools.hubble_create.renderResult as (
    result: ToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: RenderTheme,
    context: RenderContext
  ) => RenderComponent;
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
  const renderResult = tools.hubble_create.renderResult as (
    result: ToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: RenderTheme,
    context: RenderContext
  ) => RenderComponent;
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
  if (!prepare) throw new Error("hubble_edit did not register prepareArguments");

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
  expect(created.content.at(0)?.text).toBe("Created Hubble note: web/custom-tools.html");
  const path = join(root, "web", "custom-tools.html");
  expect(await readFile(path, "utf8")).toContain("<title>HTML &amp; Tools</title>");

  const read = await tools.hubble_read.execute(
    "read-html",
    { path: "web/custom-tools.html" },
    undefined,
    undefined,
    context
  );
  expect(read.content.at(0)?.text).toContain("Path: web/custom-tools.html");
  expect(read.content.at(0)?.text).toContain("<p>Alpha</p>");

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
  expect(search.content.at(0)?.text).toContain("web/custom-tools.html:9: <p>Updated</p>");
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

  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    tools.hubble_search.execute("search", { query: "anything" }, controller.signal, undefined, context)
  ).rejects.toThrow("cancelled");
});
