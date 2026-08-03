import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunks: undefined as
		| Array<null | {
				id?: string;
				choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null; usage?: unknown }>;
				usage?: {
					prompt_tokens: number;
					completion_tokens: number;
					prompt_tokens_details: { cached_tokens: number; cache_write_tokens?: number };
					completion_tokens_details: { reasoning_tokens: number };
				};
		  }>
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							const chunks = mockState.chunks ?? [
								{
									choices: [{ delta: {}, finish_reason: "stop" }],
									usage: {
										prompt_tokens: 1,
										completion_tokens: 1,
										prompt_tokens_details: { cached_tokens: 0 },
										completion_tokens_details: { reasoning_tokens: 0 },
									},
								},
							];
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai-completions __raw tool-call capture", () => {
	beforeEach(() => {
		mockState.chunks = undefined;
	});

	it("concatenates __raw deltas onto ToolCall.raw", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-raw",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: "" },
									__raw: "<raw-start>",
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-raw",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { arguments: '{"path":"README.md"}' },
									__raw: "<raw-mid>",
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-raw",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									__raw: "<raw-end>",
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const tool: import("../src/types.ts").Tool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
		};

		const s = streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Read README.md", timestamp: Date.now() }],
				tools: [tool],
			},
			{ apiKey: "test" },
		);

		// Drain the stream.
		for await (const _event of s) {
			void _event;
		}

		const response = await s.result();
		expect(response.stopReason).toBe("toolUse");
		expect(response.content).toHaveLength(1);
		const toolCall = response.content[0];
		expect(toolCall.type).toBe("toolCall");
		if (toolCall.type !== "toolCall") {
			throw new Error("Expected toolCall content");
		}
		expect(toolCall.name).toBe("read");
		expect(toolCall.arguments).toEqual({ path: "README.md" });
		// __raw deltas are concatenated in order onto ToolCall.raw.
		expect(toolCall.raw).toBe("<raw-start><raw-mid><raw-end>");
		// Streaming scratch buffers are stripped from the finalized block.
		expect(toolCall).not.toHaveProperty("partialArgs");
		expect(toolCall).not.toHaveProperty("streamIndex");
	});

	it("preserves raw on the tool call when the stream errors mid-call", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-raw-err",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: '{"path":"/tmp' },
									__raw: "<partial-raw>",
								},
							],
						},
						finish_reason: null,
					},
				],
			},
		];

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const tool: import("../src/types.ts").Tool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
		};

		const s = streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Read /tmp/x", timestamp: Date.now() }],
				tools: [tool],
			},
			{ apiKey: "test" },
		);

		for await (const _event of s) {
			void _event;
		}

		const response = (await s.result()) as AssistantMessage;
		// The stream ended without finish_reason -> error.
		expect(response.stopReason).toBe("error");
		const toolCall = response.content[0];
		expect(toolCall.type).toBe("toolCall");
		if (toolCall.type !== "toolCall") {
			throw new Error("Expected toolCall content");
		}
		// raw is retained on error so an interrupted assistant message can be
		// resumed via tool_calls_raw prefill.
		expect(toolCall.raw).toBe("<partial-raw>");
	});
});
