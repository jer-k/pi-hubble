import { highlightCode, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

import { buildNewNoteDocument } from "./hubble-notes.ts";
import type { HubbleNoteFormat } from "./hubble-paths.ts";

const CREATE_PREVIEW_LINES = 10;
type PreviewTheme = Pick<Theme, "fg" | "bold">;

/** Complete or streamed creation arguments accepted by the document preview. */
export interface CreatePreviewArguments {
  readonly title?: string;
  readonly content?: string;
  readonly filename?: string;
  readonly folder?: string;
  readonly format?: "markdown" | "html";
}

/** Per-call display state supplied by Pi; the previous component is reused when possible. */
export interface CreatePreviewContext {
  readonly expanded: boolean;
  readonly lastComponent: Component | undefined;
}

/** Owns per-tool-row document/highlight caches rather than sharing note content across calls. */
class CreatePreview implements Component {
  private readonly text = new Text("", 0, 0);
  private output = "";
  private document:
    | {
        readonly title: string;
        readonly content: string;
        readonly format: HubbleNoteFormat;
        readonly lines: ReadonlyArray<string>;
      }
    | undefined;
  private highlighted:
    | {
        readonly source: string;
        readonly format: HubbleNoteFormat;
        readonly theme: PreviewTheme;
        readonly text: string;
      }
    | undefined;

  /** Clears theme-sensitive highlights as well as Text's width-dependent layout cache. */
  invalidate(): void {
    this.highlighted = undefined;
    this.text.invalidate();
  }

  render(width: number): string[] {
    return this.text.render(width);
  }

  /** Rebuilds normalized document lines only when document-generating arguments change. */
  private documentLines(title: string, content: string, format: HubbleNoteFormat): ReadonlyArray<string> {
    if (this.document?.title === title && this.document.content === content && this.document.format === format) {
      return this.document.lines;
    }

    const lines = buildNewNoteDocument(title, content, format).replaceAll("\r", "").replaceAll("\t", "   ").split("\n");

    while (lines.at(-1) === "") {
      lines.pop();
    }

    this.document = { title, content, format, lines };
    return lines;
  }

  /** Highlights just the visible prefix while collapsed, and reuses highlights on unchanged redraws. */
  private preview(
    lines: ReadonlyArray<string>,
    format: HubbleNoteFormat,
    theme: PreviewTheme,
    expanded: boolean
  ): string {
    const visible = expanded ? lines : lines.slice(0, CREATE_PREVIEW_LINES);
    const source = visible.join("\n");

    if (this.highlighted?.source === source && this.highlighted.format === format && this.highlighted.theme === theme) {
      return this.highlighted.text;
    }

    const text = highlightCode(source, format).join("\n");
    this.highlighted = { source, format, theme, text };
    return text;
  }

  update(args: CreatePreviewArguments, theme: PreviewTheme, expanded: boolean): void {
    const title = args.title ?? "";
    const content = args.content;
    const filename = args.filename ?? "";
    const inferredFormat = filename.toLowerCase().endsWith(".html") ? "html" : "markdown";
    const format = args.format === "html" ? "html" : inferredFormat;
    const folder = args.folder?.trim() ?? "";
    const destination = filename ? `${folder ? `${folder}/` : ""}${filename}` : folder ? `${folder}/` : "vault root";
    const titleDisplay = title ? JSON.stringify(title) : "...";
    let output = `${theme.fg("toolTitle", theme.bold("hubble_create"))} ${theme.fg("accent", titleDisplay)}`;
    output += theme.fg("dim", ` → ${destination} (${format})`);

    if (title && content !== undefined) {
      const lines = this.documentLines(title, content, format);
      const remaining = expanded ? 0 : Math.max(0, lines.length - CREATE_PREVIEW_LINES);
      output += `\n\n${this.preview(lines, format, theme, expanded)}`;

      if (remaining > 0) {
        output += `${theme.fg("muted", `\n... (${remaining} more lines, ${lines.length} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
      }
    }

    // Text.setText invalidates wrapping, even if the contents did not change.
    if (output !== this.output) {
      this.output = output;
      this.text.setText(output);
    }
  }
}

/**
 * Renders the create destination and an expandable document preview without writing files.
 * Reuses per-call highlights and layout on redraws; collapsed previews highlight only ten lines.
 */
export function renderCreatePreview(
  args: CreatePreviewArguments,
  theme: PreviewTheme,
  context: CreatePreviewContext
): Component {
  const component = context.lastComponent instanceof CreatePreview ? context.lastComponent : new CreatePreview();
  component.update(args, theme, context.expanded);
  return component;
}
