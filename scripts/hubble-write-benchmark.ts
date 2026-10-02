import { performance } from "node:perf_hooks";

import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Result, type Result as ResultType } from "better-result";

import { renderCreatePreview } from "../extensions/hubble-create-preview.ts";
import { BenchmarkError } from "../extensions/hubble-errors.ts";
import { buildNewNoteDocument } from "../extensions/hubble-notes.ts";
import { Vault } from "../extensions/hubble-vault.ts";
import {
  type BenchmarkDocument,
  type BenchmarkFileSystem,
  type BenchmarkOptions,
  benchmarkSummary,
  runInBenchmarkWorkspace,
  syntheticBenchmarkDocument,
} from "./hubble-benchmark.ts";

/** Measures public Vault operations and the create renderer used by Pi, verifying persisted content outside timing. */
async function measure(
  root: string,
  document: BenchmarkDocument,
  options: BenchmarkOptions
): Promise<ResultType<string, BenchmarkError>> {
  const opened = await Vault.open(root);

  if (Result.isError(opened)) {
    return Result.err(new BenchmarkError({ reason: "operation", cause: opened.error, message: opened.error.message }));
  }

  const vault = opened.value;
  const { title, content } = document;
  const { iterations } = options;
  const small = syntheticBenchmarkDocument(1_024);
  const large = syntheticBenchmarkDocument(262_144);
  const rows: string[] = [];
  const cases = [
    { name: "create 1 KiB", title: small.title, content: small.content, folder: "small" },
    { name: "create ticket-sized", title, content, folder: "tickets" },
    { name: "create nested exact filename", title, content, folder: "jer-k/effect-prophet/tickets/TODO" },
    { name: "create 256 KiB", title: large.title, content: large.content, folder: "large" },
    { name: "create occupied slug (100+)", title: small.title, content, folder: "collisions" },
  ];

  for (const item of cases) {
    if (item.folder === "collisions") {
      for (let index = 0; index < 100; index++) {
        const seeded = await vault.create(
          small.title,
          "seed",
          item.folder,
          "markdown",
          `write-benchmark${index === 0 ? "" : `-${index + 1}`}.md`
        );

        if (Result.isError(seeded)) {
          return Result.err(
            new BenchmarkError({ reason: "operation", cause: seeded.error, message: seeded.error.message })
          );
        }
      }
    }

    const samples: number[] = [];
    const expected = buildNewNoteDocument(item.title, item.content, "markdown");

    for (let index = -2; index < iterations; index++) {
      const start = performance.now();
      const created = await vault.create(
        item.title,
        item.content,
        item.folder,
        "markdown",
        item.folder === "collisions" ? undefined : `sample-${index}.md`
      );
      const elapsed = performance.now() - start;

      if (Result.isError(created)) {
        return Result.err(
          new BenchmarkError({ reason: "operation", cause: created.error, message: created.error.message })
        );
      }

      const read = await vault.read(created.value.relative);

      if (Result.isError(read) || read.value.content !== expected) {
        return Result.err(
          new BenchmarkError({
            reason: "verification",
            cause: Result.isError(read) ? read.error : undefined,
            message: "Created document did not round-trip.",
          })
        );
      }

      if (index >= 0) {
        samples.push(elapsed);
      }
    }

    rows.push(benchmarkSummary(item.name, Buffer.byteLength(expected), samples));
  }

  initTheme("dark");
  const args = { title, content };
  const context = { expanded: false, lastComponent: undefined };
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  for (const expanded of [false, true]) {
    const samples: number[] = [];
    let component: Component | undefined;

    for (let index = -2; index < iterations; index++) {
      const start = performance.now();
      component = renderCreatePreview(args, theme, { ...context, expanded, lastComponent: component });
      component.render(120);

      if (index >= 0) {
        samples.push(performance.now() - start);
      }
    }

    rows.push(
      benchmarkSummary(expanded ? "render expanded (redraw)" : "render collapsed (redraw)", document.bytes, samples)
    );
  }

  const streamingSamples: number[] = [];
  for (let index = -1; index < iterations; index++) {
    let component: Component | undefined;
    const start = performance.now();

    for (let length = 128; length < content.length + 128; length += 128) {
      component = renderCreatePreview({ ...args, content: content.slice(0, length) }, theme, {
        ...context,
        lastComponent: component,
      });
      component.render(120);
    }

    if (index >= 0) {
      streamingSamples.push(performance.now() - start);
    }
  }
  rows.push(benchmarkSummary("render collapsed (stream)", document.bytes, streamingSamples));

  return Result.ok(
    [
      `Node ${process.version}; ${process.platform}/${process.arch}; ${iterations} measured iterations (with warmups).`,
      "Times exclude setup, verification, cleanup, model generation, and network latency.",
      "Streaming uses 128-character updates; redraws reuse the previous component.",
      "Scenario                          bytes  median ms     p95 ms",
      ...rows,
    ].join("\n")
  );
}

/**
 * Runs isolated write/render benchmarks, returning a report or structured argument, I/O, operation, or verification failure.
 * Only writes in scratch storage, removes it on completion, and reads --source without modifying it.
 * Initializes Pi's dark syntax-highlighting theme for rendering measurements.
 */
export function runWriteBenchmark(
  args: ReadonlyArray<string>,
  fileSystem?: BenchmarkFileSystem
): Promise<ResultType<string, BenchmarkError>> {
  return runInBenchmarkWorkspace(args, measure, fileSystem);
}
