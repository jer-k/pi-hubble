# Write latency benchmarks

For end-to-handler measurements of all seven tools, see [tool benchmarks](tools.md).

## Reproduce

```bash
npm run bench:writes
npm run bench:writes -- --iterations 30 --source /path/to/EP-097-linear-stan-map-stationarity-acceptance.md
```

The default synthetic document is exactly **23,688 UTF-8 bytes**, matching the
reported ticket. It includes headings, checklists, and fenced code without
copying private note content into the repository. `--source` reads a local file
once and uses its first Markdown H1 as the title. Normal LF Markdown with an H1
and blank separator preserves the original document bytes; other inputs can be
reformatted by normal note creation. The report always shows actual output bytes.

Use `--temp-parent DIRECTORY` to measure another filesystem. Each run allocates
an isolated temporary vault beneath that directory and removes it afterward.
Existing notes, including the source, are never modified.

## Method

- Storage timings invoke the public `Vault.create` API, including path resolution,
  queue acquisition, exclusive open, opened-file verification, write, and close.
- Unique names use exact filenames; the nested case uses a folder shaped like
  `jer-k/effect-prophet/tickets/TODO`.
- The crowded-slug case starts with 100 occupied names and adds another note on
  each iteration. It uses the benchmark title, so its source-based output is
  slightly smaller than the original ticket. The synthetic case remains 23,688 bytes.
- Each created note is read back and compared with the expected full document
  **outside** the timed interval. Setup, cleanup, and vault opening are excluded.
- Storage/redraw cases have two warmups. Streaming has one warmup and simulates
  successive 128-character content updates to a collapsed preview, reusing the
  same component and rendering at 120 columns. Header colors are passthrough;
  document syntax highlighting uses Pi's initialized dark theme.
- Redraw measurements intentionally reuse already-rendered components. They
  measure repeated redraws, not the first highlight or first expansion.
- Median/p95 are nearest-rank percentiles over 30 measured iterations. There are
  no hard timing gates in tests, since filesystem and scheduling noise vary.

This measures extension work, **not** LLM token generation, provider/network
latency, terminal transport, or end-to-end Pi tool execution. It cannot establish
what delayed the original agent without tracing that session.

## Local before/after

Environment: Node v23.11.0, macOS (`darwin`), arm64, local temporary filesystem.
Both runs used the actual reported ticket as a read-only source. The baseline
used the original collision allocator and full-document highlighting; the
optimized run used directory-name hints and per-row visible-preview caches.
Numbers below are milliseconds, not seconds.

| Scenario                      |  Bytes | Before median / p95 | After median / p95 |
| ----------------------------- | -----: | ------------------: | -----------------: |
| Create ticket-sized           | 23,688 |       0.430 / 0.623 |      0.411 / 0.609 |
| Create nested exact filename  | 23,688 |       0.424 / 0.567 |      0.431 / 0.649 |
| Create occupied slug (100+)   | 23,629 |      9.092 / 10.635 |      0.665 / 0.856 |
| Collapsed redraw              | 23,688 |       1.099 / 1.991 |      0.002 / 0.010 |
| Expanded redraw               | 23,688 |       3.093 / 3.671 |      0.008 / 0.010 |
| Collapsed stream, all updates | 23,688 |    94.414 / 119.139 |    15.196 / 16.009 |

Ordinary creation was already fast and did **not** materially improve. Crowded
slug allocation improved approximately **14×**, and simulated streamed preview
work approximately **6×** for this document. The default synthetic document's
optimized median was 0.405 ms for creation and 2.909 ms for streamed previews;
content structure affects rendering costs even at identical byte sizes.

## Safety and regression coverage

The directory snapshot is an optional allocation hint, not authorization or an
overwrite check. Every selected target still goes through existing vault path
resolution, Pi mutation queues, exclusive `wx` open, identity verification,
write/close handling, and failure cleanup. Unreadable directory snapshots retain
the original collision fallback. Existing atomic-edit syncing is unchanged.

Tests cover namespace gaps, occupied directories, explicit-filename conflicts,
external creation after a snapshot, concurrent creates, symlink replacement,
structured open/I/O failures, source preservation, and scratch cleanup. Preview
tests cover streaming, expansion, argument/format changes, theme invalidation,
and independent tool rows. Pi SDK integration also creates a ticket-sized note
and verifies scoped `TODO/` completion with more than 50 sibling `DONE/` notes.
