import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../../src/core/extensions/loader.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";

// The effective system prompt must be persisted with the session and restored
// verbatim on resume so the model's prefill cache survives APPEND_SYSTEM.md /
// Pi's internal prompt changes. Only an explicit update (slash command or CLI
// flag) should rebuild it from current files.

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-system-prompt-restore-"));
	tempDirs.push(dir);
	return dir;
}

function createResourceLoader(append: string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [append],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

async function createSession(
	cwd: string,
	sessionManager: SessionManager,
	resourceLoader: ResourceLoader,
	restoreSystemPrompt?: boolean,
): Promise<AgentSession> {
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: {
			model,
			systemPrompt: "",
			tools: [],
		},
		streamFn: streamSimple,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		cwd,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
		restoreSystemPrompt,
	});
	session.subscribe(() => {});
	return session;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("system prompt persistence and restore", () => {
	test("persists the built system prompt and restores it verbatim on resume", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.create(cwd);

		// First run: APPEND_SYSTEM.md content "v1".
		const first = await createSession(cwd, sessionManager, createResourceLoader("append-v1"));
		expect(sessionManager.getSavedSystemPrompt()?.systemPrompt).toContain("append-v1");
		const savedOnFirstRun = sessionManager.getSavedSystemPrompt()?.systemPrompt;
		expect(savedOnFirstRun).toBeTruthy();
		first.dispose();

		// Resume with APPEND_SYSTEM.md changed to "v2". The saved prompt must win.
		const resumed = await createSession(cwd, sessionManager, createResourceLoader("append-v2"));
		expect(resumed.systemPrompt).toBe(savedOnFirstRun);
		expect(resumed.systemPrompt).toContain("append-v1");
		expect(resumed.systemPrompt).not.toContain("append-v2");
		resumed.dispose();
	});

	test("does not persist an identical prompt again on resume", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.create(cwd);

		const first = await createSession(cwd, sessionManager, createResourceLoader("append-v1"));
		const entriesAfterFirst = sessionManager.getEntries().filter((e) => e.type === "system_prompt").length;
		first.dispose();

		const resumed = await createSession(cwd, sessionManager, createResourceLoader("append-v1"));
		const entriesAfterResume = sessionManager.getEntries().filter((e) => e.type === "system_prompt").length;
		resumed.dispose();

		expect(entriesAfterFirst).toBe(1);
		expect(entriesAfterResume).toBe(1);
	});

	test("restoreSystemPrompt=false rebuilds from current files and persists", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.create(cwd);

		const first = await createSession(cwd, sessionManager, createResourceLoader("append-v1"));
		first.dispose();

		// Force an update: the current APPEND_SYSTEM.md is loaded and saved.
		const forced = await createSession(cwd, sessionManager, createResourceLoader("append-v2"), false);
		expect(forced.systemPrompt).toContain("append-v2");
		expect(sessionManager.getSavedSystemPrompt()?.systemPrompt).toContain("append-v2");
		forced.dispose();
	});

	test("reloadSystemPromptFromFiles rebuilds from current files during a live session", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.create(cwd);

		const session = await createSession(cwd, sessionManager, createResourceLoader("append-v1"));
		expect(session.systemPrompt).toContain("append-v1");

		// Swap the loader to a different append and force an update.
		const updatedLoader = createResourceLoader("append-v2");
		Object.assign(session, { _resourceLoader: updatedLoader });
		session.reloadSystemPromptFromFiles();

		expect(session.systemPrompt).toContain("append-v2");
		expect(sessionManager.getSavedSystemPrompt()?.systemPrompt).toContain("append-v2");
		session.dispose();
	});

	test("setCustomSystemPrompt persists a custom prompt and clear reverts to files", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.create(cwd);
		const session = await createSession(cwd, sessionManager, createResourceLoader("append-v1"));

		session.setCustomSystemPrompt("CUSTOM BASE PROMPT");
		expect(session.hasCustomSystemPrompt).toBe(true);
		expect(session.systemPrompt).toContain("CUSTOM BASE PROMPT");
		expect(sessionManager.getSavedSystemPrompt()?.customPrompt).toBe("CUSTOM BASE PROMPT");

		// Clear reverts to the file-based prompt.
		session.reloadSystemPromptFromFiles();
		expect(session.hasCustomSystemPrompt).toBe(false);
		expect(session.systemPrompt).toContain("append-v1");
		expect(sessionManager.getSavedSystemPrompt()?.customPrompt).toBeUndefined();
		session.dispose();
	});
});
