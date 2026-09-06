import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Result } from "better-result";

import { registerHubbleAutocomplete } from "./hubble-autocomplete.ts";
import { registerHubbleCommand } from "./hubble-command.ts";
import { type GetVault, resolveHubbleRoot } from "./hubble-config.ts";
import { registerHubbleTools } from "./hubble-tools.ts";
import { openVault } from "./hubble-vault.ts";

export type { GetVault, RootContext } from "./hubble-config.ts";

/** Initializes the Hubble extension, including its flag, vault access, command, tools, and autocomplete. */
export default function (pi: ExtensionAPI): void {
  pi.registerFlag("hubble-dir", {
    description: "Hubble vault root for this session (overrides Hubble config)",
    type: "string",
  });

  // Configuration and Vault construction are lazy. A successful Vault is reused
  // for the session; failed attempts are not cached so users can recover.
  let vaultPromise: ReturnType<GetVault> | undefined;
  const getVault: GetVault = (context) => {
    vaultPromise ??= resolveHubbleRoot(pi.getFlag("hubble-dir"), context.cwd, context.isProjectTrusted())
      .then(async (root) => {
        if (Result.isError(root)) {
          return root;
        }

        return openVault(root.value);
      })
      .then(
        (result) => {
          if (result.status === "error") {
            vaultPromise = undefined;
          }

          return result;
        },
        (cause) => {
          vaultPromise = undefined;
          throw cause;
        }
      );
    return vaultPromise;
  };

  registerHubbleAutocomplete(pi, getVault);
  registerHubbleCommand(pi, getVault);
  registerHubbleTools(pi, getVault);
}
