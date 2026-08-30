import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import extension from "../extensions/hubble.ts";
import { testCast } from "./test-cast.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolExecutor = RegisteredTool["execute"];
type FlagOptions = Parameters<ExtensionAPI["registerFlag"]>[1];

test("registers the flag, command, autocomplete, and all tools lazily", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-extension-"));
  const flags: Array<{ name: string; options: FlagOptions }> = [];
  const tools: Array<{ name: string; execute: ToolExecutor }> = [];
  const commands: string[] = [];
  const events: string[] = [];
  let getFlagCalls = 0;
  const pi = {
    registerFlag: (name: string, options: FlagOptions) => flags.push({ name, options }),
    registerTool: (tool: { name: string; execute: ToolExecutor }) => tools.push(tool),
    registerCommand: (name: string) => commands.push(name),
    on: (event: string) => events.push(event),
    getFlag: () => {
      getFlagCalls++;
      return root;
    },
  };

  extension(testCast<typeof pi, ExtensionAPI>(pi));
  expect(flags).toEqual([
    {
      name: "hubble-dir",
      options: { description: "Hubble vault root for this session (overrides Hubble config)", type: "string" },
    },
  ]);
  expect(commands).toEqual(["hubble"]);
  expect(events).toEqual(["session_start"]);
  expect(tools.map((tool) => tool.name)).toEqual(["hubble_search", "hubble_read", "hubble_create", "hubble_edit"]);
  expect(getFlagCalls).toBe(0);

  const context = { cwd: process.cwd(), isProjectTrusted: () => true };
  const executionContext = testCast<typeof context, ExtensionContext>(context);
  const createTool = tools.find((tool) => tool.name === "hubble_create");
  if (!createTool) throw new Error("hubble_create was not registered");
  await Promise.all([
    createTool.execute("create-1", { title: "Cached Root", content: "body" }, undefined, undefined, executionContext),
    createTool.execute("create-2", { title: "Cached Root", content: "body" }, undefined, undefined, executionContext),
  ]);
  expect(getFlagCalls).toBe(1);
  expect(await readFile(join(root, "cached-root.md"), "utf8")).toContain("# Cached Root");
  expect(await readFile(join(root, "cached-root-2.md"), "utf8")).toContain("# Cached Root");
});

test("retries root resolution after a failed attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-extension-retry-"));
  const tools: Array<{ name: string; execute: ToolExecutor }> = [];
  let flag: string | number = 42;
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

  extension(testCast<typeof pi, ExtensionAPI>(pi));
  const createTool = tools.find((tool) => tool.name === "hubble_create");
  if (!createTool) throw new Error("hubble_create was not registered");
  const context = { cwd: process.cwd(), isProjectTrusted: () => true };
  const executionContext = testCast<typeof context, ExtensionContext>(context);

  await expect(
    createTool.execute("failed", { title: "Retry Root", content: "body" }, undefined, undefined, executionContext)
  ).rejects.toThrow("--hubble-dir requires a non-empty path");

  flag = root;
  await createTool.execute("retry", { title: "Retry Root", content: "body" }, undefined, undefined, executionContext);

  expect(getFlagCalls).toBe(2);
  expect(await readFile(join(root, "retry-root.md"), "utf8")).toContain("# Retry Root");
});
