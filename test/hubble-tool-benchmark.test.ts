import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { runToolBenchmark } from "../scripts/hubble-tool-benchmark.ts";

test("benchmarks every real bound tool, verifies success/rejection paths, and cleans up oversized outputs", async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "hubble-tools-bench-test-"));
  try {
    const result = await runToolBenchmark(["--iterations", "1", "--notes", "12", "--temp-parent", parent]);
    expect(result.status).toBe("ok");

    if (result.status !== "ok") throw result.error;

    const rows = result.value.split("\n").filter((line) => line.startsWith("hubble_"));
    expect(rows).toHaveLength(25);
    for (const name of ["list", "search", "read", "create", "edit", "move", "delete"]) {
      expect(rows.some((line) => line.startsWith(`hubble_${name}:`))).toBe(true);
    }
    for (const row of rows) {
      // Check report structure and finite latencies, not machine-dependent speed thresholds.
      const columns = row.match(/\s+(\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)$/u);
      expect(columns).not.toBeNull();
      expect(Number.isFinite(Number(columns?.[2]))).toBe(true);
      expect(Number(columns?.[3])).toBeGreaterThanOrEqual(Number(columns?.[2]));
    }
    expect(result.value).toContain("hubble_search: late page");
    expect(result.value).toContain("hubble_search: oversized matching line");
    expect(result.value).toContain("hubble_read: 256 KiB (truncated output)");
    expect(result.value).toContain("hubble_list: reject traversal");
    expect(result.value).toContain("hubble_search: reject empty query");
    expect(result.value).toContain("hubble_read: missing note");
    expect(result.value).toContain("hubble_create: existing exact filename");
    expect(result.value).toContain("hubble_edit: missing exact match");
    expect(result.value).toContain("hubble_move: existing destination");
    expect(result.value).toContain("hubble_delete: missing note");
    expect(await fs.readdir(parent)).toEqual([]);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test.each(["LF", "CRLF"] as const)(
  "preserves supplied %s Unicode notes even with repeated headings and benchmark query strings",
  async (lineEndings) => {
    const parent = await fs.mkdtemp(join(tmpdir(), "hubble-tools-bench-source-"));
    const source = join(parent, "ticket.md");
    const lfDocument =
      "# Numerical — acceptance\n\nbenchmark-needle-once\nbenchmark-long-match\nbenchmark-absent-needle-never-seeded\n\n# Numerical — acceptance\n\nσ diagnostics\n";
    const document = lineEndings === "LF" ? lfDocument : lfDocument.replaceAll("\n", "\r\n");
    await fs.writeFile(source, document);
    try {
      const result = await runToolBenchmark([
        "--iterations",
        "1",
        "--notes",
        "1",
        "--source",
        source,
        "--temp-parent",
        parent,
      ]);
      expect(result.status).toBe("ok");

      if (result.status !== "ok") throw result.error;

      const generated =
        lineEndings === "LF"
          ? document
          : document.replace(/^# Numerical — acceptance\r\n\r\n/u, "# Numerical — acceptance\n\n");
      expect(result.value).toContain(`ticket payload: ${Buffer.byteLength(generated)} bytes`);
      expect(await fs.readFile(source, "utf8")).toBe(document);
      expect(await fs.readdir(parent)).toEqual(["ticket.md"]);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  }
);

test("rejects invalid arguments before allocating scratch or creating the SDK session", async () => {
  expect(await runToolBenchmark(["--notes", "0"])).toMatchObject({
    status: "error",
    error: { _tag: "BenchmarkError", reason: "arguments" },
  });
  expect(await runToolBenchmark(["--not-an-option", "value"])).toMatchObject({
    status: "error",
    error: { _tag: "BenchmarkError", reason: "arguments" },
  });
});

test("preserves source I/O causes and cleans up when fixture creation returns a structured failure", async () => {
  const cause = Object.assign(new Error("read denied"), { code: "EACCES" });
  expect(
    await runToolBenchmark(["--source", "private.md"], {
      ...fs,
      async readFile() {
        throw cause;
      },
    })
  ).toMatchObject({ status: "error", error: { _tag: "BenchmarkError", reason: "filesystem", cause } });

  const parent = await fs.mkdtemp(join(tmpdir(), "hubble-tools-bench-invalid-"));
  const source = join(parent, "invalid.md");
  await fs.writeFile(source, "# \n\nBody");
  try {
    expect(
      await runToolBenchmark(["--iterations", "1", "--notes", "1", "--source", source, "--temp-parent", parent])
    ).toMatchObject({
      status: "error",
      error: { _tag: "BenchmarkError", reason: "operation", cause: { _tag: "NoteValidationError", reason: "title" } },
    });
    expect(await fs.readdir(parent)).toEqual(["invalid.md"]);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
