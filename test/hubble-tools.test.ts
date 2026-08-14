import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import type { GetVault } from "../extensions/hubble-config.ts";
import { registerHubbleTools } from "../extensions/hubble-tools.ts";
import { openVault } from "../extensions/hubble-vault.ts";

type ToolResult = { content: Array<{ text: string }>; details: unknown };

type ToolExecutor = (...args: unknown[]) => Promise<ToolResult>;

type RegisteredTestTool = { execute: ToolExecutor };

function register(getVault: GetVault) {
  const tools: Record<string, RegisteredTestTool> = {};
  const pi = {
    registerTool(tool: { name: string; execute: ToolExecutor }) {
      tools[tool.name] = tool;
    },
  };
  registerHubbleTools(pi as unknown as ExtensionAPI, getVault);
  return tools;
}

const context = { cwd: process.cwd(), isProjectTrusted: () => true };

test("executes create, read, edit, append, and search tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-tools-"));
  const tools = register(async () => openVault(root));
  expect(Object.keys(tools)).toEqual(["hubble_search", "hubble_read", "hubble_create", "hubble_edit", "hubble_append"]);

  const created = await tools.hubble_create.execute(
    "create",
    { title: "First Note", content: "Alpha\nBeta" },
    undefined,
    undefined,
    context
  );
  expect(created.content[0].text).toBe("Created Hubble note: first-note.md");
  const path = join(root, "first-note.md");
  expect(await readFile(path, "utf8")).toBe("# First Note\n\nAlpha\nBeta");

  const read = await tools.hubble_read.execute(
    "read",
    { path: "first-note.md", offset: 3, limit: 1 },
    undefined,
    undefined,
    context
  );
  expect(read.content[0].text).toContain("Path: first-note.md\n\nAlpha");
  expect(read.details).toMatchObject({ path: "first-note.md", startLine: 3, returnedLines: 1 });

  const edited = await tools.hubble_edit.execute(
    "edit",
    { path: "first-note.md", edits: [{ oldText: "Alpha", newText: "Updated" }] },
    undefined,
    undefined,
    context
  );
  expect(edited.details).toEqual({ path: "first-note.md", editCount: 1 });

  const appended = await tools.hubble_append.execute(
    "append",
    { path: "first-note.md", content: "Final" },
    undefined,
    undefined,
    context
  );
  expect(appended.details).toEqual({ path: "first-note.md" });
  expect(await readFile(path, "utf8")).toContain("Updated\nBeta\nFinal");

  const search = await tools.hubble_search.execute(
    "search",
    { query: "updated", limit: 10 },
    undefined,
    undefined,
    context
  );
  expect(search.content[0].text).toContain("first-note.md:3: Updated");
  expect(search.details).toMatchObject({ query: "updated", matchCount: 1, truncated: false });
});

test("creates, reads, edits, and searches HTML through tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-html-tools-"));
  const tools = register(async () => openVault(root));
  const created = await tools.hubble_create.execute(
    "create-html",
    { title: "HTML & Tools", content: "<p>Alpha</p>", folder: "web", format: "html" },
    undefined,
    undefined,
    context
  );
  expect(created.content[0].text).toBe("Created Hubble note: web/html-and-tools.html");
  const path = join(root, "web", "html-and-tools.html");
  expect(await readFile(path, "utf8")).toContain("<title>HTML &amp; Tools</title>");

  const read = await tools.hubble_read.execute(
    "read-html",
    { path: "web/html-and-tools.html" },
    undefined,
    undefined,
    context
  );
  expect(read.content[0].text).toContain("Path: web/html-and-tools.html");
  expect(read.content[0].text).toContain("<p>Alpha</p>");

  await tools.hubble_edit.execute(
    "edit-html",
    { path: "web/html-and-tools.html", edits: [{ oldText: "Alpha", newText: "Updated" }] },
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
  expect(search.content[0].text).toContain("web/html-and-tools.html:9: <p>Updated</p>");
  await expect(
    tools.hubble_append.execute(
      "append-html",
      { path: "web/html-and-tools.html", content: "<footer>Later</footer>" },
      undefined,
      undefined,
      context
    )
  ).rejects.toThrow("only supported for Markdown");
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
