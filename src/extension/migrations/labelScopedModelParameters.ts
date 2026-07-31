import * as vscode from "vscode";
import { z } from "zod";
import { normalizeBaseUrl } from "../../shared/baseUrl";
import type { Logger } from "../../shared/logger";
import { CONFIG_SECTION } from "../../shared/settingSpec";
import { MODEL_PARAMETERS_SETTING_KEY } from "../../shared/settings";
import { MIGRATED_SERVER_LABELS_KEY } from "../../shared/storageKeys";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

const labelMapSchema = z.record(z.string(), z.array(z.string()));

/**
 * baseUrl -> labels for servers migrated to provider groups. The group
 * migration writes the map as each server seeds; this migration is its
 * long-term reader, which is why the accessor lives here (and not in
 * registryToProviderGroups, which must be able to import this module to
 * rerun the copy after merging new entries).
 */
export function getMigratedServerLabels(globalState: vscode.Memento): Record<string, string[]> {
	const parsed = labelMapSchema.safeParse(globalState.get<unknown>(MIGRATED_SERVER_LABELS_KEY));
	return parsed.success ? parsed.data : {};
}

/**
 * baseUrl -> labels from BOTH sources the runtime label path used to serve:
 * the persisted map (servers already seeded into provider groups) and the
 * current registry snapshot (servers the group migration has not seeded -
 * deferred or skipped entries have no map entry, but their label and URL sit
 * right in the registry). A label mapping to more than one normalized URL
 * across the union is dropped everywhere - the same rule the group
 * migration's mergeLabelMap applies within the map - because its scoped keys
 * cannot be resolved to one server. URLs are normalized before comparison, so
 * a trailing-slash variant of the same server is not read as a conflict.
 */
export function unionLabelSources(
	labelsByBaseUrl: Record<string, string[]>,
	registryServers: readonly { label: string; baseUrl: string }[]
): Record<string, string[]> {
	const urlsByLabel = new Map<string, Set<string>>();
	const add = (label: string, baseUrl: string): void => {
		const urls = urlsByLabel.get(label) ?? new Set<string>();
		urls.add(normalizeBaseUrl(baseUrl));
		urlsByLabel.set(label, urls);
	};
	for (const [baseUrl, labels] of Object.entries(labelsByBaseUrl)) {
		for (const label of labels) {
			add(label, baseUrl);
		}
	}
	for (const server of registryServers) {
		add(server.label, server.baseUrl);
	}

	const union: Record<string, string[]> = {};
	for (const [label, urls] of urlsByLabel) {
		if (urls.size !== 1) {
			continue;
		}
		const [baseUrl] = urls;
		if (baseUrl === undefined) {
			continue;
		}
		const labels = union[baseUrl] ?? [];
		labels.push(label);
		union[baseUrl] = labels;
	}
	return union;
}

