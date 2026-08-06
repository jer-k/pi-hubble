import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const DEFAULT_ROOT = "~/Hubble";

function expandPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Hubble vault path must not be empty.");
  }

  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

function getStringFlag(value: unknown): string | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value !== "string") {
    throw new Error("--hubble-dir requires a path.");
  }
  return value;
}

/** Resolve the vault root using the documented precedence order. */
export async function resolveHubbleRoot(cliValue: unknown): Promise<string> {
  const cliRoot = getStringFlag(cliValue);
  if (cliRoot) return expandPath(cliRoot);

  const environmentRoot = process.env.HUBBLE_DIR?.trim();
  if (environmentRoot) return expandPath(environmentRoot);

  const configPath = resolve(getAgentDir(), "hubble.json");
  let configRoot: unknown;
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error("the config must be a JSON object");
    }
    configRoot = (config as { root?: unknown }).root;
  } catch (error) {
    if (isMissingFileError(error)) {
      return expandPath(DEFAULT_ROOT);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${configPath}: ${message}`);
  }

  if (configRoot === undefined) return expandPath(DEFAULT_ROOT);
  if (typeof configRoot !== "string") {
    throw new Error(`${configPath}: "root" must be a string.`);
  }
  return expandPath(configRoot);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
