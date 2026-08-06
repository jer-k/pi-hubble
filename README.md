# pi-hubble

Pi tools for searching and editing a Markdown vault such as `~/Hubble`.

## Development

```bash
pi -e ./extensions/hubble.ts
```

The package can be installed globally with:

```bash
pi install /path/to/pi-hubble
```

## Vault configuration

Configuration is resolved in this order:

1. `--hubble-dir /path/to/vault`
2. `HUBBLE_DIR=/path/to/vault`
3. `~/.pi/agent/hubble.json` (or `$PI_CODING_AGENT_DIR/hubble.json`)
4. `~/Hubble`

Example `hubble.json`:

```json
{
  "root": "~/Hubble"
}
```

## Tools

- `hubble_search(query, limit?)`
- `hubble_read(path, offset?, limit?)`
- `hubble_create(title, content, folder?)`
- `hubble_edit(path, edits)`
- `hubble_append(path, content)`

All document paths are relative to the configured vault and must point to Markdown files. Writes are serialized with Pi's file mutation queue, creation is non-overwriting, and paths are checked against traversal and symlink escapes.

## Interactive discovery

When running interactively, the extension also provides:

- `@hubble/` autocomplete for attaching a vault note to the prompt
- `/hubble` to browse and attach a note
- `/hubble new [title] [--folder <folder>]` to create and attach a blank note
  - Omitting the title prompts for one; leaving it blank asks the agent to choose a title and draft the note
  - Omitting the folder prompts for an optional vault-relative folder
- `/hubble search <query>` to find notes containing text
- `/hubble open <query>` to filter note filenames

After selecting a note, its absolute path is inserted as a normal Pi `@` file reference.
