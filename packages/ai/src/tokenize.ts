/**
 * Token counting via a server's `/tokenize` endpoint.
 *
 * llama.cpp's llama-server (and some other OpenAI-compatible servers) expose a
 * `POST /tokenize` endpoint that returns the model's own token ids for a piece
 * of text. Using it gives the exact token count for the loaded model instead of a
 * chars/4 estimate. Providers without the endpoint (OpenAI, Anthropic, most
 * hosted APIs) cause a fetch failure, and countTokens() returns undefined so the
 * caller can fall back to an estimate.
 */

import type { Model } from "./types.ts";
import { getPiUserAgent } from "./utils/pi-user-agent.ts";

export interface CountTokensOptions {
	text: string;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	/** Custom fetch (for tests). Defaults to global fetch. */
	fetch?: typeof globalThis.fetch;
	/** AbortSignal (for tests). */
	signal?: AbortSignal;
	/** Request timeout in milliseconds. Default 30000. */
	timeoutMs?: number;
}

/**
 * Derive the `/tokenize` URL from a model base URL.
 *
 * llama.cpp serves `/tokenize` at the server root while the OpenAI-compatible
 * base URL often ends in `/v1`. Strip a trailing `/vN` before appending. Returns
 * undefined for empty base URLs.
 */
export function tokenizeEndpointUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (!trimmed) return undefined;
	const root = /\/v\d+$/.test(trimmed) ? trimmed.replace(/\/v\d+$/, "") : trimmed;
	return `${root}/tokenize`;
}

/**
 * Count the tokens `text` occupies according to the model server's own tokenizer.
 *
 * Returns the exact token count when the server exposes `/tokenize`, or undefined
 * when it is unavailable (endpoint missing, non-2xx, network error, or timeout).
 * Callers must treat undefined as "use a fallback estimate".
 */
export async function countTokens(model: Model<any>, options: CountTokensOptions): Promise<number | undefined> {
	const url = tokenizeEndpointUrl(model.baseUrl);
	if (!url || !options.text) return undefined;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"User-Agent": getPiUserAgent(),
		...model.headers,
	};
	// Only add an Authorization header from the API key when the caller did not
	// already supply one (e.g. a pre-resolved Bearer token in options.headers).
	const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
	if (options.apiKey && !hasAuthHeader) {
		headers.Authorization = `Bearer ${options.apiKey}`;
	}
	if (options.headers) {
		Object.assign(headers, options.headers);
	}

	const fetchFn = options.fetch ?? globalThis.fetch;
	const timeout = options.timeoutMs ?? 30000;

	try {
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		if (options.signal) {
			if (options.signal.aborted) return undefined;
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
		const timer = setTimeout(() => controller.abort(), timeout);
		const res = await fetchFn(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ content: options.text }),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (options.signal) options.signal.removeEventListener("abort", onAbort);

		if (!res.ok) return undefined;
		const data = (await res.json()) as { tokens?: unknown };
		if (Array.isArray(data?.tokens)) return data.tokens.length;
		return undefined;
	} catch {
		return undefined;
	}
}
