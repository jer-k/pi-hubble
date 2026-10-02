import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Result } from "better-result";
import { expect, test } from "vitest";

import { BenchmarkError } from "../extensions/hubble-errors.ts";
import {
  benchmarkDocument,
  benchmarkSummary,
  parseBenchmarkArguments,
  runInBenchmarkWorkspace,
  syntheticBenchmarkDocument,
} from "../scripts/hubble-benchmark.ts";

test("parses shared defaults and explicit corpus/source/filesystem options", () => {
  const defaults = parseBenchmarkArguments([]);
  expect(defaults).toMatchObject({ status: "ok", value: { iterations: 30, notes: 100, source: undefined } });
  expect(
    parseBenchmarkArguments([
      "--iterations",
      "2",
      "--notes",
      "12",
      "--source",
      "ticket.md",
      "--temp-parent",
      "/scratch",
    ])
  ).toMatchObject({
    status: "ok",
    value: { iterations: 2, notes: 12, source: "ticket.md", temporaryParent: "/scratch" },
  });
});

test.each(["0", "5001", "NaN", "1.5"])("rejects invalid corpus counts %s", (value) => {
  expect(parseBenchmarkArguments(["--notes", value])).toMatchObject({
    status: "error",
    error: { _tag: "BenchmarkError", reason: "arguments" },
  });
});

test("constructs exact-sized documents and counts Unicode bytes rather than characters", () => {
  for (const bytes of [1_024, 23_688, 262_144]) {
    const generated = syntheticBenchmarkDocument(bytes);
    expect(generated.bytes).toBe(bytes);
    expect(Buffer.byteLength(generated.document)).toBe(bytes);
    expect(generated.document).toBe(`# ${generated.title}\n\n${generated.content}`);
  }
  const unicode = benchmarkDocument("Numerics — acceptance", "σ");
  expect(unicode.bytes).toBe(Buffer.byteLength(unicode.document));
  expect(unicode.bytes).toBeGreaterThan(unicode.document.length);
});

test.each([1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid synthetic sizes as programmer defects (%s)",
  (bytes) => {
    expect(() => syntheticBenchmarkDocument(bytes)).toThrow("safe integer that accommodates its title");
  }
);

test("reports nearest-rank median/p95 consistently without mutating samples", () => {
  const samples = [5, 1, 2, 4, 3];
  expect(benchmarkSummary("sample", 23_688, samples)).toMatch(/sample\s+23688\s+3\.000\s+5\.000$/u);
  expect(samples).toEqual([5, 1, 2, 4, 3]);
});

test("preserves both operation and cleanup failures and still attempts cleanup", async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "hubble-benchmark-aggregate-"));
  const operation = new BenchmarkError({ reason: "operation", message: "measured operation failed" });
  const cleanupCause = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
  try {
    const result = await runInBenchmarkWorkspace(["--temp-parent", parent], async () => Result.err(operation), {
      ...fs,
      async rm(path, options) {
        await fs.rm(path, options);
        throw cleanupCause;
      },
    });
    expect(result).toMatchObject({ status: "error", error: { _tag: "BenchmarkError", reason: "filesystem" } });

    if (result.status !== "error" || !(result.error.cause instanceof AggregateError)) {
      throw new Error("Expected preserved operation and cleanup errors");
    }

    expect(result.error.cause.errors[0]).toBe(operation);
    expect(result.error.cause.errors[1]).toMatchObject({
      _tag: "BenchmarkError",
      reason: "filesystem",
      cause: cleanupCause,
    });
    expect(await fs.readdir(parent)).toEqual([]);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("does not convert programmer defects into Results and still removes scratch storage", async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "hubble-benchmark-defect-"));
  const defect = new Error("benchmark programmer defect");
  try {
    await expect(
      runInBenchmarkWorkspace(["--temp-parent", parent], async () => {
        throw defect;
      })
    ).rejects.toBe(defect);
    expect(await fs.readdir(parent)).toEqual([]);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
