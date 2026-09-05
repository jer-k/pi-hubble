# pi-hubble

Pi package for searching, reading, creating, and editing Markdown and HTML notes in [Hubble.md](https://hubble.md). It bundles the extension and Hubble's upstream HTML App skill.

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

Loading the extension file directly does not load the bundled skill. Use `pi -e /path/to/pi-hubble` when testing the complete package.

Development targets Node.js 26 and pins the current release in `.tool-versions`. With asdf, install it and restore dependencies with:

```bash
asdf install
npm ci
```

## Bundled skill

The package includes Hubble's upstream `create-html-app` skill. It teaches Pi to build folder-local HTML Apps with Hubble's injected Alpine, Tailwind, theme-token, and Files API runtime.

The contents under `skills/` are vendored verbatim from [`bholmesdev/hubble-skills`](https://github.com/bholmesdev/hubble-skills). Do not edit them locally. `skills/upstream.json` records the source ref and exact commit.

To update the vendored copy manually or verify it against the latest upstream `main` branch:

```bash
npm run sync:skills
npm run check:skills
```

Sync stages and validates upstream before installing a sibling copy. If the
installation rename fails, the previous skills are restored. If restoration
also fails, the command reports the retained backup path for recovery.

The weekly `sync-hubble-skills` GitHub Actions workflow runs the same sync and opens or updates a pull request when upstream changes.

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

- `hubble_search(query, limit?, offset?)` searches note contents case-insensitively and
  returns matching lines. `limit` defaults to 100 and may be between 1 and 500.
  Capped results include a continuation notice and `nextOffset`; pass that value
  as the 1-based matching-line `offset` to retrieve the next page. Pages reflect
  the current vault, so concurrent note changes can shift their offsets. Tool
  searches stop after the page and one lookahead match, retaining only that page.
- `hubble_read(path, offset?, limit?)` reads a vault-relative Markdown or HTML
  path. `offset` is a 1-based line number; `limit` controls the number of lines.
- `hubble_create(title, content, filename?, folder?, format?)` creates a new
  note, optionally with an exact filename or in a vault-relative folder.
  `format` is `markdown` (the default) or `html`.
- `hubble_edit(path, edits)` applies one or more exact, unique,
  non-overlapping text replacements to Markdown or HTML. Every edit is matched
  against the original note rather than the result of an earlier replacement.

All document paths are relative to the configured vault and must use `.md` or
`.html` (case-insensitively). Search operates line-by-line on note source, so
HTML is searched as raw source. Search and read output is limited to 50 KB or
2,000 lines; when output is truncated, the complete selected page or read range is saved to a
temporary file. Search pagination and byte truncation are reported separately
through `hasMore`/`nextOffset` and `fullOutputPath`.

When `filename` is omitted, `hubble_create` converts the title into a filename
slug and resolves collisions with names such as `my-note-2.md` or
`my-note-2.html`. When provided, `filename` must be a basename ending in `.md`
or `.html`; it is used exactly, its extension determines the format when
`format` is omitted, and creation fails if it already exists. Markdown creation
preserves the `# Title` heading behavior. HTML creation escapes the title and
wraps `content` as a body fragment in a valid standalone document. In Pi's TUI,
create calls show a syntax-highlighted document preview that can be expanded
with the normal tool expansion keybinding.

Writes are serialized with Pi's file mutation queue. Creation also holds the destination file's queue so concurrent Pi reads and edits wait for the complete note or its failure cleanup. Existing notes are edited
by writing and syncing a same-directory temporary file, closing it, and
atomically renaming it over the original so a failed edit cannot truncate the
note. Edits check for external content or metadata changes before committing and report a conflict so the agent can reread and retry. This optimistic check cannot lock out a Hubble save between the final check and rename. Edits preserve UTF-8 BOMs, line-ending style, and file permissions. Paths
are checked against path traversal and symlink escapes, and note discovery
recursively scans the vault while skipping symlinks. Discovery revalidates the
root, directories, and note paths so replacements after opening the vault are rejected.

## Interactive discovery

- `@hubble/` autocomplete for attaching a vault note to the prompt; discovery
  is cached for up to one second and refreshed immediately after this extension
  creates a note. Suggested paths are rechecked even when cached. After typing
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

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, tool routes, and note-write flow.

Run the unit test suite and checks with:

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
```

Use `npm run format` to apply Oxfmt, including deterministic import ordering.

Run the Pi CLI integration smoke test separately:

```bash
npm run test:integration
```

Check whether the bundled skills match the latest upstream revision (requires network access and Git):

```bash
npm run check:skills
```

The integration suite uses the project-local Pi executable to exercise `/hubble new` through RPC mode with `--hubble-dir`. It also loads this checkout through Pi's SDK runtime to exercise every Hubble tool and the `@hubble/` autocomplete provider without requiring an LLM or API credentials.

## License

This project is licensed under the [MIT License](LICENSE).
