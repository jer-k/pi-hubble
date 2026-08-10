import { expect, test } from "vitest";
import { HubbleNotePicker } from "../extensions/hubble-ui.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const keybindings = {
  matches: (data: string, key: string) =>
    (data === "\r" && key === "tui.select.confirm") || (data === "\u001b" && key === "tui.select.cancel"),
};
const notes = [
  { absolute: "/vault/alpha.md", relative: "alpha.md" },
  { absolute: "/vault/project.md", relative: "project.md" },
];

test("renders notes, filters text, tracks focus, and attaches selections", () => {
  let renders = 0;
  let selected: (typeof notes)[number] | undefined;
  const picker = new HubbleNotePicker(
    { requestRender: () => renders++ },
    theme,
    keybindings,
    notes,
    "project",
    (note) => {
      selected = note as (typeof notes)[number] | undefined;
    }
  );

  expect(picker.focused).toBe(false);
  picker.focused = true;
  expect(picker.focused).toBe(true);
  expect(picker.render(80).join("\n")).toContain("project.md");
  expect(picker.render(80).join("\n")).not.toContain("alpha.md");

  picker.handleInput("\r");
  expect(selected?.relative).toBe("project.md");
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
