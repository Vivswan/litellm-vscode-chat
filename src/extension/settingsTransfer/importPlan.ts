/**
 * Import planning in two pure steps: planSettingsImport reduces a parsed
 * envelope plus the current servers setting to an ImportPlan (what would be
 * written, what collides, what gets skipped and why), and resolveImportPlan
 * folds the user's collision decisions into an ImportApplication (the exact
 * writes the host flow applies). Nothing here writes; the split keeps every
 * prompt between the two steps fakeable.
 *
 * No direct vscode usage; the one impurity is the serverSync setting parser,
 * whose module graph reaches vscode at load time in the host (the plan sited
 * this core in extension/ for exactly that dependency).
 */

import {
	ALL_SETTING_KEYS,
	BOOLEAN_SETTING_SPECS,
	NUMBER_SETTING_SPECS,
	SERVERS_SETTING_KEY,
	USAGE_STATUS_BAR_SETTING_KEY,
} from "../../shared/config/settingSpec";
import { OPTIONAL_ENTRY_FIELDS } from "../../shared/serverEntry";
import { isRecord, isUnsafeRecordKey } from "../../shared/util/json";
import type { StoredServerSecrets } from "../servers/serverSync/secrets";
import type { DeclaredServer, ServerEntryReport } from "../servers/serverSync/setting";
import { acceptedEntry, rawDeclaredLabels, serverSettingReports } from "../servers/serverSync/setting";
import { declaredEntryLabel } from "./exportBuild";
import { stripEntrySecrets } from "./secretSurgery";

/**
 * The usage.statusBar vocabulary, re-declared like the webview's copies:
 * its home (shared/config/settings.ts USAGE_STATUS_BAR_MODES) would add a
 * direct vscode-plus-zod module dependency this table does not need;
 * importPlan.test.ts pins the mirror.
 */
export const USAGE_STATUS_BAR_MODE_VALUES: readonly string[] = ["always", "alerts-only", "off"];

/** One non-servers key the plan writes to the user scope. */
export interface SettingWrite {
	readonly key: string;
	readonly value: unknown;
}

/** One non-servers key the plan refuses, and why. */
export interface SkippedKey {
	readonly key: string;
	/**
	 * The light scalar type gate: a spec'd number/boolean key or the
	 * enum-string usage.statusBar whose incoming value has the wrong type.
	 * The other structured keys pass through to their readers' existing
	 * leniency instead and never land here. One structured exception: a
	 * servers value that is not an array cannot travel through
	 * incomingServers, so it lands here rather than dropping silently.
	 */
	readonly reason: "wrong-type";
}

/** One entry of the file's servers array, with its acceptance verdict for the preview. */
export interface IncomingServer {
	/**
	 * The raw entry exactly as the file carries it - inline secret values
	 * included when the file was exported with them. It must never cross the
	 * webview boundary or reach the log buffer; the preview surfaces render
	 * the report beside it, not the entry itself.
	 */
	readonly raw: unknown;
	/** The entry's verdict, from the same serverSettingReports pass the dashboard diagnostics run. */
	readonly report: ServerEntryReport;
	/**
	 * True when the entry cannot import at all: no usable label, or a reserved
	 * one (no SecretStorage key is possible for either). Skipped entries count
	 * into the summary and never reach the collision or apply steps.
	 */
	readonly skipped: boolean;
}

/** One label collision between the file and the current setting's raw labels. */
export interface ServerCollision {
	readonly label: string;
	/**
	 * True when the incoming entry changes connection-level fields (baseUrl or
	 * auth material) against the current entry, so an overwrite follows the
	 * sync engine's group-update-unavailable path; the preview says so upfront.
	 * With planSettingsImport's storedSecrets provided, the current side
	 * compares by EFFECTIVE secret material (inline winning over the label's
	 * blob, exactly as buildGroupArgs resolves), so a secret merely moving
	 * between inline and SecretStorage with the same value does not flag.
	 */
	readonly connectionChanged: boolean;
}

