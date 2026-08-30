import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Result, type Result as ResultType, TaggedError } from "better-result";
import { mapFileSystemError, MissingFileError, type VaultOpenErrorType } from "./hubble-errors.ts";
import type { Vault } from "./hubble-vault.ts";

const CONFIG_FILENAME = "hubble.json";

/** Failure to read a Hubble configuration file. */
export class ConfigReadError extends TaggedError("ConfigReadError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Failure to parse a Hubble configuration file as JSON. */
export class ConfigParseError extends TaggedError("ConfigParseError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A parsed Hubble configuration value with an unsupported shape or value. */
export class InvalidConfigError extends TaggedError("InvalidConfigError")<{
  readonly path: string;
  readonly input?: unknown;
  readonly message: string;
}> {}

/** Absence of a vault root in CLI, trusted local, and global configuration. */
export class VaultNotConfiguredError extends TaggedError("VaultNotConfiguredError")<{
  readonly globalPath: string;
  readonly localPath?: string;
  readonly message: string;
}> {}

/** Expected failures while resolving Hubble configuration. */
export type ConfigError = ConfigReadError | ConfigParseError | InvalidConfigError | VaultNotConfiguredError;
/** Pi context fields required to resolve a vault root safely. */
export type RootContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;
/** Lazily obtains an opened Vault for a Pi extension context. */
export type GetVault = (context: RootContext) => Promise<ResultType<Vault, ConfigError | VaultOpenErrorType>>;

/** Expands a configured vault path relative to the current working directory. */
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

/** Validates and normalizes the optional --hubble-dir flag value. */
function getStringFlag(value: unknown): ResultType<string | undefined, InvalidConfigError> {
  if (value === undefined || value === null || value === false) return Result.ok(undefined);

  if (typeof value !== "string") {
    return Result.err(
      new InvalidConfigError({ path: "--hubble-dir", input: value, message: "--hubble-dir requires a non-empty path." })
    );
  }

  return Result.ok(value);
}

/** Reads and validates a Hubble root from one JSON configuration file. */
async function readConfiguredRoot(
  configPath: string
): Promise<ResultType<string | undefined, ConfigReadError | ConfigParseError | InvalidConfigError>> {
  const source = await Result.tryPromise({
    try: () => readFile(configPath, "utf8"),
    catch: (cause) => {
      const filesystemError = mapFileSystemError(configPath, cause);
      return MissingFileError.is(filesystemError)
        ? filesystemError
        : new ConfigReadError({ path: configPath, cause, message: "Could not read the Hubble configuration." });
    },
  });

  if (Result.isError(source)) {
    const error = source.error;
    if (MissingFileError.is(error)) return Result.ok(undefined);
    if (ConfigReadError.is(error)) return Result.err(error);
    return Result.err(
      new ConfigReadError({ path: configPath, cause: error, message: "Could not read the Hubble configuration." })
    );
  }

  const parsed = Result.try({
    try: (): unknown => JSON.parse(source.value),
    catch: (cause) =>
      new ConfigParseError({
        path: configPath,
        cause,
        message: "Could not parse the Hubble configuration.",
      }),
  });

  if (Result.isError(parsed)) return parsed;

  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return Result.err(
      new InvalidConfigError({ path: configPath, message: "The Hubble configuration must be a JSON object." })
    );
  }

  const root = "root" in parsed.value ? parsed.value.root : undefined;
  if (root === undefined) return Result.ok(undefined);

  if (typeof root !== "string") {
    return Result.err(
      new InvalidConfigError({
        path: configPath,
        input: root,
        message: "The Hubble configuration root must be a string.",
      })
    );
  }

  return Result.ok(root);
}

/** Resolves the vault root using CLI, trusted local, then global configuration precedence. */
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
        ...(projectTrusted ? { localPath } : {}),
        message: "Hubble vault is not configured. Set a Hubble root or pass --hubble-dir /path/to/vault.",
      })
    );
  }

  return expandPath(configuredRoot, cwd, projectTrusted && localRoot.value !== undefined ? localPath : globalPath);
}
