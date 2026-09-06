# pi-hubble

## Whitespace

Use whitespace to make the structure of code immediately apparent. Group related
statements together and separate distinct phases of control flow with blank lines.
Avoid both dense blocks and unnecessary blank lines.

Prefer formatting that makes operations, early returns, and side effects easy to scan.

Bad example

```ts
export async function readVaultFile(
  path: HubblePath,
  fileSystem: NoteFileSystem = nodeFileSystem
): Promise<NoteReadResult> {
  const accessible = await Result.tryPromise({
    try: () => fileSystem.access(path.absolute, constants.R_OK),
    catch: (cause) => noteReadError(path, cause),
  });
  if (Result.isError(accessible)) return accessible;
  const fileStat = await Result.tryPromise({
    try: () => fileSystem.stat(path.absolute),
    catch: (cause) => noteReadError(path, cause),
  });
  if (Result.isError(fileStat)) return fileStat;
  if (!fileStat.value.isFile())
    return Result.err(
      new NoteReadError({ path: path.relative, cause: undefined, message: "The requested Hubble path is not a file." })
    );
  return withFileMutationQueue(path.absolute, () =>
    Result.tryPromise({
      try: () => fileSystem.readFile(path.absolute, "utf8"),
      catch: (cause) => noteReadError(path, cause),
    })
  );
}
```

Good example

```ts
export async function readVaultFile(
  path: HubblePath,
  fileSystem: NoteFileSystem = nodeFileSystem
): Promise<NoteReadResult> {
  const accessible = await Result.tryPromise({
    try: () => fileSystem.access(path.absolute, constants.R_OK),
    catch: (cause) => noteReadError(path, cause),
  });

  if (Result.isError(accessible)) {
    return accessible;
  }

  const fileStat = await Result.tryPromise({
    try: () => fileSystem.stat(path.absolute),
    catch: (cause) => noteReadError(path, cause),
  });

  if (Result.isError(fileStat)) {
    return fileStat;
  }

  if (!fileStat.value.isFile()) {
    return Result.err(
      new NoteReadError({
        path: path.relative,
        cause: undefined,
        message: "The requested Hubble path is not a file.",
      })
    );
  }

  return withFileMutationQueue(path.absolute, () =>
    Result.tryPromise({
      try: () => fileSystem.readFile(path.absolute, "utf8"),
      catch: (cause) => noteReadError(path, cause),
    })
  );
}
```

## Error handling

Represent expected and recoverable errors as `Result<T, E>` values using
`better-result`.

Use tagged errors from `extensions/hubble-errors.ts` and wrap filesystem or
JSON operations with `Result.try` / `Result.tryPromise`.

Do not convert programmer defects into `Result` values. Exceptions are allowed
at integration boundaries, for cancellation, and in tests. Pi tool handlers
should use the existing `throwHubbleError` boundary; UI handlers should notify
the user and return. These rules also apply to production scripts: represent
expected CLI, Git, and filesystem failures as values, then render them and set
the exit status at the outermost CLI boundary.

## Documentation

Add concise JSDoc to every new exported production symbol and every new
non-obvious internal helper. Document exported APIs' behavior, side effects,
and possible `Result` errors. Test-only helpers do not require JSDoc unless
they are non-obvious.

## Type safety

Keep the strict options in `tsconfig.json` enabled. Prefer readonly domain and
API values. Avoid non-null assertions, `any`, and non-`as const` casts. When a
boundary or branding cast is unavoidable, add a `// SAFETY:` comment explaining
the invariant that makes it sound.

## Vault safety

All user-supplied vault paths must remain vault-relative, reject traversal and
absolute paths, reject symlink escapes, and only operate on supported Hubble note files.
Use the existing path-resolution helpers rather than joining user input
directly. Do not manually construct `HubblePath`, `NoteReference`, or
`VaultRoot` values; obtain them through `Vault.open`, path resolution, or vault
discovery.

All vault mutations must use Pi's `withFileMutationQueue`.

## Testing

Add tests for both success and structured failure cases. Prefer asserting
`Result.status`, tagged error `_tag`, and preserved causes where relevant.

Security-sensitive behavior, filesystem failures, and concurrent mutations
should have regression tests.

Prefer tests through public APIs and real seams. Do not add new module mocks or
spy-driven assertions. When touching existing module-mocked filesystem tests,
prefer migrating the affected behavior to a narrow injected filesystem seam.

Before finishing, run:

    npm test
    npm run typecheck
    npm run lint
    npm run test:integration

## Documentation updates

Update `README.md` when changing user-visible commands, configuration, tools,
or installation behavior.
