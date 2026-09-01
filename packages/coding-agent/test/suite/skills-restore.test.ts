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
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";

// The effective skill set must be persisted with the session and restored on
// resume so the runtime skill list stays consistent with the restored system
// prompt, keeping the model's prefill cache stable across skill file edits.
// Only an explicit update (/update skills, /update all) should reload skills
// from disk.

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-skills-restore-"));
	tempDirs.push(dir);
	return dir;
}

function makeSkill(name: string, description = `desc-${name}`): Skill {
	return {
		name,
		description,
		filePath: `/fake/${name}/SKILL.md`,
		baseDir: `/fake/${name}`,
		sourceInfo: createSyntheticSourceInfo(`/fake/${name}/SKILL.md`, { source: "user" }),
		disableModelInvocation: false,
	};
}

/** Skills the mock loader reports; mutating it simulates a change on disk. */
interface SkillHolder {
	skills: Skill[];
}

function createResourceLoader(append: string, holder?: SkillHolder): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: holder ? holder.skills : [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [append],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
		reloadSystemPrompt: () => {},
		reloadSkills: () => {},
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

function effectiveSkills(session: AgentSession): Skill[] {
	return (session as unknown as { _effectiveSkills: Skill[] })._effectiveSkills;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("skill persistence and restore", () => {
	test("persists the effective skills with the system prompt and restores them on resume", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.create(cwd);

		// First run: disk has skill "alpha".
		const first = await createSession(
			cwd,
			sessionManager,
			createResourceLoader("append-v1", { skills: [makeSkill("alpha")] }),
		);
		expect(first.systemPrompt).toContain("alpha");
		expect(sessionManager.getSavedSystemPrompt()?.skills?.map((s) => s.name)).toEqual(["alpha"]);
		expect(effectiveSkills(first).map((s) => s.name)).toEqual(["alpha"]);
		first.dispose();

		// Resume with disk now reporting skill "beta". The saved skill set must win.
		const resumed = await createSession(
			cwd,
			sessionManager,
			createResourceLoader("append-v1", { skills: [makeSkill("beta")] }),
		);
		expect(resumed.systemPrompt).toContain("alpha");
		expect(resumed.systemPrompt).not.toContain("beta");
		expect(effectiveSkills(resumed).map((s) => s.name)).toEqual(["alpha"]);
		expect(sessionManager.getSavedSystemPrompt()?.skills?.map((s) => s.name)).toEqual(["alpha"]);
		resumed.dispose();
	});

	test("does not persist an identical skill snapshot again on resume", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.create(cwd);

		const first = await createSession(
			cwd,
			sessionManager,
			createResourceLoader("append-v1", { skills: [makeSkill("alpha")] }),
		);
		const entriesAfterFirst = sessionManager.getEntries().filter((e) => e.type === "system_prompt").length;
		first.dispose();

		const resumed = await createSession(
			cwd,
			sessionManager,
			createResourceLoader("append-v1", { skills: [makeSkill("alpha")] }),
		);
		const entriesAfterResume = sessionManager.getEntries().filter((e) => e.type === "system_prompt").length;
		resumed.dispose();

		expect(entriesAfterFirst).toBe(1);
		expect(entriesAfterResume).toBe(1);
	});

	test("restoreSystemPrompt=false rebuilds skills from the current loader", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.create(cwd);

		const first = await createSession(
			cwd,
			sessionManager,
			createResourceLoader("append-v1", { skills: [makeSkill("alpha")] }),
		);
		first.dispose();

		// Forced rebuild: the current disk skill set is loaded and saved.
		const forced = await createSession(
			cwd,
			sessionManager,
			createResourceLoader("append-v1", { skills: [makeSkill("beta")] }),
			false,
		);
		expect(forced.systemPrompt).toContain("beta");
		expect(effectiveSkills(forced).map((s) => s.name)).toEqual(["beta"]);
		expect(sessionManager.getSavedSystemPrompt()?.skills?.map((s) => s.name)).toEqual(["beta"]);
		forced.dispose();
	});

	test("reloadSkillsFromFiles picks up skill changes during a live session", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.create(cwd);
		const holder: SkillHolder = { skills: [makeSkill("alpha")] };

		const session = await createSession(cwd, sessionManager, createResourceLoader("append-v1", holder));
		expect(session.systemPrompt).toContain("alpha");

		// Simulate a skill edit on disk, then update skills only.
		holder.skills = [makeSkill("beta")];
		session.reloadSkillsFromFiles();

		expect(session.systemPrompt).toContain("beta");
		expect(session.systemPrompt).not.toContain("alpha");
		expect(effectiveSkills(session).map((s) => s.name)).toEqual(["beta"]);
		expect(sessionManager.getSavedSystemPrompt()?.skills?.map((s) => s.name)).toEqual(["beta"]);
		session.dispose();
	});

	test("reloadAllFromFiles reloads both system prompt and skills", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.create(cwd);

		// First run with append v1 and skill alpha.
		const first = await createSession(
			cwd,
			sessionManager,
			createResourceLoader("append-v1", { skills: [makeSkill("alpha")] }),
		);
		first.dispose();

		// Live session resumed with append v2 and skill beta on disk.
		const holder: SkillHolder = { skills: [makeSkill("alpha")] };
		const session = await createSession(cwd, sessionManager, createResourceLoader("append-v1", holder));

		// Change append content and skill set, then update everything.
		const updatedLoader = createResourceLoader("append-v2", holder);
		Object.assign(session, { _resourceLoader: updatedLoader });
		holder.skills = [makeSkill("beta")];
		session.reloadAllFromFiles();

		expect(session.systemPrompt).toContain("append-v2");
		expect(session.systemPrompt).toContain("beta");
		expect(effectiveSkills(session).map((s) => s.name)).toEqual(["beta"]);
		expect(sessionManager.getSavedSystemPrompt()?.systemPrompt).toContain("append-v2");
		expect(sessionManager.getSavedSystemPrompt()?.skills?.map((s) => s.name)).toEqual(["beta"]);
		session.dispose();
	});
});
