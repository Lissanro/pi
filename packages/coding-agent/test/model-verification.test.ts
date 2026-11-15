import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	Provider,
} from "@earendil-works/pi-ai";
import { isRetryableErrorMessage, lazyStream, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

const PROVIDER_ID = "test-provider";
const BASE_URL = "http://llama.local:5000/v1";
const CATALOG_URL = "http://llama.local:5000/models";

function fakeModel(): Model<Api> {
	return {
		id: "test-model",
		name: "Test model",
		api: "openai-completions" as Api,
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
		reasoning: false,
	};
}

function fakeAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function okStream(model: Model<Api>): AssistantMessageEventStream {
	return lazyStream(model, async () =>
		(async function* (): AsyncGenerator<AssistantMessageEvent> {
			yield { type: "done", reason: "stop", message: fakeAssistantMessage(model) };
		})(),
	);
}

function fakeBase(): Provider {
	const provider: Provider = {
		id: PROVIDER_ID,
		name: "Test provider",
		baseUrl: BASE_URL,
		auth: {
			apiKey: {
				name: "Test key",
				resolve: async () => ({ auth: { apiKey: "test-key" } }),
			},
		},
		getModels: () => [fakeModel()],
		stream: (model) => okStream(model),
		streamSimple: (model) => okStream(model),
	};
	return provider;
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function errorMessages(events: AssistantMessageEvent[]): string[] {
	return events
		.filter((event): event is Extract<AssistantMessageEvent, { type: "error" }> => event.type === "error")
		.map((event) => event.error.errorMessage ?? "");
}

describe("models.json verifyModel (resident model verification)", () => {
	let tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		tempDirs = [];
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function stubCatalog(catalog: unknown): { fetchMock: ReturnType<typeof vi.fn> } {
		const fetchMock = vi.fn(
			async () => ({ ok: true, status: 200, json: async () => catalog }) as unknown as Response,
		);
		vi.stubGlobal("fetch", fetchMock);
		return { fetchMock };
	}

	async function setup(options: {
		verifyModel?: string;
		modelOverrides?: Record<string, unknown>;
	}): Promise<{ provider: Provider; model: Model<Api> }> {
		const dir = mkdtempSync(join(tmpdir(), "pi-test-model-verification-"));
		tempDirs.push(dir);
		const modelsJson = {
			providers: {
				[PROVIDER_ID]: {
					apiKey: "test-key",
					baseUrl: BASE_URL,
					api: "openai-completions",
					models: [
						{
							id: "test-model",
							name: "Test model",
							...(options.verifyModel !== undefined ? { verifyModel: options.verifyModel } : {}),
						},
					],
					...(options.modelOverrides ? { modelOverrides: options.modelOverrides } : {}),
				},
			},
		};
		const path = join(dir, "models.json");
		writeFileSync(path, JSON.stringify(modelsJson));
		const modelConfig = await ModelConfig.load(path);
		const provider = fakeBase();
		const composed = composeModelProvider(PROVIDER_ID, provider, modelConfig, undefined);
		const model = composed.getModels().find((entry) => entry.id === "test-model");
		if (!model) throw new Error("composed provider lost the test model");
		return { provider: composed, model };
	}

	test("single-model catalog serving the expected core passes and forwards to the base stream", async () => {
		const { fetchMock } = stubCatalog({ data: [{ id: "/mnt/models/Kimi-K3-UD-Q2_K_XL-00001-of-00019.gguf" }] });
		const { provider, model } = await setup({ verifyModel: "kimi-k3" });
		const events = await collect(provider.stream(model, normalizeContext({ messages: [] }), undefined));
		expect(errorMessages(events)).toHaveLength(0);
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledWith(
			CATALOG_URL,
			expect.objectContaining({ headers: { Accept: "application/json" } }),
		);
	});

	test("single-model catalog serving a different core fails with a retryable verification error", async () => {
		stubCatalog({ data: [{ id: "/mnt/models/GLM-5.2-744b-ud_q4_k_m.gguf" }] });
		const { provider, model } = await setup({ verifyModel: "kimi-k3" });
		const events = await collect(provider.stream(model, normalizeContext({ messages: [] }), undefined));
		const messages = errorMessages(events);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("model verification failed");
		expect(messages[0]).toContain("GLM-5.2-744b-ud_q4_k_m.gguf");
		expect(isRetryableErrorMessage(messages[0]!)).toBe(true);
	});

	test("router catalog with the wrong core loaded fails", async () => {
		stubCatalog({
			data: [
				{ id: "glm-5.2", status: { value: "loaded" } },
				{ id: "kimi-k3", status: { value: "unloaded" } },
			],
		});
		const { provider, model } = await setup({ verifyModel: "kimi-k3" });
		const events = await collect(provider.stream(model, normalizeContext({ messages: [] }), undefined));
		const messages = errorMessages(events);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("glm-5.2");
	});

	test("router catalog with the expected core loaded passes", async () => {
		stubCatalog({ data: [{ id: "ai-kimi-k3-2.8t", status: { value: "loaded" } }] });
		const { provider, model } = await setup({ verifyModel: "kimi-k3" });
		const events = await collect(provider.stream(model, normalizeContext({ messages: [] }), undefined));
		expect(errorMessages(events)).toHaveLength(0);
	});

	test("router catalog with the expected core only sleeping passes (nothing wrong is resident)", async () => {
		stubCatalog({ data: [{ id: "kimi-k3", status: { value: "sleeping" } }] });
		const { provider, model } = await setup({ verifyModel: "kimi-k3" });
		const events = await collect(provider.stream(model, normalizeContext({ messages: [] }), undefined));
		expect(errorMessages(events)).toHaveLength(0);
	});

	test("aliases participate in matching", async () => {
		stubCatalog({ data: [{ id: "some-other-name", aliases: ["kimi-k3-alias"], status: { value: "loaded" } }] });
		const { provider, model } = await setup({ verifyModel: "kimi-k3" });
		const events = await collect(provider.stream(model, normalizeContext({ messages: [] }), undefined));
		expect(errorMessages(events)).toHaveLength(0);
	});

	test("no verifyModel configured: no catalog request is made", async () => {
		const { fetchMock } = stubCatalog({ data: [] });
		const { provider, model } = await setup({});
		const events = await collect(provider.stream(model, normalizeContext({ messages: [] }), undefined));
		expect(errorMessages(events)).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("modelOverrides set verifyModel on a model without a definition-level requirement", async () => {
		stubCatalog({ data: [{ id: "/mnt/models/GLM-5.2-744b.gguf" }] });
		const { provider, model } = await setup({ modelOverrides: { "test-model": { verifyModel: "kimi-k3" } } });
		const events = await collect(provider.stream(model, normalizeContext({ messages: [] }), undefined));
		expect(errorMessages(events)[0]).toContain('expected model "kimi-k3"');
	});

	test("modelOverrides win over the definition-level requirement", async () => {
		stubCatalog({ data: [{ id: "/mnt/models/GLM-5.2-744b.gguf" }] });
		const { provider, model } = await setup({
			verifyModel: "kimi-k3",
			modelOverrides: { "test-model": { verifyModel: "glm" } },
		});
		const events = await collect(provider.stream(model, normalizeContext({ messages: [] }), undefined));
		expect(errorMessages(events)).toHaveLength(0);
	});

	test("catalog query transport failure surfaces as a retryable verification error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("fetch failed");
			}),
		);
		const { provider, model } = await setup({ verifyModel: "kimi-k3" });
		const events = await collect(provider.stream(model, normalizeContext({ messages: [] }), undefined));
		const messages = errorMessages(events);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("could not query the model catalog");
		expect(isRetryableErrorMessage(messages[0]!)).toBe(true);
	});

	test("catalog HTTP failure surfaces as a retryable verification error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response),
		);
		const { provider, model } = await setup({ verifyModel: "kimi-k3" });
		const events = await collect(provider.stream(model, normalizeContext({ messages: [] }), undefined));
		const messages = errorMessages(events);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("HTTP 404");
		expect(isRetryableErrorMessage(messages[0]!)).toBe(true);
	});
});
