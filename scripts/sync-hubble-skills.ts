#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { syncHubbleSkills } from "./hubble-skill-sync.ts";

const result = await syncHubbleSkills(process.argv.slice(2), {
  repositoryRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  upstreamRepository: "https://github.com/bholmesdev/hubble-skills.git",
});

if (result.status === "error") {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  console.log(result.value);
}