/** Everything the import preview states and the collision prompts iterate; resolveImportPlan consumes it whole. */
export interface ImportPlan {
	/** Non-servers keys to write, in ALL_SETTING_KEYS order; the servers key travels through incomingServers instead. */
	readonly settingsWrites: readonly SettingWrite[];
	readonly skippedKeys: readonly SkippedKey[];
	/** The file's servers array, one verdict per entry; empty when the file carries no servers key. */
	readonly incomingServers: readonly IncomingServer[];
	/** Importable incoming labels already present in the current setting (vs rawDeclaredLabels), in file order. */
	readonly collisions: readonly ServerCollision[];
	/** Inline secret values across the entries that would land (one representative per label; see resolveImportPlan). */
	readonly secretFieldCount: number;
	/** The current servers setting's raw user-scope value, carried verbatim for resolveImportPlan's merge. */
	readonly currentServersRaw: unknown;
}

/** Whether the incoming value's JS type fits the key's scalar spec; structured keys always pass. */
function passesTypeGate(key: string, value: unknown): boolean {
	if (Object.hasOwn(NUMBER_SETTING_SPECS, key)) {
		const spec = NUMBER_SETTING_SPECS[key as keyof typeof NUMBER_SETTING_SPECS];
		return typeof value === "number" || (spec.nullable && value === null);
	}
	if (Object.hasOwn(BOOLEAN_SETTING_SPECS, key)) {
		return typeof value === "boolean";
	}
	if (key === USAGE_STATUS_BAR_SETTING_KEY) {
		return typeof value === "string" && USAGE_STATUS_BAR_MODE_VALUES.includes(value);
	}
	return true;
}

/**
 * One parsed entry's connection-level material: the field set buildGroupArgs
 * emits, with the entry's inline secret values winning over the supplied
 * blob (the engine's own precedence). name, vendor, and label are omitted
 * because a collision's two sides share the label; what remains is baseUrl
 * plus the flat credential fields, in the descriptor order the fingerprint
 * freezes. importPlan.test.ts pins this rendering against buildGroupArgs
 * itself.
 */
function connectionFingerprint(entry: DeclaredServer | undefined, stored: StoredServerSecrets): string | undefined {
	if (entry === undefined) {
		return undefined;
	}
	const fields: Record<string, string> = { baseUrl: entry.baseUrl };
	for (const field of OPTIONAL_ENTRY_FIELDS) {
		// The parsed entry's secret fields ARE its inline values, so this is
		// exactly buildGroupArgs's inline-over-stored resolution.
		const value = field.secret ? (entry[field.id] ?? stored[field.id]) : entry[field.id];
		if (value !== undefined) {
			fields[field.id] = value;
		}
	}
	return JSON.stringify(fields);
}

/**
 * One raw-array index per incoming label: the entry that would take effect
 * for that label if the array were written, mirroring the parser's claim
 * rule (acceptEntries: the first element with a usable label AND baseUrl
 * claims the label, auth problems aside; a baseUrl-less fragment claims
 * nothing). When no element claims, the first labeled element stands in, so
 * a lone fragment still imports instead of vanishing.
 */
function representativeIndices(incomingServers: readonly IncomingServer[]): ReadonlyMap<string, number> {
	const claimants = new Map<string, number>();
	const fallbacks = new Map<string, number>();
	incomingServers.forEach((incoming, index) => {
		const label = incoming.report.label;
		if (incoming.skipped || label === undefined) {
			return;
		}
		if (incoming.report.baseUrl !== undefined && !claimants.has(label)) {
			claimants.set(label, index);
		}
		if (!fallbacks.has(label)) {
			fallbacks.set(label, index);
		}
	});
	return new Map([...fallbacks].map(([label, index]) => [label, claimants.get(label) ?? index]));
}

/**
 * Reduce the parsed envelope's settings plus the current raw servers value
 * to an ImportPlan. `storedSecrets` is the host's pre-fetched SecretStorage
 * blobs by label (colliding labels suffice); when provided, each collision's
 * connectionChanged compares the current side's effective secret material
 * instead of inline text alone. Absent, resolution is inline-only. Pure and
 * synchronous either way; the incoming side never has a blob (its inline
 * values become its blob at apply time, which leaves the group args as-is).
 */
