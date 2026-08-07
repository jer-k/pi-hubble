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
import type { HubblePath } from "./hubble-vault.ts";

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

export class HubbleNotePicker extends Container implements Focusable {
  private readonly tui: HubbleTui;
  private readonly theme: HubbleTheme;
  private readonly keybindings: HubbleKeybindings;
  private readonly notes: HubblePath[];
  private readonly onSelectNote: (note: HubblePath | undefined) => void;
  private readonly search = new Input();
  private readonly listContainer = new Container();
  private filteredNotes: HubblePath[];
  private list: SelectList;
  private _focused = false;

  constructor(
    tui: HubbleTui,
    theme: HubbleTheme,
    keybindings: HubbleKeybindings,
    notes: HubblePath[],
    initialQuery: string,
    onSelect: (note: HubblePath | undefined) => void
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

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  private createList(): SelectList {
    const items: SelectItem[] = this.filteredNotes.map((note) => ({
      value: note.relative,
      label: note.relative,
      description: "Markdown note",
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

  private updateFilter(): void {
    const query = this.search.getValue().trim();
    this.filteredNotes = query ? fuzzyFilter(this.notes, query, (note) => note.relative) : this.notes;
    this.listContainer.clear();
    this.list = this.createList();
    this.listContainer.addChild(this.list);
    this.tui.requestRender();
  }

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

  override invalidate(): void {
    super.invalidate();
    this.search.invalidate();
    this.list.invalidate();
  }
}
