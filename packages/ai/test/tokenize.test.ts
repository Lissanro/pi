import { describe, expect, it } from "vitest";
import { type CountTokensOptions, countTokens, tokenizeEndpointUrl } from "../src/tokenize.ts";
import type { Model } from "../src/types.ts";

function model(baseUrl: string): Model<any> {
	return {
		id: "test-model",
		name: "Test",
		api: "openai-completions",
		provider: "openai",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	} as Model<any>;
}

describe("tokenizeEndpointUrl", () => {
	it("appends /tokenize to a root base URL", () => {
		expect(tokenizeEndpointUrl("http://host:8080")).toBe("http://host:8080/tokenize");
	});
	it("strips a trailing /v1 before appending /tokenize", () => {
		expect(tokenizeEndpointUrl("http://host:8080/v1")).toBe("http://host:8080/tokenize");
	});
	it("strips a versioned /v12 suffix", () => {
		expect(tokenizeEndpointUrl("https://api.example.com/v12/")).toBe("https://api.example.com/tokenize");
	});
	it("returns undefined for an empty base URL", () => {
		expect(tokenizeEndpointUrl("")).toBeUndefined();
	});
});

function mockFetch(handler: (url: string, init: RequestInit) => Promise<globalThis.Response>) {
	return (async (input: unknown, init?: RequestInit) =>
		handler(String(input), init as RequestInit)) as typeof globalThis.fetch;
}

describe("countTokens", () => {
	it("returns the token count from a /tokenize response", async () => {
		const fetchFn = mockFetch(async (url, init) => {
			expect(url).toBe("http://host:8080/tokenize");
			expect(JSON.parse(String(init.body))).toEqual({ content: "hello world" });
			return new Response(JSON.stringify({ tokens: [1, 2, 3, 4] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		const count = await countTokens(model("http://host:8080/v1"), { text: "hello world", fetch: fetchFn });
		expect(count).toBe(4);
	});

	it("sends a Bearer header from the API key when none is set", async () => {
		let seenAuth: string | undefined;
		const fetchFn = mockFetch(async (_url, init) => {
			seenAuth = (init.headers as Record<string, string>)?.["Authorization"] as string | undefined;
			return new Response(JSON.stringify({ tokens: [1] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		await countTokens(model("http://host:8080"), { text: "x", apiKey: "sk-test", fetch: fetchFn });
		expect(seenAuth).toBe("Bearer sk-test");
	});

	it("prefers a pre-resolved Authorization header over the API key", async () => {
		let seenAuth: string | undefined;
		const fetchFn = mockFetch(async (_url, init) => {
			seenAuth = (init.headers as Record<string, string>)?.["Authorization"] as string | undefined;
			return new Response(JSON.stringify({ tokens: [1] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		await countTokens(model("http://host:8080"), {
			text: "x",
			apiKey: "sk-test",
			headers: { Authorization: "Bearer pre-resolved" },
			fetch: fetchFn,
		});
		expect(seenAuth).toBe("Bearer pre-resolved");
	});

	it("returns undefined on a non-2xx response", async () => {
		const fetchFn = mockFetch(async () => new Response("no endpoint", { status: 404 }));
		const count = await countTokens(model("http://host:8080"), { text: "x", fetch: fetchFn });
		expect(count).toBeUndefined();
	});

	it("returns undefined when the response has no token array", async () => {
		const fetchFn = mockFetch(
			async () =>
				new Response(JSON.stringify({ error: "unsupported" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const count = await countTokens(model("http://host:8080"), { text: "x", fetch: fetchFn });
		expect(count).toBeUndefined();
	});

	it("returns undefined on a network error", async () => {
		const fetchFn = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof globalThis.fetch;
		const count = await countTokens(model("http://host:8080"), { text: "x", fetch: fetchFn });
		expect(count).toBeUndefined();
	});

	it("returns undefined when the request is aborted", async () => {
		const controller = new AbortController();
		const fetchFn = (async () => {
			controller.abort();
			throw new Error("aborted");
		}) as unknown as typeof globalThis.fetch;
		const options: CountTokensOptions = { text: "x", fetch: fetchFn, signal: controller.signal };
		expect(await countTokens(model("http://host:8080"), options)).toBeUndefined();
		// Already-aborted signal short-circuits without fetching.
		const aborted = new AbortController();
		aborted.abort();
		const neverFetched = (async () => {
			throw new Error("should not be called");
		}) as unknown as typeof globalThis.fetch;
		expect(
			await countTokens(model("http://host:8080"), { text: "x", fetch: neverFetched, signal: aborted.signal }),
		).toBeUndefined();
	});
});
