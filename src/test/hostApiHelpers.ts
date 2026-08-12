/**
 * Helpers for suites that drive the extension through the real VS Code LM API
 * (vscode.lm.selectChatModels / model.sendRequest): the host-fidelity suite
 * and the docker-stack suites.
 */

import * as assert from "node:assert";
import * as vscode from "vscode";
import { OPENROUTER_MODELS_URL } from "../shared/config/openRouterCatalog";
import { type BooleanSettingId, CONFIG_SECTION } from "../shared/config/settingSpec";

export const OPENROUTER_CATALOG_SETTING_ID = "models.openRouterCatalog" satisfies BooleanSettingId;

/**
 * Wait for the host to reflect the current model topology. The host ingests
 * refreshed model lists asynchronously and offers no completion signal, so
 * polling vscode.lm.selectChatModels is the only way to observe propagation.
 */
export async function waitForHostModels(
	timeoutMs: number,
	acceptModels: (models: vscode.LanguageModelChat[]) => boolean,
	expectedDescription: string
): Promise<vscode.LanguageModelChat[]> {
	const deadline = Date.now() + timeoutMs;
	let lastIds: string[] = [];

	while (Date.now() < deadline) {
		const models = await vscode.lm.selectChatModels({ vendor: "litellm" });
		lastIds = models.map((model) => model.id);
		if (acceptModels(models)) {
			return models;
		}
		await new Promise((r) => setTimeout(r, 200));
	}

	throw new Error(
		`Timeout (${timeoutMs}ms) waiting for ${expectedDescription}. Last model IDs: ${
			lastIds.length > 0 ? lastIds.join(", ") : "(none)"
		}`
	);
}

/** The LanguageModelThinkingPart class, when the host exposes it (proposed API, possibly behind a throwing getter). */
export function getThinkingPartClass(): (new (...args: never[]) => object) | undefined {
	try {
		const ctor: unknown = Reflect.get(vscode, "LanguageModelThinkingPart");
		return typeof ctor === "function" ? (ctor as new (...args: never[]) => object) : undefined;
	} catch {
		return undefined;
	}
}

/** Extract thinking parts from collected stream parts (empty when the host lacks the class). */
export function extractThinkingParts(parts: unknown[]): Array<{ value?: string }> {
	const thinkingPartClass = getThinkingPartClass();
	if (!thinkingPartClass) {
		return [];
	}
	return parts.filter((p) => p instanceof thinkingPartClass) as Array<{ value?: string }>;
}

/** Collect all parts from a streaming response. */
export async function collectStream(response: vscode.LanguageModelChatResponse): Promise<unknown[]> {
	const parts: unknown[] = [];
	for await (const part of response.stream) {
		parts.push(part);
	}
	return parts;
}

/** Extract concatenated text from collected stream parts. */
export function extractText(parts: unknown[]): string {
	return parts
		.filter((p) => p instanceof vscode.LanguageModelTextPart)
		.map((p) => (p as vscode.LanguageModelTextPart).value)
		.join("");
}

/** Extract tool call parts from collected stream parts. */
export function extractToolCalls(parts: unknown[]): vscode.LanguageModelToolCallPart[] {
	return parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart[];
}

/** Ensure the extension is activated. */
export async function ensureActivated(): Promise<void> {
	const ext = vscode.extensions.getExtension("vivswan.litellm-vscode-chat");
	assert.ok(ext, "Extension not found; check publisher.name in package.json");
	if (!ext.isActive) {
		await ext.activate();
	}
}

/**
 * Pin this host to catalog-OFF for hermeticity. The docker and host-fidelity
 * suites assert what the SERVER declares (pricing absence, no vision), but the
 * fake stack's realistic model names (llama-4-scout, gpt-5.2) suffix-match
 * real OpenRouter catalog entries whenever a catalog artifact is present -
 * dist/openrouter-models.json is build-time-fetched and legitimately differs
 * between checkouts, CI, and the packaged VSIX. Call this from suiteSetup
 * beside ensureActivated; a suite that wants catalog behavior must opt back
 * in and seed its own snapshot (docker-resolution does, through
 * litellm._test.seedOpenRouterCatalog).
 */
export async function catalogOff(): Promise<void> {
	await vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.update(OPENROUTER_CATALOG_SETTING_ID, false, vscode.ConfigurationTarget.Global);
}

/**
 * Block the OpenRouter catalog endpoint for this process and return the
 * restore handle. The catalog store arms a refresh 60 seconds after
 * activation and the extension host shares the runner's fetch, so a slow
 * suite would otherwise race a live openrouter.ai snapshot against its
 * controlled catalog state. Everything but that URL passes through.
 */
export function blockCatalogNetwork(): vscode.Disposable {
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === OPENROUTER_MODELS_URL) {
			return Promise.resolve(new Response("catalog network is blocked by the test suite", { status: 503 }));
		}
		return realFetch(input, init);
	}) as typeof globalThis.fetch;
	return {
		dispose: () => {
			globalThis.fetch = realFetch;
		},
	};
}
