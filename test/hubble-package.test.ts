import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("declares the extension and vendored HTML App skill as Pi package resources", async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    pi?: { extensions?: string[]; skills?: string[] };
  };

  expect(manifest.pi).toEqual({
    extensions: ["./extensions/hubble.ts"],
    skills: ["./skills/create-html-app"],
  });
});

test("records upstream provenance for every bundled skill", async () => {
  const provenance = JSON.parse(await readFile(join(repositoryRoot, "skills", "upstream.json"), "utf8")) as {
    repository?: string;
    commit?: string;
    skills?: string[];
  };

  expect(provenance.repository).toBe("https://github.com/bholmesdev/hubble-skills.git");
  expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/u);
  expect(provenance.skills).toEqual(["create-html-app"]);
  await Promise.all(
    (provenance.skills ?? []).map((skill) => access(join(repositoryRoot, "skills", skill, "SKILL.md")))
  );
});
