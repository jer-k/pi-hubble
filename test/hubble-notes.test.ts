import { expect, test } from "vitest";

import { applyExactEdits } from "../extensions/hubble-notes.ts";

test("applies disjoint exact edits against the original content", () => {
  const result = applyExactEdits(
    "alpha beta gamma",
    [
      { oldText: "alpha", newText: "first" },
      { oldText: "gamma", newText: "last" },
    ],
    "note.md"
  );

  expect(result).toEqual({ status: "ok", value: "first beta last" });
});

test("reports visible trailing whitespace and location when an exact edit misses", () => {
  const result = applyExactEdits(
    "# Tasks\n\nAlpha  \nBeta\t\n",
    [{ oldText: "Alpha\nBeta\n", newText: "Done\n" }],
    "tasks.md"
  );

  expect(result.status).toBe("error");

  if (result.status === "error") {
    expect(result.error).toMatchObject({
      _tag: "EditValidationError",
      reason: "missing",
      editIndex: 0,
      mismatch: {
        kind: "trailing-whitespace",
        line: 3,
        column: 1,
        requested: "Alpha↵\nBeta↵\n",
        actual: "Alpha··↵\nBeta→↵\n",
      },
    });
    expect(result.error.message).toContain("line 3, column 1");
    expect(result.error.message).toContain("Visible whitespace uses · for spaces, → for tabs, and ↵ for newlines.");
  }
});

test("identifies the failing edit when no whitespace-equivalent region exists", () => {
  const result = applyExactEdits("alpha", [{ oldText: "missing", newText: "new" }], "note.md");

  expect(result).toMatchObject({
    status: "error",
    error: {
      _tag: "EditValidationError",
      reason: "missing",
      editIndex: 0,
      message: "Could not find an exact match for edits[0].oldText in note.md.",
    },
  });
});

test("returns a tagged validation error for overlapping exact edits", () => {
  const result = applyExactEdits(
    "alpha beta",
    [
      { oldText: "alpha beta", newText: "all" },
      { oldText: "beta", newText: "second" },
    ],
    "note.md"
  );

  expect(result.status).toBe("error");

  if (result.status === "error") {
    expect(result.error._tag).toBe("EditValidationError");
    expect(result.error.reason).toBe("overlap");
  }
});
