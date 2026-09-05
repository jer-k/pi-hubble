import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AutocompleteProviderFactory,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Result } from "better-result";
import { expect, test } from "vitest";

import { registerHubbleAutocomplete } from "../extensions/hubble-autocomplete.ts";
import { VaultNotConfiguredError } from "../extensions/hubble-config.ts";
import { openVault } from "../extensions/hubble-vault.ts";
import { testCast } from "./test-cast.ts";

type SessionStartHandler = ExtensionHandler<SessionStartEvent>;

const sessionStartEvent: SessionStartEvent = { type: "session_start", reason: "startup" };

function createPi() {
  let sessionStart: SessionStartHandler | undefined;
  const pi = {
    on(_event: string, handler: SessionStartHandler) {
      sessionStart = handler;
    },
  };
  return { pi: testCast<typeof pi, ExtensionAPI>(pi), getSessionStart: () => sessionStart };
}

test("registers no provider for non-interactive sessions", () => {
  const { pi, getSessionStart } = createPi();
  registerHubbleAutocomplete(pi, async () => openVault("unused"));

  const providers: AutocompleteProviderFactory[] = [];
  const context = {
    hasUI: false,
    ui: { addAutocompleteProvider: (provider: AutocompleteProviderFactory) => providers.push(provider) },
  };
  getSessionStart()?.(sessionStartEvent, testCast<typeof context, ExtensionContext>(context));

  expect(providers).toHaveLength(0);
});

test("returns no suggestions for expected failures but propagates defects", async () => {
  const current = {
    getSuggestions: async () => ({ prefix: "", items: [] }),
    applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    shouldTriggerFileCompletion: () => true,
  };

  const context = {
    hasUI: true,
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    ui: { addAutocompleteProvider: (_factory: AutocompleteProviderFactory) => undefined },
  };

  const expectedFailure = createPi();
  registerHubbleAutocomplete(expectedFailure.pi, async () =>
    Result.err(new VaultNotConfiguredError({ globalPath: "/private/config.json", message: "internal detail" }))
  );

  let expectedFactory: AutocompleteProviderFactory | undefined;
  context.ui.addAutocompleteProvider = (factory) => {
    expectedFactory = factory;
  };
  expectedFailure.getSessionStart()?.(sessionStartEvent, testCast<typeof context, ExtensionContext>(context));
  if (expectedFactory === undefined) throw new Error("Expected autocomplete provider registration");
  const expectedProvider = expectedFactory(current);

  expect(await expectedProvider.getSuggestions(["@hubble/"], 0, 8, { signal: new AbortController().signal })).toEqual({
    prefix: "@hubble/",
    items: [],
  });

  const defect = createPi();
  registerHubbleAutocomplete(defect.pi, async () => {
    throw new Error("unexpected autocomplete defect");
  });

  let defectFactory: AutocompleteProviderFactory | undefined;
  context.ui.addAutocompleteProvider = (factory) => {
    defectFactory = factory;
  };
  defect.getSessionStart()?.(sessionStartEvent, testCast<typeof context, ExtensionContext>(context));
  if (defectFactory === undefined) throw new Error("Expected autocomplete provider registration");
  const defectProvider = defectFactory(current);

  await expect(
    defectProvider.getSuggestions(["@hubble/"], 0, 8, { signal: new AbortController().signal })
  ).rejects.toThrow("unexpected autocomplete defect");
});

