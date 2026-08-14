import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Result } from "better-result";
import { expect, test } from "vitest";
import { registerHubbleAutocomplete } from "../extensions/hubble-autocomplete.ts";
import { VaultNotConfiguredError } from "../extensions/hubble-config.ts";
import { openVault } from "../extensions/hubble-vault.ts";

type GenericHandler = (...args: unknown[]) => unknown;

type AutocompleteProvider = {
  getSuggestions: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal }
  ) => Promise<{ prefix: string; items: Array<{ value: string; label: string }> }>;
  applyCompletion: (...args: unknown[]) => unknown;
  shouldTriggerFileCompletion: (...args: unknown[]) => boolean;
};

function createPi() {
  let sessionStart: GenericHandler | undefined;
  const pi = {
    on(_event: string, handler: GenericHandler) {
      sessionStart = handler;
    },
  };
  return { pi: pi as unknown as ExtensionAPI, getSessionStart: () => sessionStart };
}

test("registers no provider for non-interactive sessions", () => {
  const { pi, getSessionStart } = createPi();
  registerHubbleAutocomplete(pi, async () => openVault("unused"));

  const providers: unknown[] = [];
  getSessionStart()?.(
    {},
    { hasUI: false, ui: { addAutocompleteProvider: (provider: unknown) => providers.push(provider) } }
  );

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
    ui: { addAutocompleteProvider: (_factory: GenericHandler) => undefined },
  };

  const expectedFailure = createPi();
  registerHubbleAutocomplete(expectedFailure.pi, async () =>
    Result.err(new VaultNotConfiguredError({ globalPath: "/private/config.json", message: "internal detail" }))
  );

  let expectedFactory: GenericHandler | undefined;
  context.ui.addAutocompleteProvider = (factory) => {
    expectedFactory = factory;
  };
  expectedFailure.getSessionStart()?.({}, context);
  const expectedProvider = expectedFactory?.(current) as AutocompleteProvider;

  expect(await expectedProvider.getSuggestions(["@hubble/"], 0, 8, { signal: new AbortController().signal })).toEqual({
    prefix: "@hubble/",
    items: [],
  });

  const defect = createPi();
  registerHubbleAutocomplete(defect.pi, async () => {
    throw new Error("unexpected autocomplete defect");
  });

  let defectFactory: GenericHandler | undefined;
  context.ui.addAutocompleteProvider = (factory) => {
    defectFactory = factory;
  };
  defect.getSessionStart()?.({}, context);
  const defectProvider = defectFactory?.(current) as AutocompleteProvider;

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

  let providerFactory: GenericHandler | undefined;
  const current = {
    getSuggestions: async () => ({ prefix: "", items: [{ value: "fallback", label: "fallback" }] }),
    applyCompletion: () => ({ lines: ["done"], cursorLine: 0, cursorCol: 4 }),
    shouldTriggerFileCompletion: () => false,
  };
  getSessionStart()?.(
    {},
    {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { addAutocompleteProvider: (factory: GenericHandler) => (providerFactory = factory) },
    }
  );
  const provider = providerFactory?.(current) as AutocompleteProvider;
  expect(await provider.getSuggestions(["text"], 0, 4, { signal: new AbortController().signal })).toEqual({
    prefix: "",
    items: [{ value: "fallback", label: "fallback" }],
  });

  const suggestions = await provider.getSuggestions(["@hubble/"], 0, 8, { signal: new AbortController().signal });
  expect(suggestions.prefix).toBe("@hubble/");
  expect(suggestions.items.map((item: { label: string }) => item.label)).toEqual([
    "@hubble/alpha.md",
    "@hubble/beta.md",
    "@hubble/page.HTML",
    "@hubble/pi-hubble/long-note-name.html",
  ]);
  expect(suggestions.items[0].value).toBe(`@${join(await realpath(root), "alpha.md")}`);

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
  expect(provider.applyCompletion(["@hubble/"], 0, 8, suggestions.items[0], "@hubble/")).toEqual({
    lines: ["done"],
    cursorLine: 0,
    cursorCol: 4,
  });
  expect(provider.shouldTriggerFileCompletion([], 0, 0)).toBe(false);

  const controller = new AbortController();
  controller.abort();
  expect(await provider.getSuggestions(["@hubble/a"], 0, 10, { signal: controller.signal })).toEqual({
    prefix: "@hubble/a",
    items: [],
  });
});
