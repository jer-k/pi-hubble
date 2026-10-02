#!/usr/bin/env node

import { runWriteBenchmark } from "./hubble-write-benchmark.ts";

const result = await runWriteBenchmark(process.argv.slice(2));

if (result.status === "error") {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  console.log(result.value);
}
