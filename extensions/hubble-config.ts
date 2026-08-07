import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILENAME = "hubble.json";

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

async function readConfiguredRoot(configPath: string): Promise<string | undefined> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${configPath}: ${message}`);
  }

  let config: unknown;
  try {
    config = JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${configPath}: ${message}`);
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${configPath}: the config must be a JSON object.`);
  }

  const root = (config as { root?: unknown }).root;
  if (root === undefined) return undefined;
  if (typeof root !== "string") {
    throw new Error(`${configPath}: "root" must be a string.`);
  }
  return root;
}

/** Resolve global config, then local config, with the CLI flag taking precedence. */
export async function resolveHubbleRoot(cliValue: unknown): Promise<string> {
  const cliRoot = getStringFlag(cliValue);
  if (cliRoot !== undefined) return expandPath(cliRoot);

  const globalPath = resolve(getAgentDir(), CONFIG_FILENAME);
  const localPath = resolve(process.cwd(), CONFIG_DIR_NAME, CONFIG_FILENAME);
  const globalRoot = await readConfiguredRoot(globalPath);
  const localRoot = await readConfiguredRoot(localPath);
  const configuredRoot = localRoot ?? globalRoot;

  if (configuredRoot === undefined) {
    throw new Error(
      `Hubble vault is not configured. Set "root" in ${globalPath} or ${localPath}, or pass --hubble-dir /path/to/vault.`
    );
  }
  return expandPath(configuredRoot);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
