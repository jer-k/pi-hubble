import {
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type { NoteReference } from "./hubble-vault.ts";

/** Formats a filesystem path as an escaped @ attachment for the Pi editor. */
export function attachmentValue(path: string): string {
  if (path.includes(" ") || path.includes('"')) return `@"${path.replaceAll('"', '\\"')}"`;
  return `@${path}`;
}

const MAX_VISIBLE_NOTES = 12;

interface HubbleTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface HubbleKeybindings {
  matches(data: string, key: string): boolean;
}

interface HubbleTui {
  requestRender(): void;
}

/** Provides an interactive, filterable list for selecting a Hubble note attachment. */
export class HubbleNotePicker extends Container implements Focusable {
  private readonly tui: HubbleTui;
  private readonly theme: HubbleTheme;
  private readonly keybindings: HubbleKeybindings;
  private readonly notes: NoteReference[];
  private readonly onSelectNote: (note: NoteReference | undefined) => void;
  private readonly search = new Input();
  private readonly listContainer = new Container();
  private filteredNotes: NoteReference[];
  private list: SelectList;
  private _focused = false;

  /** Builds the picker UI and initializes it with the available notes. */
  constructor(
    tui: HubbleTui,
    theme: HubbleTheme,
    keybindings: HubbleKeybindings,
    notes: NoteReference[],
    initialQuery: string,
    onSelect: (note: NoteReference | undefined) => void
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.notes = notes;
    this.onSelectNote = onSelect;
    this.filteredNotes = notes;
    this.search.setValue(initialQuery);

    this.addChild(new Text(theme.fg("accent", theme.bold("Hubble notes")), 1, 0));
    this.addChild(new Text(theme.fg("dim", "Type to filter by filename"), 1, 0));
    this.addChild(this.search);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "↑↓ navigate · Enter attach · Esc cancel"), 1, 0));

    this.list = this.createList();
    this.listContainer.addChild(this.list);
    this.updateFilter();
  }

  /** Reports whether the picker currently owns keyboard focus. */
  get focused(): boolean {
    return this._focused;
  }

  /** Updates picker focus and forwards it to the filename search input. */
  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  /** Builds the selectable list from the current filtered notes. */
  private createList(): SelectList {
    const items: SelectItem[] = this.filteredNotes.map((note) => ({
      value: note.relative,
      label: note.relative,
      description: note.relative.toLowerCase().endsWith(".html") ? "HTML note" : "Markdown note",
    }));
    const list = new SelectList(items, Math.min(MAX_VISIBLE_NOTES, Math.max(items.length, 1)), {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });

    list.onSelect = (item) => {
      this.onSelectNote(this.filteredNotes.find((note) => note.relative === item.value));
    };

    list.onCancel = () => this.onSelectNote(undefined);
    return list;
  }

  /** Recomputes filename matches and refreshes the visible note list. */
  private updateFilter(): void {
    const query = this.search.getValue().trim();
    this.filteredNotes = query ? fuzzyFilter(this.notes, query, (note) => note.relative) : this.notes;
    this.listContainer.clear();
    this.list = this.createList();
    this.listContainer.addChild(this.list);
    this.tui.requestRender();
  }

  /** Routes keyboard input to navigation or filename filtering. */
  handleInput(data: string): void {
    const isNavigation = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"].some((key) =>
      this.keybindings.matches(data, key)
    );

    if (isNavigation) {
      this.list.handleInput(data);
    } else {
      this.search.handleInput(data);
      this.updateFilter();
    }
    this.tui.requestRender();
  }

  /** Invalidates the picker and its child controls before a redraw. */
  override invalidate(): void {
    super.invalidate();
    this.search.invalidate();
    this.list.invalidate();
  }
}
