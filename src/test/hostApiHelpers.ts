/**
 * Helpers for suites that drive the extension through the real VS Code LM API
 * (vscode.lm.selectChatModels / model.sendRequest): the host-fidelity suite
 * and the docker-stack suites.
 */

import * as assert from "node:assert";
import * as vscode from "vscode";

export interface ServerConfig {
	id: string;
	label: string;
	baseUrl: string;
}

/**
 * Registry mutations are deterministic: the litellm._test.* commands resolve
 * only after the provider refresh completes and return the fresh prepared
 * model IDs (or null when superseded by a newer mutation). These wrappers
 * assert the mutation was not superseded and hand back the topology.
 */
export async function clearServers(): Promise<string[]> {
	const modelIds = (await vscode.commands.executeCommand("litellm._test.clearServers")) as string[] | null;
	assert.ok(modelIds !== null, "clearServers was superseded by a concurrent registry mutation");
	return modelIds;
}

export async function addServer(
	label: string,
	baseUrl: string,
	apiKey: string
): Promise<{ server: ServerConfig; modelIds: string[] }> {
	const result = (await vscode.commands.executeCommand("litellm._test.addServer", label, baseUrl, apiKey)) as {
		server: ServerConfig;
		modelIds: string[] | null;
	};
	assert.ok(result.modelIds !== null, `addServer(${label}) was superseded by a concurrent registry mutation`);
	return { server: result.server, modelIds: result.modelIds };
}

/** True when the host's model list is exactly the expected set of IDs. */
export function hostMatches(models: vscode.LanguageModelChat[], expectedIds: string[]): boolean {
	const actual = models.map((model) => model.id).sort();
	const expected = [...expectedIds].sort();
	return actual.length === expected.length && actual.every((id, i) => id === expected[i]);
}

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
	// The docker suites pin what the SERVER declares (pricing absence, no
	// vision), but the fake stack's realistic model names (llama-4-scout,
	// gpt-5.2) suffix-match real OpenRouter catalog entries whenever a catalog
	// artifact is present - dist/openrouter-models.json is build-time-fetched
	// and legitimately differs between checkouts, CI, and the packaged VSIX.
	// Turning the catalog off makes every docker assertion hermetic; a suite
	// that wants catalog behavior must opt back in and seed its own snapshot.
	await vscode.workspace
		.getConfiguration("litellm-vscode-chat")
		.update("models.openRouterCatalog", false, vscode.ConfigurationTarget.Global);
}
