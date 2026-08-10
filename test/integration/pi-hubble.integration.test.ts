import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  type AgentToolResult,
  type AutocompleteProviderFactory,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

type RpcMessage = Record<string, unknown>;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = join(repositoryRoot, "extensions", "hubble.ts");
const piExecutable =
  process.env.PI_BIN ?? join(repositoryRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");

function runPi(vault: string): Promise<RpcMessage[]> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      piExecutable,
      ["--no-extensions", "--mode", "rpc", "--no-session", "-e", extensionPath, "--hubble-dir", vault],
      { cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"] }
    );
    const decoder = new StringDecoder("utf8");
    const messages: RpcMessage[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let failure: Error | undefined;
    let receivedResponse = false;

    const parseAvailableLines = (flush = false): void => {
      stdoutBuffer += flush ? decoder.end() : "";
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex === -1) break;
        let line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line) continue;
        const message = JSON.parse(line) as RpcMessage;
        messages.push(message);
        if (message.type === "response" && message.id === "create") {
          receivedResponse = true;
          child.stdin.end();
        }
      }
      if (flush && stdoutBuffer) {
        const message = JSON.parse(
          stdoutBuffer.endsWith("\r") ? stdoutBuffer.slice(0, -1) : stdoutBuffer
        ) as RpcMessage;
        messages.push(message);
        stdoutBuffer = "";
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        stdoutBuffer += decoder.write(chunk);
        parseAvailableLines();
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("spawn", () => {
      child.stdin.write(
        `${JSON.stringify({
          id: "create",
          type: "prompt",
          message: "/hubble new Integration Smoke --folder=checks",
        })}\n`
      );
    });

    child.on("error", (error) => {
      failure = new Error(`Could not start the Pi integration test with ${piExecutable}: ${error.message}`, {
        cause: error,
      });
    });

    const timeout = setTimeout(() => {
      failure = new Error("Pi integration test timed out after 15 seconds.");
      child.kill("SIGKILL");
    }, 15_000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      try {
        parseAvailableLines(true);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
      if (failure) {
        rejectRun(failure);
        return;
      }
      if (code !== 0) {
        rejectRun(new Error(`Pi integration process exited with code ${code}.\n${stderr}`));
        return;
      }
      if (!receivedResponse) {
        rejectRun(new Error(`Pi exited without responding to the integration command.\n${stderr}`));
        return;
      }
      resolveRun(messages);
    });
  });
}

async function createIntegrationSession(workspace: string, vault: string): Promise<AgentSession> {
  const agentDir = join(workspace, "agent");
  await mkdir(join(workspace, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(workspace, ".pi", "hubble.json"), JSON.stringify({ root: vault }), "utf8");

  const settingsManager = SettingsManager.inMemory();
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
  });
  await resourceLoader.reload();
  const extensionErrors = resourceLoader.getExtensions().errors;
  if (extensionErrors.length > 0) {
    throw new Error(`Could not load the Hubble extension:\n${JSON.stringify(extensionErrors, null, 2)}`);
  }

  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(workspace),
    noTools: "builtin",
  });
  return session;
}

