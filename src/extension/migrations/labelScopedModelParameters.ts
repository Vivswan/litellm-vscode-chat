import * as vscode from "vscode";
import { z } from "zod";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { MODEL_PARAMETERS_SETTING_KEY, SERVERS_SETTING_KEY } from "../../shared/config/settings";
import { MIGRATED_ENTRY_PARAMETER_COPIES_KEY, MIGRATED_SERVER_LABELS_KEY } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { isUnsafeRecordKey } from "../../shared/util/json";
import { acceptedEntry } from "../servers/serverSync";
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

/** The slice of WorkspaceConfiguration the rewrite needs (the modelParameters and servers sections); tests fake it. */
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
 * Every live label reading of this key: the label, its mapped base URL, and
 * the model prefix left when the label scope is stripped. Under the (now
 * removed) label-matching path each server's requests consulted only that
 * server's own pre-migration label, so when several mapped labels prefix one
 * key, each label was a live reading for its server and each is returned.
 *
 * The guard is per label: label L produces no reading for a key already under
 * L's OWN base URL (or equal to it), because such a key needs nothing from L,
 * and when L is a URL-prefix of its own base URL (label "https://llm.corp"
 * for base URL "https://llm.corp/v1") the copies added on earlier activations
 * would otherwise re-match L and grow a new "/v1" segment every run. A key
 * under some OTHER server's base URL still gets L's reading: it was live for
 * L's server when the key was written.
 *
 * Known corner, accepted: when L prefixes its own base URL, a key under that
 * base URL can itself be a genuine label reading (a model prefix that starts
 * with the URL's tail, "v1/..." above), but it is indistinguishable from a
 * copy this migration added earlier, so no reading is reported and that
 * residual label reading is lost with the label-matching path.
 */
function labelReadings(
	key: string,
	urlByLabel: ReadonlyMap<string, string>
): { label: string; baseUrl: string; prefix: string }[] {
	const readings: { label: string; baseUrl: string; prefix: string }[] = [];
	for (const [label, baseUrl] of urlByLabel) {
		if (!key.startsWith(`${label}/`)) {
			continue;
		}
		if (key === baseUrl || key.startsWith(`${baseUrl}/`)) {
			continue;
		}
		const prefix = key.slice(label.length + 1);
		if (`${baseUrl}/${prefix}` !== key) {
			readings.push({ label, baseUrl, prefix });
		}
	}
	return readings;
}

function countLabelScopedKeys(layer: unknown, urlByLabel: ReadonlyMap<string, string>): number {
	const record = asRecord(layer);
	if (record === undefined) {
		return 0;
	}
	return Object.keys(record).filter((key) => labelReadings(key, urlByLabel).length > 0).length;
}

/**
 * The declared servers-setting entry a label reading lands in, when one
 * exists on this machine: the entry acceptedEntry resolves for the label,
 * and only when its normalized base URL is the label's mapped URL. A
 * same-label entry pointing elsewhere is a label reuse - the params were
 * scoped to the old server - so it gets nothing and the reading falls back
 * to the global base-URL rewrite.
 */
function declaredDestination(rawServers: unknown, label: string, mappedBaseUrl: string): { index: number } | undefined {
	const match = acceptedEntry(rawServers, label);
	if (match === undefined || normalizeBaseUrl(match.entry.baseUrl) !== mappedBaseUrl) {
		return undefined;
	}
	return { index: match.index };
}

/** The Memento slice the entry-copy ledger lives in; MigrationContext.globalState satisfies it. */
export interface LedgerStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

const ledgerSchema = z.array(z.string());

function readEntryCopyLedger(store: LedgerStore): Set<string> {
	const parsed = ledgerSchema.safeParse(store.get<unknown>(MIGRATED_ENTRY_PARAMETER_COPIES_KEY));
	return new Set(parsed.success ? parsed.data : []);
}

/** One resolved source key as a ledger member; JSON keeps a label containing "/" unambiguous. */
function ledgerMember(label: string, prefix: string): string {
	return JSON.stringify([label, prefix]);
}

/**
 * Rewrite label-scoped modelParameters keys ("<label>/<model prefix>") to
 * their post-label destinations. The exact-semantics destination is the
 * declared servers-setting entry carrying the label: the key's parameters
 * land in that entry's own modelParameters record under the bare
 * "<model prefix>" key, which the request path applies to exactly that
 * entry's requests - two same-URL labels with different parameters each keep
 * their own values instead of collapsing into one base-URL key. Existing
 * entry keys win the merge and migrated keys only fill gaps: a record the
 * user already wrote in the entry is deliberate current configuration, while
 * the label-scoped key is a legacy leftover. Only when no declared entry
 * carries the label (at the label's own URL), or when the stripped prefix is
 * an unsafe record key ("__proto__" and friends - it could never become an
 * own key of the entry record, so writing it would re-queue forever), does
 * the key fall back to a "<baseUrl>/<model prefix>" copy in the global
 * setting, whose full string key is always a safe own property.
 *
 * The original keys are KEPT in both paths: a key like "openai/gpt-4o" may be
 * a bare model-prefix entry rather than a label scope, the two readings are
 * structurally indistinguishable, and both were simultaneously live at
 * runtime when the keys were written, so copying preserves behavior exactly
 * under either reading while moving would corrupt real config. With the
 * label-matching path gone, the originals simply remain valid bare-prefix
 * keys. Because the sources survive, entry destinations carry a persisted
 * ledger (MIGRATED_ENTRY_PARAMETER_COPIES_KEY): each source key migrates
 * into an entry AT MOST ONCE - written, or found already present - so a user
 * deleting the migrated key from the entry record does not see it
 * resurrected on the next activation, while a rerun after a partial write
 * still completes the unrecorded remainder. (The narrow crash window between
 * the settings write and the ledger persist can re-add a key deleted inside
 * it; the next completed pass closes the ledger.)
 *
 * Only the user (Global) settings layer is edited: workspace and folder
 * settings are shared files this machine's map has no business rewriting, so
 * label-scoped keys found there are counted in a log line (once per
 * activation, until the user rewrites them) instead. The servers setting is
 * machine-scoped, so the entry destination exists only where the entry is
 * declared; on a machine without it the fallback applies, and the migration
 * reruns per machine either way. Idempotent: a ledgered source, an entry key,
 * or a global copy that already exists is never added, so a rerun finds
 * nothing to do.
 */
export async function rewriteLabelScopedModelParameters(
	setting: ModelParametersSetting,
	labelsByBaseUrl: Record<string, string[]>,
	logger: Logger,
	ledgerStore: LedgerStore
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
			`${workspaceKeyCount} workspace-layer modelParameters key(s) are scoped by a pre-migration server label and were not rewritten; put them in the matching entry's modelParameters in the servers setting, or scope them by base URL ("<baseUrl>/<model prefix>") in the workspace settings instead`
		);
	}

	const globalRecord = asRecord(inspected.globalValue);
	if (globalRecord === undefined) {
		return "nothing-to-do";
	}
	const rawServers: unknown = setting.inspect(SERVERS_SETTING_KEY)?.globalValue;
	const ledger = readEntryCopyLedger(ledgerStore);
	const existingKeys = new Set(Object.keys(globalRecord));
	const globalAdditions = new Map<string, unknown>();
	const entryAdditions = new Map<number, Map<string, unknown>>();
	const resolvedMembers = new Set<string>();
	for (const [key, value] of Object.entries(globalRecord)) {
		for (const reading of labelReadings(key, urlByLabel)) {
			const destination = isUnsafeRecordKey(reading.prefix)
				? undefined
				: declaredDestination(rawServers, reading.label, reading.baseUrl);
			if (destination !== undefined) {
				const member = ledgerMember(reading.label, reading.prefix);
				if (ledger.has(member)) {
					// Already migrated into the entry once; a deletion since then
					// is the user's decision and stays deleted.
					continue;
				}
				const rawEntry = asRecord(Array.isArray(rawServers) ? rawServers[destination.index] : undefined);
				const rawParams = asRecord(rawEntry?.modelParameters);
				// Existing entry keys win; the raw record is the reference so a
				// value the entry parser reads as malformed still counts as the
				// user's own key and is never overwritten. Either way the source
				// counts as resolved into this entry.
				if (rawParams === undefined || !Object.hasOwn(rawParams, reading.prefix)) {
					const additions = entryAdditions.get(destination.index) ?? new Map<string, unknown>();
					if (!additions.has(reading.prefix)) {
						additions.set(reading.prefix, value);
					}
					entryAdditions.set(destination.index, additions);
				}
				resolvedMembers.add(member);
				continue;
			}
			const target = `${reading.baseUrl}/${reading.prefix}`;
			if (!existingKeys.has(target) && !globalAdditions.has(target)) {
				globalAdditions.set(target, value);
			}
		}
	}

	// Whole-object read/modify/write on both settings: another window's pass,
	// or a user edit saved between this read and this write, can be
	// overwritten. Lost COPIES self-heal (the next activation's pass re-adds
	// them); a lost user edit may not. Accepted residual, the same
	// non-transactional trade the rest of the migration family's storage
	// writes make.
	if (entryAdditions.size > 0 && Array.isArray(rawServers)) {
		let movedKeys = 0;
		const nextServers = rawServers.map((item: unknown, index) => {
			const additions = entryAdditions.get(index);
			const record = asRecord(item);
			if (additions === undefined || record === undefined) {
				return item;
			}
			const merged: Record<string, unknown> = { ...(asRecord(record.modelParameters) ?? {}) };
			for (const [prefix, value] of additions) {
				if (!Object.hasOwn(merged, prefix)) {
					merged[prefix] = value;
					movedKeys += 1;
				}
			}
			return { ...record, modelParameters: merged };
		});
		await setting.update(SERVERS_SETTING_KEY, nextServers, vscode.ConfigurationTarget.Global);
		logger.log(
			`Copied ${movedKeys} label-scoped modelParameters key(s) into their declared entries' modelParameters in user settings`
		);
	}
	// The ledger persists only after the settings write succeeded (a failed
	// write must be retried, not recorded), and also when nothing needed
	// writing because the entry already held the key - that source is
	// resolved too, and without the record a later deletion would resurrect
	// it.
	if (resolvedMembers.size > 0) {
		await ledgerStore.update(MIGRATED_ENTRY_PARAMETER_COPIES_KEY, [...ledger, ...resolvedMembers]);
	}
	if (globalAdditions.size > 0) {
		await setting.update(
			MODEL_PARAMETERS_SETTING_KEY,
			Object.fromEntries([...Object.entries(globalRecord), ...globalAdditions]),
			vscode.ConfigurationTarget.Global
		);
		logger.log(
			`Added ${globalAdditions.size} base-URL-scoped modelParameters key(s) alongside label-scoped ones in user settings`
		);
	}
	return globalAdditions.size === 0 && entryAdditions.size === 0 ? "nothing-to-do" : "migrated";
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
	description: "Rewrote label-scoped modelParameters keys to their declared entries or base-URL-scoped copies",
	sourceRelease: "0.3.1",
	phase: "pre-registration",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return rewriteLabelScopedModelParameters(
			vscode.workspace.getConfiguration(CONFIG_SECTION),
			unionLabelSources(getMigratedServerLabels(ctx.globalState), ctx.registry.getServers()),
			ctx.logger,
			ctx.globalState
		);
	},
};
