/**
 * Helpers for suites that drive VS Code-managed provider groups: the
 * host-fidelity-groups suite and the group-path ports of the docker suites.
 *
 * Two host facts shape every helper here:
 *
 * - Provider groups are ADD-ONLY for the host lifetime: there is no remove or
 *   update command, and re-adding a name is rejected (pinned by
 *   extension/hostGroupCommand.test.ts). Groups accumulate until the
 *   extension host exits, so names must be unique per test and model-list
 *   assertions must scope themselves to an explicit universe.
 * - vscode.lm model objects expose id/vendor/family/version/name but no group
 *   identity, so the only way a suite can attribute a model to the group that
 *   served it is a model ID unique to that group (host-fidelity-groups.test.ts
 *   pins that a duplicated ID surfaces as indistinguishable twin entries).
 */

import * as vscode from "vscode";
import type { DeclaredServerView } from "../extension/servers/serverSync";
import { VENDOR_ID } from "../shared/config/commandIds";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../shared/config/settingSpec";
import type { ExpectedFailureCategory } from "../shared/serverEntry";
import type { ServerStatus } from "../shared/servers";
import { waitForHostModels } from "./hostApiHelpers";

let nameCounter = 0;

/**
 * A name no other test run in this add-only host can collide with: unique
 * per process and per call.
 */
export function uniqueName(prefix: string): string {
	nameCounter += 1;
	return `${prefix}-${process.pid}-${nameCounter}`;
}

export interface ProviderGroupConfig {
	readonly name: string;
	readonly baseUrl: string;
	readonly apiKey: string;
}

/**
 * Add a provider group through the host command, mirroring the declared-entry
 * sync chain: `label` rides inside the configuration and equals the name,
 * because the host echoes only the configuration back to the provider and the
 * label inside it is what gives the group its status identity.
 */
