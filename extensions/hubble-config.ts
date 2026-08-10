import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Result, type Result as ResultType, TaggedError } from "better-result";

const CONFIG_FILENAME = "hubble.json";

export class ConfigReadError extends TaggedError("ConfigReadError")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export class ConfigParseError extends TaggedError("ConfigParseError")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export class InvalidConfigError extends TaggedError("InvalidConfigError")<{
  path: string;
  input?: unknown;
  message: string;
}> {}

export class VaultNotConfiguredError extends TaggedError("VaultNotConfiguredError")<{
  globalPath: string;
  localPath?: string;
  message: string;
}> {}

export type ConfigError = ConfigReadError | ConfigParseError | InvalidConfigError | VaultNotConfiguredError;

function expandPath(value: string, cwd: string, source: string): ResultType<string, InvalidConfigError> {
  const trimmed = value.trim();
  if (!trimmed) {
    return Result.err(
      new InvalidConfigError({ path: source, input: value, message: "Hubble vault path must not be empty." })
    );
  }

  if (trimmed === "~") return Result.ok(homedir());
  if (trimmed.startsWith("~/")) return Result.ok(resolve(homedir(), trimmed.slice(2)));
  return Result.ok(isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed));
}

function getStringFlag(value: unknown): ResultType<string | undefined, InvalidConfigError> {
  if (value === undefined || value === null || value === false) return Result.ok(undefined);
  if (typeof value !== "string") {
    return Result.err(
      new InvalidConfigError({ path: "--hubble-dir", input: value, message: "--hubble-dir requires a path." })
    );
  }
  return Result.ok(value);
}

async function readConfiguredRoot(
  configPath: string
): Promise<ResultType<string | undefined, ConfigReadError | ConfigParseError | InvalidConfigError>> {
  const source = await Result.tryPromise({
    try: () => readFile(configPath, "utf8"),
    catch: (cause) =>
      new ConfigReadError({ path: configPath, cause, message: `Could not read Hubble configuration: ${configPath}.` }),
  });
  if (Result.isError(source)) {
    if (isMissingFileError(source.error.cause)) return Result.ok(undefined);
    return source;
  }

  const parsed = Result.try({
    try: () => JSON.parse(source.value) as unknown,
    catch: (cause) =>
      new ConfigParseError({
        path: configPath,
        cause,
        message: `Could not parse Hubble configuration: ${configPath}.`,
      }),
  });
  if (Result.isError(parsed)) return parsed;

  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return Result.err(
      new InvalidConfigError({ path: configPath, message: `${configPath}: the config must be a JSON object.` })
    );
  }

  const root = (parsed.value as { root?: unknown }).root;
  if (root === undefined) return Result.ok(undefined);
  if (typeof root !== "string") {
    return Result.err(
      new InvalidConfigError({ path: configPath, input: root, message: `${configPath}: "root" must be a string.` })
    );
  }
  return Result.ok(root);
}

/** Resolve config with CLI precedence. Project-local config is trusted-context only. */
export async function resolveHubbleRoot(
  cliValue: unknown,
  cwd = process.cwd(),
  projectTrusted = true
): Promise<ResultType<string, ConfigError>> {
  const cliRoot = getStringFlag(cliValue);
  if (Result.isError(cliRoot)) return cliRoot;
  if (cliRoot.value !== undefined) return expandPath(cliRoot.value, cwd, "--hubble-dir");

  const globalPath = resolve(getAgentDir(), CONFIG_FILENAME);
  const localPath = resolve(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);
  const globalRoot = await readConfiguredRoot(globalPath);
  if (Result.isError(globalRoot)) return globalRoot;

  let localRoot: ResultType<string | undefined, ConfigError> = Result.ok(undefined);
  if (projectTrusted) {
    localRoot = await readConfiguredRoot(localPath);
    if (Result.isError(localRoot)) return localRoot;
  }

  const configuredRoot = localRoot.value ?? globalRoot.value;
  if (configuredRoot === undefined) {
    return Result.err(
      new VaultNotConfiguredError({
        globalPath,
        localPath: projectTrusted ? localPath : undefined,
        message: "Hubble vault is not configured. Set a Hubble root or pass --hubble-dir /path/to/vault.",
      })
    );
  }

  return expandPath(configuredRoot, cwd, projectTrusted && localRoot.value !== undefined ? localPath : globalPath);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