export function planSettingsImport(
	envelopeSettings: Readonly<Record<string, unknown>>,
	currentServersRaw: unknown,
	storedSecrets?: Readonly<Record<string, StoredServerSecrets>>
): ImportPlan {
	const settingsWrites: SettingWrite[] = [];
	const skippedKeys: SkippedKey[] = [];
	const incomingServers: IncomingServer[] = [];

	for (const key of ALL_SETTING_KEYS) {
		if (!Object.hasOwn(envelopeSettings, key)) {
			continue;
		}
		const value = envelopeSettings[key];
		if (key === SERVERS_SETTING_KEY) {
			if (!Array.isArray(value)) {
				skippedKeys.push({ key, reason: "wrong-type" });
				continue;
			}
			const reports = serverSettingReports(value);
			value.forEach((raw: unknown, index) => {
				const report = reports[index] ?? { index, problems: [], accepted: false };
				incomingServers.push({ raw, report, skipped: report.label === undefined });
			});
			continue;
		}
		if (passesTypeGate(key, value)) {
			settingsWrites.push({ key, value });
		} else {
			skippedKeys.push({ key, reason: "wrong-type" });
		}
	}

	const currentLabels = rawDeclaredLabels(currentServersRaw);
	const incomingArray = incomingServers.map((incoming) => incoming.raw);
	const representatives = representativeIndices(incomingServers);
	let secretFieldCount = 0;
	for (const index of representatives.values()) {
		const raw = incomingServers[index]?.raw;
		if (isRecord(raw)) {
			secretFieldCount += Object.keys(stripEntrySecrets(raw).secrets).length;
		}
	}
	const collisions: ServerCollision[] = [];
	const collided = new Set<string>();
	for (const incoming of incomingServers) {
		const label = incoming.report.label;
		if (incoming.skipped || label === undefined) {
			continue;
		}
		if (!currentLabels.has(label) || collided.has(label)) {
			continue;
		}
		collided.add(label);
		// hasOwn: labels like "toString" must not read Object.prototype.
		const currentBlob =
			storedSecrets !== undefined && Object.hasOwn(storedSecrets, label) ? storedSecrets[label] : undefined;
		const current = connectionFingerprint(acceptedEntry(currentServersRaw, label)?.entry, currentBlob ?? {});
		const imported = connectionFingerprint(acceptedEntry(incomingArray, label)?.entry, {});
		// A side neither parses is a side whose connection material is unknowable:
		// one parsed side against an unparseable one flags (the overwrite turns a
		// dead entry live or vice versa); two unparseable sides have no group to
		// churn either way.
		const connectionChanged = current === undefined && imported === undefined ? false : current !== imported;
		collisions.push({ label, connectionChanged });
	}

	return { settingsWrites, skippedKeys, incomingServers, collisions, secretFieldCount, currentServersRaw };
}

/** The user's answer to one collision prompt. */
export type CollisionDecision =
	| { readonly action: "overwrite" }
	| { readonly action: "skip" }
	| { readonly action: "rename"; readonly newLabel: string };

/**
 * Decisions keyed by colliding label. Every ImportPlan collision label must
 * carry one: the flow aborts the whole import on any dismissed prompt, so a
 * partial decision set never reaches resolveImportPlan.
 */
export type CollisionDecisions = Readonly<Record<string, CollisionDecision>>;

/** One label's SecretStorage writes, stripped out of its incoming entry. */
export interface SecretWrite {
	readonly label: string;
	/** The fields to store; blob fields the label already holds but this record omits are cleared as stale. */
	readonly secrets: StoredServerSecrets;
}

/** The exact writes the host flow applies (settings first, the servers array last). */
export interface ImportApplication {
	/** The plan's settingsWrites, passed through for the apply loop. */
	readonly settingsWrites: readonly SettingWrite[];
	/**
	 * The full servers array to write LAST, or undefined when the import
	 * touches no servers. Overwrites replace their entry IN PLACE (same array
	 * position, same label, so the sync engine's removal detector sees an
	 * edit, never a removal); new and renamed entries append; existing
	 * non-colliding entries are never mutated or reordered. Secrets are
	 * stripped out of every written entry into secretWrites.
	 */
	readonly serversValue: readonly unknown[] | undefined;
	/** Per-label SecretStorage writes, applied entry by entry before the servers write. */
	readonly secretWrites: readonly SecretWrite[];
	/** Every label the import writes (overwritten, renamed-to, appended); the pre-import snapshot records their previous blobs. */
	readonly touchedLabels: readonly string[];
	/** The summary notification's counts. */
	readonly counts: {
		/** New entries appended under their own label. */
		readonly imported: number;
		readonly overwritten: number;
		readonly renamed: number;
		/** Skip decisions plus the plan's unimportable entries. */
		readonly skipped: number;
	};
}

