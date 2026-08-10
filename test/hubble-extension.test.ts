import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import extension from "../extensions/hubble.ts";

type ToolExecutor = (...args: unknown[]) => Promise<unknown>;

test("registers the flag, command, autocomplete, and all tools lazily", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-extension-"));
  const flags: Array<{ name: string; options: unknown }> = [];
  const tools: Array<{ name: string; execute: ToolExecutor }> = [];
  const commands: string[] = [];
  const events: string[] = [];
  let getFlagCalls = 0;
  const pi = {
    registerFlag: (name: string, options: unknown) => flags.push({ name, options }),
    registerTool: (tool: { name: string; execute: ToolExecutor }) => tools.push(tool),
    registerCommand: (name: string) => commands.push(name),
    on: (event: string) => events.push(event),
    getFlag: () => {
      getFlagCalls++;
      return root;
    },
  };

  extension(pi as unknown as ExtensionAPI);
  expect(flags).toEqual([
    {
      name: "hubble-dir",
      options: { description: "Hubble vault root for this session (overrides Hubble config)", type: "string" },
    },
  ]);
  expect(commands).toEqual(["hubble"]);
  expect(events).toEqual(["session_start"]);
  expect(tools.map((tool) => tool.name)).toEqual([
    "hubble_search",
    "hubble_read",
    "hubble_create",
    "hubble_edit",
    "hubble_append",
  ]);
  expect(getFlagCalls).toBe(0);

  const context = { cwd: process.cwd(), isProjectTrusted: () => true };
  const createTool = tools.find((tool) => tool.name === "hubble_create");
  if (!createTool) throw new Error("hubble_create was not registered");
  await Promise.all([
    createTool.execute("create-1", { title: "Cached Root", content: "body" }, undefined, undefined, context),
    createTool.execute("create-2", { title: "Cached Root", content: "body" }, undefined, undefined, context),
  ]);
  expect(getFlagCalls).toBe(1);
  expect(await readFile(join(root, "cached-root.md"), "utf8")).toContain("# Cached Root");
  expect(await readFile(join(root, "cached-root-2.md"), "utf8")).toContain("# Cached Root");
});

test("retries root resolution after a failed attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-extension-retry-"));
  const tools: Array<{ name: string; execute: ToolExecutor }> = [];
  let flag: unknown = 42;
  let getFlagCalls = 0;
  const pi = {
    registerFlag: () => undefined,
    registerTool: (tool: { name: string; execute: ToolExecutor }) => tools.push(tool),
    registerCommand: () => undefined,
    on: () => undefined,
    getFlag: () => {
      getFlagCalls++;
      return flag;
    },
  };

  extension(pi as unknown as ExtensionAPI);
  const createTool = tools.find((tool) => tool.name === "hubble_create");
  if (!createTool) throw new Error("hubble_create was not registered");
  const context = { cwd: process.cwd(), isProjectTrusted: () => true };

  await expect(
    createTool.execute("failed", { title: "Retry Root", content: "body" }, undefined, undefined, context)
  ).rejects.toThrow("--hubble-dir requires a non-empty path");

  flag = root;
  await createTool.execute("retry", { title: "Retry Root", content: "body" }, undefined, undefined, context);

  expect(getFlagCalls).toBe(2);
  expect(await readFile(join(root, "retry-root.md"), "utf8")).toContain("# Retry Root");
});
