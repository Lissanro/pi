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
import { type RetryPolicy, retryDelayMs } from "./utils/retry.ts";

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
 * Thrown by {@link countTokens} when the tokenize request failed for a transient
 * reason: connection refused, network error, timeout, or a non-404 HTTP error.
 * A clear 404 means the endpoint is not supported and is not a transient failure
 * (countTokens returns undefined instead, so the caller falls back to an estimate).
 */
export class TokenizeTransientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TokenizeTransientError";
	}
}

/**
 * Count the tokens `text` occupies according to the model server's own tokenizer.
 *
 * Returns the exact token count when the server exposes `/tokenize`, or undefined
 * when the endpoint is not supported (clear 404, missing token array, no text,
 * or aborted). Transient failures (connection refused, network error, timeout,
 * non-404 HTTP errors) throw {@link TokenizeTransientError} so callers that expect
 * the endpoint to exist can retry instead of silently using a fallback estimate.
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

		if (!res.ok) {
			// A clear 404 means the endpoint is not there; not a transient failure.
			if (res.status === 404) return undefined;
			throw new TokenizeTransientError(`tokenize endpoint returned ${res.status}`);
		}
		const data = (await res.json()) as { tokens?: unknown };
		if (Array.isArray(data?.tokens)) return data.tokens.length;
		// 200 without a token array: the endpoint is present but not usable for counting.
		return undefined;
	} catch (error) {
		if (options.signal?.aborted) return undefined;
		if (error instanceof TokenizeTransientError) throw error;
		throw new TokenizeTransientError(error instanceof Error ? error.message : String(error));
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Aborted"));
			},
			{ once: true },
		);
	});
}

/**
 * Count tokens via `/tokenize`, retrying transient failures with the same
 * exponential-backoff policy used by assistant calls.
 *
 * A clear 404 (endpoint not supported) is terminal: the function returns undefined
 * so the caller falls back to an estimate without retrying. Transient failures
 * (connection refused, timeout, network error, non-404 HTTP errors) retry up to
 * `policy.maxRetries` times. When `policy.maxRetries` is Infinity (the default),
 * it keeps retrying indefinitely until the endpoint succeeds, returns a 404, or
 * the signal aborts - matching the unbounded retry behavior of assistant calls.
 *
 * Returns undefined after exhausting retries (or on abort), so the caller falls
 * back to an estimate rather than failing the whole operation.
 */
export async function countTokensWithRetry(
	model: Model<any>,
	options: CountTokensOptions,
	policy: RetryPolicy | undefined,
): Promise<number | undefined> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;
	let attempt = 0;
	for (;;) {
		try {
			return await countTokens(model, options);
		} catch (error) {
			if (!(error instanceof TokenizeTransientError)) throw error;
			if (attempt >= maxAttempts) return undefined;
			attempt++;
			try {
				await sleep(retryDelayMs(policy!, attempt), options.signal);
			} catch (sleepError) {
				// Abort during the backoff sleep is terminal: stop retrying.
				if (options.signal?.aborted) return undefined;
				throw sleepError;
			}
		}
	}
}