test("suggests vault notes, delegates unrelated text, and handles cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-autocomplete-"));
  await mkdir(join(root, "pi-hubble"));
  await writeFile(join(root, "alpha.md"), "alpha", "utf8");
  await writeFile(join(root, "beta.md"), "beta", "utf8");
  await writeFile(join(root, "page.HTML"), "<p>page</p>", "utf8");
  await writeFile(join(root, "pi-hubble", "long-note-name.html"), "<p>long</p>", "utf8");
  const { pi, getSessionStart } = createPi();
  registerHubbleAutocomplete(pi, async () => openVault(root));

  let providerFactory: AutocompleteProviderFactory | undefined;
  const current = {
    getSuggestions: async () => ({ prefix: "", items: [{ value: "fallback", label: "fallback" }] }),
    applyCompletion: () => ({ lines: ["done"], cursorLine: 0, cursorCol: 4 }),
    shouldTriggerFileCompletion: () => false,
  };
  const context = {
    hasUI: true,
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    ui: { addAutocompleteProvider: (factory: AutocompleteProviderFactory) => (providerFactory = factory) },
  };
  getSessionStart()?.(sessionStartEvent, testCast<typeof context, ExtensionContext>(context));
  if (providerFactory === undefined) throw new Error("Expected autocomplete provider registration");
  const provider = providerFactory(current);
  expect(await provider.getSuggestions(["text"], 0, 4, { signal: new AbortController().signal })).toEqual({
    prefix: "",
    items: [{ value: "fallback", label: "fallback" }],
  });

  const suggestions = await provider.getSuggestions(["@hubble/"], 0, 8, { signal: new AbortController().signal });
  if (suggestions === null) throw new Error("Expected Hubble autocomplete suggestions");
  expect(suggestions.prefix).toBe("@hubble/");
  expect(suggestions.items.map((item: { label: string }) => item.label)).toEqual([
    "@hubble/alpha.md",
    "@hubble/beta.md",
    "@hubble/page.HTML",
    "@hubble/pi-hubble/long-note-name.html",
  ]);
  expect(suggestions.items.at(0)?.value).toBe(`@${join(await realpath(root), "alpha.md")}`);

  const scoped = await provider.getSuggestions(["@hubble/pi-hubble/"], 0, 18, {
    signal: new AbortController().signal,
  });
  expect(scoped).toEqual({
    prefix: "@hubble/pi-hubble/",
    items: [
      {
        value: `@${join(await realpath(root), "pi-hubble", "long-note-name.html")}`,
        label: "long-note-name.html",
      },
    ],
  });
  const firstSuggestion = suggestions.items.at(0);
  if (firstSuggestion === undefined) throw new Error("Expected at least one Hubble suggestion");
  expect(provider.applyCompletion(["@hubble/"], 0, 8, firstSuggestion, "@hubble/")).toEqual({
    lines: ["done"],
    cursorLine: 0,
    cursorCol: 4,
  });
  expect(provider.shouldTriggerFileCompletion?.([], 0, 0)).toBe(false);

  const controller = new AbortController();
  controller.abort();
  expect(await provider.getSuggestions(["@hubble/a"], 0, 10, { signal: controller.signal })).toEqual({
    prefix: "@hubble/a",
    items: [],
  });
});

test("caches discovery briefly, refreshes creations, and rejects unsafe cached attachments", async () => {
  const fs = await import("node:fs/promises");
  const base = await mkdtemp(join(tmpdir(), "hubble-autocomplete-cache-"));
  const root = join(base, "vault");
  await mkdir(root);
  await writeFile(join(root, "alpha.md"), "alpha");
  let clock = 0;
  let allowScan = true;
  const opened = await openVault(root, {
    ...fs,
    async readdir(path, options) {
      if (!allowScan) throw new Error("unexpected rescan");
      return fs.readdir(path, options);
    },
  });
  if (opened.status === "error") throw opened.error;
  const { pi, getSessionStart } = createPi();
  registerHubbleAutocomplete(
    pi,
    async () => opened,
    () => clock
  );
  let factory: AutocompleteProviderFactory | undefined;
  const ctx = {
    hasUI: true,
    ui: {
      addAutocompleteProvider(value: AutocompleteProviderFactory) {
        factory = value;
      },
    },
  };
  getSessionStart()?.(sessionStartEvent, testCast<typeof ctx, ExtensionContext>(ctx));
  if (!factory) throw new Error("Expected provider");
  const provider = factory({
    getSuggestions: async () => null,
    applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
  });
  const suggestions = () => provider.getSuggestions(["@hubble/"], 0, 8, { signal: new AbortController().signal });
  try {
    expect((await suggestions())?.items).toHaveLength(1);
    allowScan = false;
    expect((await suggestions())?.items).toHaveLength(1);
    await writeFile(join(root, "external.md"), "external");
    allowScan = true;
    clock = 1_001;
    expect((await suggestions())?.items).toHaveLength(2);
    await opened.value.create("Created", "body");
    expect((await suggestions())?.items).toHaveLength(3);
    // A failed refresh must not cache the failure for the remainder of the TTL.
    clock = 2_002;
    allowScan = false;
    expect((await suggestions())?.items).toEqual([]);
    allowScan = true;
    expect((await suggestions())?.items).toHaveLength(3);
    await fs.rename(root, join(base, "old-vault"));
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "alpha.md"), "private");
    await fs.symlink(outside, root);
    expect((await suggestions())?.items).toEqual([]);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
