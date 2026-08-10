import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Result, type Result as ResultType } from "better-result";
import { OutputPersistenceError } from "./hubble-errors.ts";
import type { TruncatedOutput } from "./hubble-types.ts";

export async function truncateOutput(output: string): Promise<ResultType<TruncatedOutput, OutputPersistenceError>> {
  const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncation.truncated) return Result.ok({ text: truncation.content, truncated: false });

  const directory = await Result.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "pi-hubble-")),
    catch: (cause) => new OutputPersistenceError({ cause, message: "Could not persist the full Hubble tool output." }),
  });
  if (Result.isError(directory)) return directory;
  const fullOutputPath = join(directory.value, "output.txt");
  const persisted = await withFileMutationQueue(fullOutputPath, () =>
    Result.tryPromise({
      try: () => writeFile(fullOutputPath, output, "utf8"),
      catch: (cause) =>
        new OutputPersistenceError({ cause, message: "Could not persist the full Hubble tool output." }),
    })
  );
  if (Result.isError(persisted)) return persisted;

  const text = `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
  return Result.ok({ text, truncated: true, fullOutputPath });
}