export async function addGroup(config: ProviderGroupConfig): Promise<void> {
	await vscode.commands.executeCommand("lm.addLanguageModelsProviderGroup", {
		name: config.name,
		vendor: VENDOR_ID,
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		label: config.name,
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the provider's status window holds a status for `label` that
 * satisfies the predicate. The host resolves groups by calling the provider,
 * but ingests asynchronously and offers no completion signal, so the poll
 * nudges it with model queries between reads. Resolution is BY LABEL and
 * takes the first match: distinct credential material for one label (say, a
 * refreshEntryModels call after the entry's secret changed) mints a second
 * window identity under the same label, and this helper does not
 * disambiguate them.
 */
export async function waitForGroupStatus(
	label: string,
	predicate: (status: ServerStatus) => boolean,
	timeoutMs: number
): Promise<ServerStatus> {
	const deadline = Date.now() + timeoutMs;
	let statuses: ServerStatus[] = [];
	for (;;) {
		statuses = (await vscode.commands.executeCommand("litellm._test.getServerStatuses")) as ServerStatus[];
		const status = statuses.find((candidate) => candidate.label === label);
		if (status !== undefined && predicate(status)) {
			return status;
		}
		if (Date.now() >= deadline) {
			const seen = statuses.map((s) => `${s.label} (${s.state})`).join(", ") || "(none)";
			throw new Error(`Timeout (${timeoutMs}ms) waiting for group status "${label}". Statuses: ${seen}`);
		}
		await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
		await sleep(200);
	}
}

export type ModelsPredicate = (models: readonly vscode.LanguageModelChat[]) => boolean;

/**
 * Wait until the host's model list satisfies the predicate: the group
 * suites' predicate-first spelling of hostApiHelpers.waitForHostModels, so
 * there is exactly one polling loop (each poll's selectChatModels call
 * doubles as the resolution nudge).
 */
export async function waitForModels(
	predicate: ModelsPredicate,
	timeoutMs: number,
	description: string
): Promise<vscode.LanguageModelChat[]> {
	return waitForHostModels(timeoutMs, predicate, description);
}

/**
 * A predicate that holds when the models inside the caller's universe are
 * exactly `expectedIds`, duplicates counted (two group entries sharing one ID
 * must read as two). The universe is required, never implied: under an
 * add-only host, earlier tests' groups linger for the host lifetime, so a
 * whole-list exact match is meaningless - scope to the IDs this test minted.
 */
export function scopedExact(
	universe: (model: vscode.LanguageModelChat) => boolean,
	expectedIds: readonly string[]
): ModelsPredicate {
	const expected = [...expectedIds].sort();
	return (models) => {
		const actual = models
			.filter(universe)
			.map((model) => model.id)
			.sort();
		return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
	};
}

/** The nested settings shape of one litellm-vscode-chat.servers entry, as far as the suites declare it. */
export interface ServerSettingEntry {
	readonly label: string;
	readonly baseUrl: string;
	readonly auth?: { readonly apiKey: string };
	readonly discovery?: {
		readonly declared?: readonly string[];
		readonly expectedFailures?: readonly ExpectedFailureCategory[];
	};
}

const entryLabelIs = (item: unknown, label: string): boolean =>
	typeof item === "object" && item !== null && (item as { label?: unknown }).label === label;

function serversSetting(): { config: vscode.WorkspaceConfiguration; entries: unknown[] } {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<unknown>(SERVERS_SETTING_KEY);
	return { config, entries: Array.isArray(raw) ? raw : [] };
}

async function waitForDeclared(
	predicate: (views: readonly DeclaredServerView[]) => boolean,
	timeoutMs: number,
	description: string
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let views: readonly DeclaredServerView[] = [];
	for (;;) {
		views = (await vscode.commands.executeCommand("litellm._test.getDeclaredServers")) as DeclaredServerView[];
		if (predicate(views)) {
			return;
		}
		if (Date.now() >= deadline) {
			const seen = views.map((view) => `${view.label}${view.syncError ? ` (${view.syncError})` : ""}`).join(", ");
			throw new Error(`Timeout (${timeoutMs}ms) waiting for ${description}. Declared: ${seen || "(none)"}`);
		}
		await sleep(200);
	}
}

/**
 * Write one entry into the real litellm-vscode-chat.servers setting
 * (replacing any previous entry with the same label) and wait for the
 * declarative sync to settle: the entry accepted without a sync error, and
 * the host's per-group call for it recorded a status. Returns that status;
 * callers wanting a specific state assert on it or keep polling with
 * waitForGroupStatus.
 */
export async function writeServerEntry(entry: ServerSettingEntry, timeoutMs = 20000): Promise<ServerStatus> {
	const { config, entries } = serversSetting();
	const kept = entries.filter((item) => !entryLabelIs(item, entry.label));
	await config.update(SERVERS_SETTING_KEY, [...kept, entry], vscode.ConfigurationTarget.Global);
	await waitForDeclared(
		(views) => views.some((view) => view.label === entry.label && view.syncError === undefined),
		timeoutMs,
		`entry "${entry.label}" to sync without error`
	);
	return waitForGroupStatus(entry.label, () => true, timeoutMs);
}

/**
 * Remove one entry from the servers setting and wait for the sync engine to
 * drop its declared view. Only the declaration leaves: the provider group
 * survives for the host lifetime (add-only host), but the engine publishes
 * its views only after removal reconciliation, so a departed view implies
 * the removal tombstone already suppresses the group (it reports as hidden,
 * serving no models, from the host's next refresh on).
 */
export async function removeServerEntry(label: string, timeoutMs = 20000): Promise<void> {
	const { config, entries } = serversSetting();
	await config.update(
		SERVERS_SETTING_KEY,
		entries.filter((item) => !entryLabelIs(item, label)),
		vscode.ConfigurationTarget.Global
	);
	await waitForDeclared(
		(views) => views.every((view) => view.label !== label),
		timeoutMs,
		`entry "${label}" to leave the declared servers`
	);
}
