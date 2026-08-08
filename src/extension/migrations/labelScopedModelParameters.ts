/**
 * Label-scoped modelParameters keys ("<label>/<model prefix>", the v0.3.1
 * scoping syntax) and the label map that decodes them. The standalone
 * rewrite migration is FOLDED into the settings-redesign pipeline: the pure
 * expansion below runs as the pipeline's pre-pass (transform.ts), writing
 * only old-world shapes - flat entry modelParameters fields and URL-scoped
 * global keys - that the very same plan then restructures, so the redesign
 * stays the one owner of URL-scoped key placement. Once the redesign has
 * renamed the legacy id away, the expansion finds nothing and the fold is a
 * permanent no-op.
 *
 * getMigratedServerLabels stays here as the label map's long-term reader
 * (registryToProviderGroups writes the map as each server seeds and must be
 * able to import this module).
 */

import type * as vscode from "vscode";
import { z } from "zod";
import { MIGRATED_ENTRY_PARAMETER_COPIES_KEY, MIGRATED_SERVER_LABELS_KEY } from "../../shared/config/storageKeys";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { isUnsafeRecordKey } from "../../shared/util/json";
import { acceptedEntry } from "../servers/serverSync";
import { LEGACY_MODEL_PARAMETERS_ID, SERVERS_ID } from "./settingsRedesign/legacyIds";
import type { SettingsSnapshot } from "./settingsRedesign/types";

const labelMapSchema = z.record(z.string(), z.array(z.string()));

/**
 * baseUrl -> labels for servers migrated to provider groups. The group
 * migration writes the map as each server seeds; the settings-redesign
 * pipeline's label expansion is its long-term reader.
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
 * the model prefix left when the label scope is stripped. Under the (long
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
 * copy an earlier run added, so no reading is reported and that residual
 * label reading is lost with the label-matching path.
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
 * to the global base-URL copy.
 */
function declaredDestination(rawServers: unknown, label: string, mappedBaseUrl: string): { index: number } | undefined {
	const match = acceptedEntry(rawServers, label);
	if (match === undefined || normalizeBaseUrl(match.entry.baseUrl) !== mappedBaseUrl) {
		return undefined;
	}
	return { index: match.index };
}

const ledgerSchema = z.array(z.string());

/**
 * The standalone rewrite's entry-copy ledger, read to honor a pre-redesign
 * deletion: a source key an EARLIER release already copied into an entry must
 * not be resurrected here if the user deleted the copy since. The applier
 * clears the obsolete ledger once the legacy id itself is gone.
 */
export function readEntryCopyLedger(store: { get<T>(key: string): T | undefined }): ReadonlySet<string> {
	const parsed = ledgerSchema.safeParse(store.get<unknown>(MIGRATED_ENTRY_PARAMETER_COPIES_KEY));
	return new Set(parsed.success ? parsed.data : []);
}

/** One resolved source key as a ledger member; JSON keeps a label containing "/" unambiguous. */
function ledgerMember(label: string, prefix: string): string {
	return JSON.stringify([label, prefix]);
}

export interface LabelExpansionResult {
	/** The snapshot with the expansion applied (the input object when nothing expanded). */
	readonly snapshot: SettingsSnapshot;
	readonly logLines: readonly string[];
}

/**
 * The settings-redesign pipeline's pre-pass: expand label-scoped keys of the
 * LEGACY modelParameters record to their post-label destinations, in memory,
 * as old-world shapes the rest of the plan consumes. The exact-semantics
 * destination is the declared servers-setting entry carrying the label: the
 * key's parameters land in that entry's FLAT modelParameters record under
 * the bare "<model prefix>" key (the entry restructure in the same plan
 * nests and stars it), so two same-URL labels with different parameters each
 * keep their own values. Existing entry keys win the merge and expanded keys
 * only fill gaps. Only when no declared entry carries the label (at the
 * label's own URL), or when the stripped prefix is an unsafe record key
 * ("__proto__" and friends), does the reading fall back to a
 * "<baseUrl>/<model prefix>" copy beside the source - which the plan's
 * scoped-key step then places (into a matching entry, or left inert with the
 * dashboard hint), keeping ONE owner for URL-scoped keys.
 *
 * The original keys are KEPT: a key like "openai/gpt-4o" may be a bare
 * model-prefix entry rather than a label scope, the two readings are
 * structurally indistinguishable, and both were simultaneously live at
 * runtime when the keys were written - the plan stars the originals into
 * explicit matchers like any other key. Workspace and folder layers are
 * never touched; label-scoped keys found there are counted in a log line.
 * Idempotent through the pipeline: the same plan deletes the legacy id, so a
 * rerun finds no record to expand.
 */
