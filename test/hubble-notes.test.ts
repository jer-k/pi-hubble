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
