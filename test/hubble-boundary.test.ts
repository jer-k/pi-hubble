import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { expect, test } from "vitest";
import {
  attachmentValue,
  errorMessage,
  getToolVault,
  noteResult,
  SearchQueryError,
  throwHubbleError,
  throwIfAborted,
  unwrapToolResult,
} from "../extensions/hubble-boundary.ts";
import { ConfigReadError, VaultNotConfiguredError } from "../extensions/hubble-config.ts";
import { NoteTitleError } from "../extensions/hubble-errors.ts";

const context = { cwd: process.cwd(), isProjectTrusted: () => true };

test("formats tool results and attachments", () => {
  expect(noteResult("hello")).toEqual({ content: [{ type: "text", text: "hello" }], details: {} });
  expect(noteResult("hello", { count: 1 }).details).toEqual({ count: 1 });
  expect(attachmentValue("/vault/note.md")).toBe("@/vault/note.md");
  expect(attachmentValue("/vault/my note.md")).toBe('@"/vault/my note.md"');
  expect(attachmentValue('/vault/a"b.md')).toBe('@"/vault/a\\"b.md"');
});

test("converts tagged errors to safe messages and unwraps results", () => {
  const error = new SearchQueryError({ message: "query must not be empty." });
  expect(errorMessage(error)).toBe("query must not be empty.");
  expect(unwrapToolResult(Result.ok("value"))).toBe("value");
  expect(() => unwrapToolResult(Result.err(error))).toThrow("query must not be empty.");
  expect(() => throwHubbleError(new NoteTitleError({ title: "", message: "title must not be empty." }))).toThrow(
    "title must not be empty."
  );
});

test("redacts internal error details while preserving the tagged error as the cause", () => {
  const path = "/Users/private/.pi/hubble.json";
  const underlying = new Error("permission denied for a private path");
  const tagged = new ConfigReadError({
    path,
    cause: underlying,
    message: `Could not read Hubble configuration: ${path}.`,
  });

  const message = errorMessage(tagged);
  expect(message).toBe("Could not read the Hubble configuration. Check its permissions and try again.");
  expect(message).not.toContain(path);
  expect(message).not.toContain(underlying.message);

  try {
    throwHubbleError(tagged);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    expect((error as Error).cause).toBe(tagged);
  }
});

test("honors abort signals and propagates root resolution failures", async () => {
  expect(() => throwIfAborted(undefined)).not.toThrow();
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  expect(() => throwIfAborted(controller.signal)).toThrow("stop");

  const root = await mkdtemp(join(tmpdir(), "pi-hubble-boundary-"));
  const vault = await getToolVault(async () => Result.ok(root), context);
  expect(vault.root).toBe(await realpath(root));

  await expect(
    getToolVault(
      async () =>
        Result.err(new VaultNotConfiguredError({ globalPath: "/global/hubble.json", message: "not configured" })),
      context
    )
  ).rejects.toThrow("not configured");
});
