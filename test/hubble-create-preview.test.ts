import { initTheme } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { renderCreatePreview } from "../extensions/hubble-create-preview.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function plain(component: ReturnType<typeof renderCreatePreview>): string {
  return component
    .render(200)
    .join("\n")
    .replaceAll(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
    .replace(/[ \t]+$/gmu, "");
}

test("reuses one row across unchanged redraws, streaming, expansion, and argument changes", () => {
  initTheme("dark");
  const content = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n");
  const args = { title: "Preview", content };
  const initial = renderCreatePreview(args, theme, { expanded: false, lastComponent: undefined });
  const firstLayout = initial.render(200);
  const redrawn = renderCreatePreview(args, theme, { expanded: false, lastComponent: initial });
  expect(redrawn).toBe(initial);
  expect(redrawn.render(200)).toBe(firstLayout);
  expect(plain(redrawn)).toContain("(32 more lines, 42 total,");
  expect(plain(redrawn)).not.toContain("Line 40");

  const streamed = renderCreatePreview({ ...args, content: `${content}\nLine 41\n\n` }, theme, {
    expanded: false,
    lastComponent: redrawn,
  });
  expect(plain(streamed)).toContain("(33 more lines, 43 total,");
  const expanded = renderCreatePreview({ ...args, content: `${content}\nLine 41\n\n` }, theme, {
    expanded: true,
    lastComponent: streamed,
  });
  expect(plain(expanded)).toContain("Line 41");
  expect(plain(expanded)).not.toContain("more lines");

  const edited = renderCreatePreview(
    { title: "Updated", content: "replacement", folder: "new-folder", filename: "new.md" },
    theme,
    { expanded: false, lastComponent: expanded }
  );
  expect(plain(edited)).toContain("new-folder/new.md");
  expect(plain(edited)).toContain("# Updated");
  expect(plain(edited)).toContain("replacement");
  expect(plain(edited)).not.toContain("Line 41");
  edited.invalidate();
  const refreshed = renderCreatePreview({ title: "Updated", content: "replacement" }, theme, {
    expanded: true,
    lastComponent: edited,
  });
  expect(plain(refreshed)).toContain("replacement");
});

test("updates inferred HTML format and theme without leaking cached content between rows", () => {
  initTheme("dark");
  const first = renderCreatePreview({ title: "A & B", content: "<p>body</p>" }, theme, {
    expanded: true,
    lastComponent: undefined,
  });
  expect(plain(first)).toContain("# A & B");
  const html = renderCreatePreview({ title: "A & B", content: "<p>body</p>", filename: "page.html" }, theme, {
    expanded: true,
    lastComponent: first,
  });
  expect(plain(html)).toContain("<!doctype html>");
  expect(plain(html)).toContain("<title>A &amp; B</title>");

  const darkSyntax = html.render(200).join("\n");
  initTheme("light");
  html.invalidate();
  const sameDocument = renderCreatePreview({ title: "A & B", content: "<p>body</p>", filename: "page.html" }, theme, {
    expanded: true,
    lastComponent: html,
  });
  expect(sameDocument.render(200).join("\n")).not.toBe(darkSyntax);
  const newTheme = { ...theme, fg: (_color: string, text: string) => `light:${text}` };
  const themed = renderCreatePreview({ title: "A & B", content: "<p>changed</p>", filename: "page.html" }, newTheme, {
    expanded: true,
    lastComponent: html,
  });
  expect(plain(themed)).toContain("light:hubble_create");
  expect(plain(themed)).toContain("<p>changed</p>");
  const separate = renderCreatePreview({ title: "Another", content: "separate" }, theme, {
    expanded: false,
    lastComponent: undefined,
  });
  expect(separate).not.toBe(themed);
  expect(plain(separate)).not.toContain("changed");
  expect(plain(separate)).toContain("separate");
});

test("renders partial arguments and preserves blank-line counts and display normalization", () => {
  initTheme("dark");
  const partial = renderCreatePreview({}, theme, { expanded: false, lastComponent: undefined });
  expect(plain(partial)).toContain("hubble_create ...");
  const preview = renderCreatePreview({ title: "Small", content: "\tFirst\r\n\nSecond\n\n" }, theme, {
    expanded: true,
    lastComponent: partial,
  });
  expect(plain(preview)).toContain("   First\n\nSecond");
  expect(plain(preview)).not.toContain("more lines");
});