/** Fold the collision decisions into the plan; see ImportApplication for the merge invariants. */
export function resolveImportPlan(plan: ImportPlan, decisions: CollisionDecisions): ImportApplication {
	const base: unknown[] = Array.isArray(plan.currentServersRaw) ? [...plan.currentServersRaw] : [];
	const indexByLabel = new Map<string, number>();
	base.forEach((item, index) => {
		const label = declaredEntryLabel(item);
		if (label !== undefined && !indexByLabel.has(label)) {
			indexByLabel.set(label, index);
		}
	});

	const collisionLabels = new Set(plan.collisions.map((collision) => collision.label));
	const representatives = representativeIndices(plan.incomingServers);
	const appended: unknown[] = [];
	const secretWrites: SecretWrite[] = [];
	const touchedLabels: string[] = [];
	const touched = new Set<string>();
	// Labels this import has already placed (rename targets included): the
	// parser's first-entry-wins rule means a second entry under one could
	// never take effect, so it drops into the skipped count instead of
	// landing a shadowed duplicate.
	const landedLabels = new Set<string>();
	let imported = 0;
	let overwritten = 0;
	let renamed = 0;
	let skipped = 0;

	const land = (label: string, rawEntry: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
		const stripped = stripEntrySecrets(rawEntry);
		secretWrites.push({ label, secrets: stripped.secrets });
		if (!touched.has(label)) {
			touched.add(label);
			touchedLabels.push(label);
		}
		return stripped.entry;
	};

	for (const [index, incoming] of plan.incomingServers.entries()) {
		const label = incoming.report.label;
		if (incoming.skipped || label === undefined || !isRecord(incoming.raw)) {
			skipped += 1;
			continue;
		}
		// Only the label's representative lands (the entry the parser would
		// let take effect); shadowed same-label siblings drop rather than
		// landing dead weight or clobbering the representative's blob.
		if (representatives.get(label) !== index || landedLabels.has(label)) {
			skipped += 1;
			continue;
		}
		if (!collisionLabels.has(label)) {
			landedLabels.add(label);
			appended.push(land(label, incoming.raw));
			imported += 1;
			continue;
		}
		// hasOwn, not indexing: labels like "toString" are legal, and a plain
		// index read would hand back an Object.prototype method instead of the
		// missing-decision fallback. A missing decision is a contract violation
		// (the flow aborts on any dismissed prompt); the safe reading is the
		// one that writes nothing.
		const decision = Object.hasOwn(decisions, label) ? decisions[label] : undefined;
		if (decision === undefined || decision.action === "skip") {
			skipped += 1;
			continue;
		}
		if (decision.action === "overwrite") {
			landedLabels.add(label);
			const overwriteIndex = indexByLabel.get(label);
			const entry = land(label, incoming.raw);
			if (overwriteIndex !== undefined) {
				base[overwriteIndex] = entry;
			} else {
				appended.push(entry);
			}
			overwritten += 1;
			continue;
		}
		// The flow validates rename targets before they get here; a target it
		// should have rejected (blank, reserved, an existing or already-landed
		// label, a malformed decision object) would shadow another entry or
		// clobber its blob, so the safe reading is skip. The trim mirrors the
		// parser's label rule, keeping the SecretStorage key and the written
		// entry's label in agreement.
		const newLabel = typeof decision.newLabel === "string" ? decision.newLabel.trim() : "";
		if (
			newLabel.length === 0 ||
			isUnsafeRecordKey(newLabel) ||
			landedLabels.has(newLabel) ||
			indexByLabel.has(newLabel)
		) {
			skipped += 1;
			continue;
		}
		landedLabels.add(newLabel);
		appended.push(land(newLabel, { ...incoming.raw, label: newLabel }));
		renamed += 1;
	}

	const landed = imported + overwritten + renamed;
	return {
		settingsWrites: plan.settingsWrites,
		serversValue: landed > 0 ? [...base, ...appended] : undefined,
		secretWrites,
		touchedLabels,
		counts: { imported, overwritten, renamed, skipped },
	};
}

/**
 * The prefill for the rename input box: a variant of `label` that collides
 * with nothing in `takenLabels` (current, reserved, and this-import labels;
 * the caller assembles the set).
 */
export function suggestRenamedLabel(label: string, takenLabels: ReadonlySet<string>): string {
	const stem = `${label}-imported`;
	if (!takenLabels.has(stem)) {
		return stem;
	}
	for (let ordinal = 2; ; ordinal += 1) {
		const candidate = `${stem}-${ordinal}`;
		if (!takenLabels.has(candidate)) {
			return candidate;
		}
	}
}
