import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Result } from "better-result";
import { registerHubbleAutocomplete } from "./hubble-autocomplete.ts";
import type { GetRoot, RootResult } from "./hubble-boundary.ts";
import { registerHubbleCommand } from "./hubble-command.ts";
import { resolveHubbleRoot } from "./hubble-config.ts";
import { registerHubbleTools } from "./hubble-tools.ts";

export { throwCreateToolError } from "./hubble-boundary.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerFlag("hubble-dir", {
    description: "Hubble vault root for this session (overrides Hubble config)",
    type: "string",
  });

  // Pi applies CLI extension flag values after loading extension factories, so
  // resolve the root lazily when the first operation runs. Failed resolution is
  // deliberately not cached so configuration can be fixed during a session.
  let rootPromise: Promise<RootResult> | undefined;
  const getRoot: GetRoot = (context) => {
    rootPromise ??= resolveHubbleRoot(
      pi.getFlag("hubble-dir"),
      context.cwd,
      context.isProjectTrusted()
    ).then(
      (result) => {
        if (Result.isError(result)) rootPromise = undefined;
        return result;
      },
      (cause) => {
        rootPromise = undefined;
        throw cause;
      }
    );

    return rootPromise;
  };

  registerHubbleAutocomplete(pi, getRoot);
  registerHubbleCommand(pi, getRoot);
  registerHubbleTools(pi, getRoot);
}
