import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { runWriteBenchmark } from "../scripts/hubble-write-benchmark.ts";

test.each([
  ["--iterations", "0"],
  ["--iterations", "NaN"],
  ["--iterations", "1001"],
  ["--iterations", "1.5"],
  ["--source"],
  ["--unknown", "value"],
])("rejects invalid benchmark arguments %j", async (...args) => {
  expect(await runWriteBenchmark(args)).toMatchObject({
    status: "error",
    error: { _tag: "BenchmarkError", reason: "arguments" },
  });
});

test("benchmarks the ticket-sized default in scratch storage and cleans up", async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "hubble-bench-test-"));
  try {
    const result = await runWriteBenchmark(["--iterations", "1", "--temp-parent", parent]);
    expect(result.status).toBe("ok");

    if (result.status !== "ok") throw result.error;

    expect(result.value).toContain("create ticket-sized               23688");
    expect(result.value).toContain("create nested exact filename      23688");
    expect(result.value).toContain("create occupied slug (100+)");
    expect(result.value).toContain("render collapsed (stream)");
    expect(await fs.readdir(parent)).toEqual([]);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("reads a supplied Unicode Markdown note without modifying it and reports actual output bytes", async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "hubble-bench-source-"));
  const source = join(parent, "ticket.md");
  const document = "# Ticket — numerical acceptance\n\n## TODO\n\n- [ ] Investigate\n";
  await fs.writeFile(source, document);
  try {
    const result = await runWriteBenchmark(["--iterations", "1", "--source", source, "--temp-parent", parent]);
    expect(result.status).toBe("ok");

    if (result.status !== "ok") throw result.error;

    expect(result.value).toMatch(new RegExp(`create ticket-sized\\s+${Buffer.byteLength(document)}\\s`));
    expect(await fs.readFile(source, "utf8")).toBe(document);
    expect(await fs.readdir(parent)).toEqual(["ticket.md"]);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("returns structured operation failures and still removes its scratch vault", async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "hubble-bench-invalid-note-"));
  const source = join(parent, "invalid.md");
  await fs.writeFile(source, "# \n\nBody");
  try {
    const result = await runWriteBenchmark(["--iterations", "1", "--source", source, "--temp-parent", parent]);
    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "BenchmarkError",
        reason: "operation",
        cause: { _tag: "NoteValidationError", reason: "title" },
      },
    });
    expect(await fs.readdir(parent)).toEqual(["invalid.md"]);
    expect(await fs.readFile(source, "utf8")).toBe("# \n\nBody");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("preserves expected source, scratch allocation, and cleanup failure causes", async () => {
  const cause = Object.assign(new Error("permission denied"), { code: "EACCES" });
  expect(
    await runWriteBenchmark(["--source", "unreadable.md"], {
      ...fs,
      async readFile() {
        throw cause;
      },
    })
  ).toMatchObject({ status: "error", error: { _tag: "BenchmarkError", reason: "filesystem", cause } });
  expect(
    await runWriteBenchmark([], {
      ...fs,
      async mkdtemp() {
        throw cause;
      },
    })
  ).toMatchObject({ status: "error", error: { _tag: "BenchmarkError", reason: "filesystem", cause } });
  const cleanup = await runWriteBenchmark(["--iterations", "1"], {
    ...fs,
    async rm(path, options) {
      await fs.rm(path, options);
      throw cause;
    },
  });
  expect(cleanup).toMatchObject({
    status: "error",
    error: { _tag: "BenchmarkError", reason: "filesystem", cause: { _tag: "BenchmarkError", cause } },
  });
});
