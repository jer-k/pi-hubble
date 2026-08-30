import { expect, test } from "vitest";
import type { NoteReference } from "../extensions/hubble-notes.ts";
import { HubbleNotePicker } from "../extensions/hubble-ui.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const keybindings = {
  matches: (data: string, key: string) =>
    (data === "\r" && key === "tui.select.confirm") || (data === "\u001b" && key === "tui.select.cancel"),
};
function noteReference(absolute: string, relative: string): NoteReference {
  // SAFETY: These inert picker fixtures never reach filesystem operations; the paths model already-resolved notes.
  return { absolute, relative } as NoteReference;
}

const notes = [noteReference("/vault/alpha.md", "alpha.md"), noteReference("/vault/project.html", "project.html")];

test("renders notes, filters text, tracks focus, and attaches selections", () => {
  let renders = 0;
  let selected: NoteReference | undefined;
  const picker = new HubbleNotePicker(
    { requestRender: () => renders++ },
    theme,
    keybindings,
    notes,
    "project",
    (note) => {
      selected = note;
    }
  );

  expect(picker.focused).toBe(false);
  picker.focused = true;
  expect(picker.focused).toBe(true);
  expect(picker.render(80).join("\n")).toContain("project.html");
  expect(picker.render(80).join("\n")).toContain("HTML note");
  expect(picker.render(80).join("\n")).not.toContain("alpha.md");

  picker.handleInput("\r");
  expect(selected?.relative).toBe("project.html");
  expect(renders).toBeGreaterThan(0);
});

test("calls back with undefined on cancellation", () => {
  let cancelled = false;
  const picker = new HubbleNotePicker({ requestRender: () => undefined }, theme, keybindings, notes, "", (note) => {
    cancelled = note === undefined;
  });
  picker.handleInput("\u001b");
  expect(cancelled).toBe(true);
});
