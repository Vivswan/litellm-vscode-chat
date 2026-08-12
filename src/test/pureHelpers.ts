/**
 * Test helpers with no dependency on the vscode module or the extension host,
 * so they load under both runners: the bun tree (src/test/bun) and the Mocha
 * extension-host suites. Helpers that need vscode, msw, or the provider
 * runtime stay in testUtils.ts.
 */
import * as assert from "node:assert";
import type { PreAttachModelInfo } from "../provider/catalog/groupModels";
import { Logger } from "../shared/logger";

/** A Logger over a recording sink: `lines` collects info lines and `ERROR: `-prefixed error lines. */
export function makeLogger(): { logger: Logger; lines: string[] } {
	const lines: string[] = [];
	const logger = new Logger({
		info: (message: string) => lines.push(message),
		error: (message: string) => lines.push(`ERROR: ${message}`),
	});
	return { logger, lines };
}

/**
 * assert.ok(haystack.includes(needle)) with the literal out of the guard
 * position: CodeQL's js/incomplete-url-substring-sanitization flags URL-ish
 * string literals passed to includes() as if they were URL validation, which
 * test assertions on rendered output trip constantly. Tests stay scanned
 * (policy: never exclude test paths); the assertion shape just is not the
 * vulnerable pattern. Use these for any needle that resembles a host or URL.
 */
export function assertContains(haystack: string, needle: string, message?: string): void {
	assert.ok(haystack.includes(needle), message ?? `expected text to contain ${JSON.stringify(needle)}: ${haystack}`);
}

/** The negative counterpart of assertContains, for leak/redaction pins. */
export function assertOmits(haystack: string, needle: string, message?: string): void {
	assert.ok(!haystack.includes(needle), message ?? `expected text to omit ${JSON.stringify(needle)}: ${haystack}`);
}

/** assertContains with a context-style message: failure output appends the haystack. */
export function assertShows(text: string, needle: string, context: string): void {
	assert.ok(text.includes(needle), `${context}, got ${text}`);
}

/** Prefix assert with the literal out of the guard position; same CodeQL rationale as assertContains. */
export function assertStartsWith(haystack: string, prefix: string, message?: string): void {
	assert.ok(
		haystack.startsWith(prefix),
		message ?? `expected text to start with ${JSON.stringify(prefix)}: ${haystack}`
	);
}

/** Suffix assert with the literal out of the guard position; same CodeQL rationale as assertContains. */
export function assertEndsWith(haystack: string, suffix: string, message?: string): void {
	assert.ok(haystack.endsWith(suffix), message ?? `expected text to end with ${JSON.stringify(suffix)}: ${haystack}`);
}

/** Assert that an indexed read produced a value and return it narrowed. */
export function expectDefined<T>(value: T | undefined, message = "expected value to be defined"): T {
	assert.ok(value !== undefined, message);
	return value;
}

export function toHeaderMap(headersInit: RequestInit["headers"] | undefined): Record<string, string> {
	if (!headersInit) {
		return {};
	}
	const mapped: Record<string, string> = {};
	new Headers(headersInit).forEach((value, key) => {
		mapped[key] = value;
	});
	return mapped;
}

export type FetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Run `fn` with `global.fetch` replaced by `mock`, restoring the original
 * fetch even when the body throws so one failing test cannot cascade.
 *
 * Most suites mock the network through msw (see mocks/handlers.ts); this
 * remains the escape hatch for what msw cannot express: observing the
 * AbortSignal wired into fetch, erroring a body stream on abort, and
 * fabricating specific error cause chains (ECONNREFUSED, TLS failures,
 * TimeoutError DOMExceptions).
 */
export async function withFetch<T>(mock: FetchMock, fn: () => Promise<T>): Promise<T> {
	const originalFetch = global.fetch;
	global.fetch = mock as unknown as typeof fetch;
	try {
		return await fn();
	} finally {
		global.fetch = originalFetch;
	}
}

export function makeModelInfo(overrides: Partial<PreAttachModelInfo> = {}): PreAttachModelInfo {
	return {
		id: "test-model",
		name: "test-model",
		family: "litellm",
		version: "1.0.0",
		maxInputTokens: 100000,
		maxOutputTokens: 8000,
		capabilities: {},
		litellm: {
			supportsPromptCaching: false,
			outputLimitSource: "defaults",
			serverDeclared: { kind: "discovered", values: {}, outputDeclared: false },
		},
		...overrides,
	};
}

/**
 * A /v1/model/info discovery payload registering "test-model" with the same
 * token limits as `makeModelInfo()`. Prompt caching is not advertised.
 */
export const DEFAULT_DISCOVERY_PAYLOAD = {
	data: [
		{
			model_name: "test-model",
			model_info: {
				id: "test-model",
				supports_function_calling: true,
				max_input_tokens: 100000,
				max_output_tokens: 8000,
			},
		},
	],
};
