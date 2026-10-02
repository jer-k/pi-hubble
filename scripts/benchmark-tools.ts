#!/usr/bin/env node

import { runToolBenchmark } from "./hubble-tool-benchmark.ts";

const result = await runToolBenchmark(process.argv.slice(2));

if (result.status === "error") {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  console.log(result.value);
}