/** The slice of WorkspaceConfiguration the rewrite needs; tests fake it. */
export interface ModelParametersSetting {
	inspect(
		section: string
	): { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined;
	update(section: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * label -> normalized baseUrl. The map handed in only ever holds unambiguous
 * labels (the persisted map and unionLabelSources both guarantee it), so the
 * inversion is total. Normalization matters: the runtime scope is the group's
 * normalized base URL, so a raw map value (say, with a trailing slash) would
 * build a key that never matches.
 */
function invertLabelMap(labelsByBaseUrl: Record<string, string[]>): Map<string, string> {
	const urlByLabel = new Map<string, string>();
	for (const [baseUrl, labels] of Object.entries(labelsByBaseUrl)) {
		for (const label of labels) {
			urlByLabel.set(label, normalizeBaseUrl(baseUrl));
		}
	}
	return urlByLabel;
}

/**
 * Every base-URL-scoped key this key would resolve to under label scoping.
 * At runtime each server's requests consult only that server's own
 * pre-migration label, so when several mapped labels prefix one key, each
 * label is a live reading for its server and each gets a copy.
 *
 * The guard is per label: label L produces no target for a key already under
 * L's OWN base URL (or equal to it), because such a key needs no copy from L,
 * and when L is a URL-prefix of its own base URL (label "https://llm.corp"
 * for base URL "https://llm.corp/v1") the copies added on earlier activations
 * would otherwise re-match L and grow a new "/v1" segment every run. A key
 * under some OTHER server's base URL still gets L's copy: that reading is
 * live for L's server today.
 *
 * Known corner, accepted: when L prefixes its own base URL, a key under that
 * base URL can itself be a genuine label reading (a model prefix that starts
 * with the URL's tail, "v1/..." above), but it is indistinguishable from a
 * copy this migration added earlier, so no copy is made and the key keeps
 * matching through the label path while it lives.
 */
function scopedTargets(key: string, urlByLabel: ReadonlyMap<string, string>): string[] {
	const targets: string[] = [];
	for (const [label, baseUrl] of urlByLabel) {
		if (!key.startsWith(`${label}/`)) {
			continue;
		}
		if (key === baseUrl || key.startsWith(`${baseUrl}/`)) {
			continue;
		}
		const target = `${baseUrl}/${key.slice(label.length + 1)}`;
		if (target !== key) {
			targets.push(target);
		}
	}
	return targets;
}

function countLabelScopedKeys(layer: unknown, urlByLabel: ReadonlyMap<string, string>): number {
	const record = asRecord(layer);
	if (record === undefined) {
		return 0;
	}
	return Object.keys(record).filter((key) => scopedTargets(key, urlByLabel).length > 0).length;
}

/**
 * Add base-URL-scoped copies of label-scoped modelParameters keys: each
 * "<label>/<model prefix>" key gains a "<baseUrl>/<model prefix>" sibling
 * built from the persisted migrated-labels map. The original keys are KEPT: a
 * key like "openai/gpt-4o" may be a bare model-prefix entry rather than a
 * label scope, the two readings are structurally indistinguishable, and both
 * are simultaneously live at runtime today, so copying preserves behavior
 * exactly under either reading while moving would corrupt real config. Once
 * the label-matching path is removed, the originals simply remain valid
 * bare-prefix keys.
 *
 * Only the user (Global) settings layer is edited: workspace and folder
 * settings are shared files this machine's map has no business rewriting, so
 * label-scoped keys found there are counted in a log line (once per
 * activation, until the user rewrites them) instead. Idempotent: a copy whose
 * key already exists is never added, so a rerun finds nothing to do.
 */
export async function rewriteLabelScopedModelParameters(
	setting: ModelParametersSetting,
	labelsByBaseUrl: Record<string, string[]>,
	logger: Logger
): Promise<MigrationOutcome> {
	const urlByLabel = invertLabelMap(labelsByBaseUrl);
	if (urlByLabel.size === 0) {
		return "nothing-to-do";
	}
	const inspected = setting.inspect(MODEL_PARAMETERS_SETTING_KEY);
	if (inspected === undefined) {
		return "nothing-to-do";
	}

	// Counts only: setting keys and base URLs are user-controlled text, and
	// log lines feed the public issue-report buffer.
	const workspaceKeyCount =
		countLabelScopedKeys(inspected.workspaceValue, urlByLabel) +
		countLabelScopedKeys(inspected.workspaceFolderValue, urlByLabel);
	if (workspaceKeyCount > 0) {
		logger.log(
			`${workspaceKeyCount} workspace-layer modelParameters key(s) are scoped by a pre-migration server label and were not rewritten; scope them by base URL ("<baseUrl>/<model prefix>") in the workspace settings instead`
		);
	}

	const globalRecord = asRecord(inspected.globalValue);
	if (globalRecord === undefined) {
		return "nothing-to-do";
	}
	const existingKeys = new Set(Object.keys(globalRecord));
	const additions = new Map<string, unknown>();
	for (const [key, value] of Object.entries(globalRecord)) {
		for (const target of scopedTargets(key, urlByLabel)) {
			if (!existingKeys.has(target) && !additions.has(target)) {
				additions.set(target, value);
			}
		}
	}
	if (additions.size === 0) {
		return "nothing-to-do";
	}

	// Whole-object read/modify/write: another window's pass, or a user edit
	// saved between this read and this write, can be overwritten. Lost COPIES
	// self-heal (the next activation's pass re-adds them); a lost user edit
	// may not. Accepted residual, the same non-transactional trade the rest
	// of the migration family's storage writes make.
	await setting.update(
		MODEL_PARAMETERS_SETTING_KEY,
		Object.fromEntries([...Object.entries(globalRecord), ...additions]),
		vscode.ConfigurationTarget.Global
	);
	logger.log(
		`Added ${additions.size} base-URL-scoped modelParameters key(s) alongside label-scoped ones in user settings`
	);
	return "migrated";
}

/**
 * Migrates away from: the label-scoped modelParameters key syntax of v0.3.1
 * and earlier, where the server label was the scoping identity. Deletable
 * once installs carrying label-scoped keys are judged extinct.
 *
 * Runs pre-registration so the rewrite is awaited before the provider
 * registers and the first request of a session cannot race the copy pass.
 * Labels come from unionLabelSources: the persisted map alone would miss
 * every registry server the group migration has not seeded yet (it only
 * writes the map on successful seeding), so the registry snapshot fills the
 * gap for deferred and skipped servers. The map is still written DURING the
 * group migration's post-registration seeding, after this has already run,
 * so the group migration also reruns this migration whenever a pass merges
 * new label-map entries.
 */
export const labelScopedModelParametersMigration: ExtensionMigration = {
	state: "label-scoped-model-parameters",
	description: "Added base-URL-scoped copies of label-scoped modelParameters keys",
	phase: "pre-registration",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return rewriteLabelScopedModelParameters(
			vscode.workspace.getConfiguration(CONFIG_SECTION),
			unionLabelSources(getMigratedServerLabels(ctx.globalState), ctx.registry.getServers()),
			ctx.logger
		);
	},
};