function getTool(session: AgentSession, name: string) {
  const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Pi did not activate the ${name} tool.`);
  return tool;
}

function toolText(result: AgentToolResult<unknown>): string {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected the Hubble tool to return text content.");
  return content.text;
}

test("loads the checkout through Pi and creates a note using --hubble-dir", async () => {
  const vault = await mkdtemp(join(tmpdir(), "pi-hubble-integration-"));
  try {
    const messages = await runPi(vault);

    expect(messages).toContainEqual(
      expect.objectContaining({ id: "create", type: "response", command: "prompt", success: true })
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "extension_ui_request",
        method: "notify",
        message: "Created Hubble note: checks/integration-smoke.md",
        notifyType: "info",
      })
    );
    const editorRequest = messages.find(
      (message) => message.type === "extension_ui_request" && message.method === "set_editor_text"
    );
    expect(String(editorRequest?.text).replaceAll("\\", "/")).toMatch(/^@.*\/checks\/integration-smoke\.md$/u);
    expect(messages.some((message) => message.type === "extension_error")).toBe(false);
    expect(await readFile(join(vault, "checks", "integration-smoke.md"), "utf8")).toBe("# Integration Smoke\n\n");
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("loads and executes every Hubble tool through the Pi SDK runtime", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-hubble-sdk-integration-"));
  const vault = join(workspace, "vault");
  const session = await createIntegrationSession(workspace, vault);

  try {
    await session.bindExtensions({ mode: "print" });
    expect(session.getActiveToolNames()).toEqual([
      "hubble_search",
      "hubble_read",
      "hubble_create",
      "hubble_edit",
      "hubble_append",
    ]);

    const created = await getTool(session, "hubble_create").execute(
      "create",
      { title: "Integration Tool Note", content: "Alpha\nBeta", folder: "checks" },
      undefined,
      undefined
    );
    expect(toolText(created)).toBe("Created Hubble note: checks/integration-tool-note.md");
    expect(created.details).toEqual({ path: "checks/integration-tool-note.md" });

    const appended = await getTool(session, "hubble_append").execute(
      "append",
      { path: "checks/integration-tool-note.md", content: "Gamma" },
      undefined,
      undefined
    );
    expect(toolText(appended)).toBe("Appended to Hubble note: checks/integration-tool-note.md");

    const edited = await getTool(session, "hubble_edit").execute(
      "edit",
      {
        path: "checks/integration-tool-note.md",
        edits: [
          { oldText: "Alpha", newText: "Updated Alpha" },
          { oldText: "Beta", newText: "Updated Beta" },
        ],
      },
      undefined,
      undefined
    );
    expect(edited.details).toEqual({ path: "checks/integration-tool-note.md", editCount: 2 });

    const read = await getTool(session, "hubble_read").execute(
      "read",
      { path: "checks/integration-tool-note.md", offset: 3, limit: 2 },
      undefined,
      undefined
    );
    expect(toolText(read)).toBe("Path: checks/integration-tool-note.md\n\nUpdated Alpha\nUpdated Beta");
    expect(read.details).toMatchObject({
      path: "checks/integration-tool-note.md",
      startLine: 3,
      returnedLines: 2,
      totalLines: 5,
      truncated: false,
    });

    const search = await getTool(session, "hubble_search").execute(
      "search",
      { query: "UPDATED", limit: 10 },
      undefined,
      undefined
    );
    expect(toolText(search)).toBe(
      "checks/integration-tool-note.md:3: Updated Alpha\nchecks/integration-tool-note.md:4: Updated Beta"
    );
    expect(search.details).toMatchObject({ query: "updated", matchCount: 2, truncated: false });

    expect(await readFile(join(vault, "checks", "integration-tool-note.md"), "utf8")).toBe(
      "# Integration Tool Note\n\nUpdated Alpha\nUpdated Beta\nGamma"
    );
  } finally {
    session.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("registers working @hubble note lookups with Pi's autocomplete API", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-hubble-autocomplete-integration-"));
  const vault = join(workspace, "vault");
  await mkdir(join(vault, "notes"), { recursive: true });
  await writeFile(join(vault, "alpha.md"), "# Alpha", "utf8");
  await writeFile(join(vault, "notes", "beta.md"), "# Beta", "utf8");
  await writeFile(join(vault, "ignored.txt"), "not a note", "utf8");
  const session = await createIntegrationSession(workspace, vault);

  try {
    let providerFactory: AutocompleteProviderFactory | undefined;
    const baseUi = session.extensionRunner.getUIContext();
    const uiContext: ExtensionUIContext = {
      ...baseUi,
      addAutocompleteProvider(factory) {
        providerFactory = factory;
      },
    };
    await session.bindExtensions({ mode: "tui", uiContext });
    if (!providerFactory) throw new Error("Hubble did not register an autocomplete provider during session_start.");

    const current: AutocompleteProvider = {
      async getSuggestions() {
        return { prefix: "", items: [{ value: "fallback", label: "fallback" }] };
      },
      applyCompletion(lines, cursorLine, cursorCol) {
        return { lines, cursorLine, cursorCol };
      },
      shouldTriggerFileCompletion() {
        return true;
      },
    };
    const provider = providerFactory(current);
    const signal = new AbortController().signal;

    expect(await provider.getSuggestions(["unrelated"], 0, 9, { signal })).toEqual({
      prefix: "",
      items: [{ value: "fallback", label: "fallback" }],
    });

    const all = await provider.getSuggestions(["@hubble/"], 0, 8, { signal });
    expect(all?.items.map((item) => item.label)).toEqual(["@hubble/alpha.md", "@hubble/notes/beta.md"]);

    const filtered = await provider.getSuggestions(["@hubble/bet"], 0, 11, { signal });
    expect(filtered).toEqual({
      prefix: "@hubble/bet",
      items: [
        {
          value: `@${join(await realpath(vault), "notes", "beta.md")}`,
          label: "@hubble/notes/beta.md",
          description: "Hubble Markdown note",
        },
      ],
    });
  } finally {
    session.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});