export function expandLabelScopedKeys(
	snapshot: SettingsSnapshot,
	labelsByBaseUrl: Record<string, string[]>,
	entryCopyLedger: ReadonlySet<string>
): LabelExpansionResult {
	const urlByLabel = invertLabelMap(labelsByBaseUrl);
	const layers = snapshot[LEGACY_MODEL_PARAMETERS_ID];
	if (urlByLabel.size === 0 || layers === undefined) {
		return { snapshot, logLines: [] };
	}

	const logLines: string[] = [];
	// Counts only: setting keys and base URLs are user-controlled text, and
	// log lines feed the public issue-report buffer.
	const workspaceKeyCount =
		countLabelScopedKeys(layers.workspaceValue, urlByLabel) +
		countLabelScopedKeys(layers.workspaceFolderValue, urlByLabel);
	if (workspaceKeyCount > 0) {
		logLines.push(
			`${workspaceKeyCount} workspace-layer modelParameters key(s) are scoped by a pre-migration server label and were not rewritten; put them in the matching entry's models.parameters in the servers setting, or scope them by base URL ("<baseUrl>/<model prefix>") in the workspace settings instead`
		);
	}

	const globalRecord = asRecord(layers.globalValue);
	if (globalRecord === undefined) {
		return { snapshot, logLines };
	}
	const rawServers = snapshot[SERVERS_ID]?.globalValue;
	const existingKeys = new Set(Object.keys(globalRecord));
	const globalAdditions = new Map<string, unknown>();
	const entryAdditions = new Map<number, Map<string, unknown>>();
	for (const [key, value] of Object.entries(globalRecord)) {
		for (const reading of labelReadings(key, urlByLabel)) {
			const destination = isUnsafeRecordKey(reading.prefix)
				? undefined
				: declaredDestination(rawServers, reading.label, reading.baseUrl);
			if (destination !== undefined) {
				if (entryCopyLedger.has(ledgerMember(reading.label, reading.prefix))) {
					// An earlier release already copied this source into the entry;
					// a deletion since then is the user's decision and stays deleted.
					continue;
				}
				const rawEntry = asRecord(Array.isArray(rawServers) ? rawServers[destination.index] : undefined);
				const rawParams = asRecord(rawEntry?.modelParameters);
				// Existing entry keys win; the raw record is the reference so a
				// value the entry parser reads as malformed still counts as the
				// user's own key and is never overwritten.
				if (rawParams === undefined || !Object.hasOwn(rawParams, reading.prefix)) {
					const additions = entryAdditions.get(destination.index) ?? new Map<string, unknown>();
					if (!additions.has(reading.prefix)) {
						additions.set(reading.prefix, value);
					}
					entryAdditions.set(destination.index, additions);
				}
				continue;
			}
			const target = `${reading.baseUrl}/${reading.prefix}`;
			if (!existingKeys.has(target) && !globalAdditions.has(target)) {
				globalAdditions.set(target, value);
			}
		}
	}

	if (globalAdditions.size === 0 && entryAdditions.size === 0) {
		return { snapshot, logLines };
	}

	const amended: Record<string, (typeof snapshot)[string]> = { ...snapshot };
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
		amended[SERVERS_ID] = { ...amended[SERVERS_ID], globalValue: nextServers };
		logLines.push(
			`Copied ${movedKeys} label-scoped modelParameters key(s) into their declared entries' model records in user settings`
		);
	}
	if (globalAdditions.size > 0) {
		amended[LEGACY_MODEL_PARAMETERS_ID] = {
			...layers,
			globalValue: Object.fromEntries([...Object.entries(globalRecord), ...globalAdditions]),
		};
		logLines.push(
			`Added ${globalAdditions.size} base-URL-scoped modelParameters key(s) alongside label-scoped ones in user settings`
		);
	}
	return { snapshot: amended, logLines };
}
