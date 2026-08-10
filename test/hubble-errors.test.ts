import { expect, test } from "vitest";
import {
  EditValidationError,
  InvalidMarkdownPathError,
  NoteAppendValidationError,
  NoteNotFoundError,
  NoteReadError,
  NoteTitleError,
  NoteWriteError,
  OutputPersistenceError,
  VaultDiscoveryError,
  VaultOpenError,
  VaultPathError,
  VaultRootTypeError,
} from "../extensions/hubble-errors.ts";

test("constructs every tagged Hubble error with its discriminant", () => {
  const errors = [
    new VaultPathError({ input: "../note.md", reason: "escape", message: "escape" }),
    new NoteTitleError({ title: "", message: "empty" }),
    new NoteWriteError({ operation: "create", path: "note.md", cause: new Error("write"), message: "write" }),
    new VaultOpenError({ root: "/vault", cause: new Error("open"), message: "open" }),
    new VaultRootTypeError({ root: "/vault", message: "type" }),
    new InvalidMarkdownPathError({ path: "note.txt", message: "markdown" }),
    new NoteNotFoundError({ path: "note.md", message: "missing" }),
    new NoteReadError({ path: "note.md", cause: new Error("read"), message: "read" }),
    new NoteAppendValidationError({ path: "note.md", message: "append" }),
    new EditValidationError({ path: "note.md", reason: "duplicate", message: "duplicate" }),
    new VaultDiscoveryError({ path: "/vault", cause: new Error("discover"), message: "discover" }),
    new OutputPersistenceError({ cause: new Error("persist"), message: "persist" }),
  ];

  expect(errors.map((error) => error._tag)).toEqual([
    "VaultPathError",
    "NoteTitleError",
    "NoteWriteError",
    "VaultOpenError",
    "VaultRootTypeError",
    "InvalidMarkdownPathError",
    "NoteNotFoundError",
    "NoteReadError",
    "NoteAppendValidationError",
    "EditValidationError",
    "VaultDiscoveryError",
    "OutputPersistenceError",
  ]);
});
