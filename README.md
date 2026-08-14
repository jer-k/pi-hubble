# pi-hubble

Pi extension for searching, reading, creating, and editing Markdown and HTML notes in [Hubble.md](https://hubble.md).

## Install

From GitHub:

```bash
pi install git:github.com/jer-k/pi-hubble
```

For a temporary run from a local checkout:

```bash
pi -e /path/to/pi-hubble
```

For development, load the extension directly:

```bash
pi -e ./extensions/hubble.ts
```

## Vault configuration

Hubble reads the vault root in this order:

1. Global config: `~/.pi/agent/hubble.json` (or `$PI_CODING_AGENT_DIR/hubble.json`)
2. Local config: `.pi/hubble.json`
3. `--hubble-dir /path/to/vault`

The latest configured value wins. Example config:

```json
{
  "root": "/path/to/vault"
}
```

There is no default vault. If no config or command-line flag provides a root,
the extension reports a configuration error. The `root` value may use `~` and
may be an absolute or relative path. Relative paths are resolved from Pi's
current working directory.

## Tools

The extension registers these Pi tools:

- `hubble_search(query, limit?)` searches note contents case-insensitively and
  returns matching lines. `limit` defaults to 100 and may be between 1 and 500.
- `hubble_read(path, offset?, limit?)` reads a vault-relative Markdown or HTML
  path. `offset` is a 1-based line number; `limit` controls the number of lines.
- `hubble_create(title, content, folder?, format?)` creates a new note,
  optionally in a vault-relative folder. `format` is `markdown` (the default)
  or `html`.
- `hubble_edit(path, edits)` applies one or more exact, unique,
  non-overlapping text replacements to Markdown or HTML. Every edit is matched
  against the original note rather than the result of an earlier replacement.

All document paths are relative to the configured vault and must use `.md` or
`.html` (case-insensitively). Search operates line-by-line on note source, so
HTML is searched as raw source. Search and read output is limited to 50 KB or
2,000 lines; when output is truncated, the complete result is saved to a
temporary file.

`hubble_create` converts the title into a filename slug and never overwrites an
existing note. Markdown creation preserves the `# Title` heading behavior. HTML
creation escapes the title and wraps `content` as a body fragment in a valid
standalone document. Collisions are format-specific, producing names such as
`my-note-2.md` or `my-note-2.html`.

Writes are serialized with Pi's file mutation queue. Existing notes are edited
by writing and syncing a same-directory temporary file, closing it, and
atomically renaming it over the original so a failed edit cannot truncate the
note. Edits preserve UTF-8 BOMs, line-ending style, and file permissions. Paths
are checked against path traversal and symlink escapes, and note discovery
recursively scans the vault while skipping symlinks.

## Interactive discovery

- `@hubble/` autocomplete for attaching a vault note to the prompt; after typing
  a folder prefix, suggestions show only the remaining path so filename endings
  and extensions remain visible
- `/hubble find <query>` to find note filenames explicitly
- `/hubble search <query>` to search note contents
- `/hubble new [title] [--format markdown|html] [--folder <folder>]` to create
  and attach a blank note

`/hubble new` defaults to Markdown and prompts for a title and an optional
vault-relative folder. If the title is left blank, the agent chooses a title
and drafts the requested note format using `hubble_create` when it is idle.

After selecting a note, its absolute path is inserted as a normal Pi `@` file
reference, so the note is attached to the current prompt.

## Development

Run the unit test suite and checks with:

```bash
npm test
npm run typecheck
npm run lint
```

Run the Pi CLI integration smoke test separately:

```bash
npm run test:integration
```

The integration suite uses the project-local Pi executable to exercise `/hubble new` through RPC mode with `--hubble-dir`. It also loads this checkout through Pi's SDK runtime to exercise every Hubble tool and the `@hubble/` autocomplete provider without requiring an LLM or API credentials.

## License

This project is licensed under the [MIT License](LICENSE).
