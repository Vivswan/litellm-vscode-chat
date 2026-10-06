/**
 * Import planning in two pure steps: planSettingsImport reduces a parsed envelope plus the current servers setting to
 * an ImportPlan, and resolveImportPlan folds the user's collision decisions into an ImportApplication. No direct vscode
 * usage; the impurities are the serverSync setting parser and the group credential narrowing, whose module graphs
 * reach vscode at load time in the host - which is why this core sits in extension/ rather than dashboard/.
 *
 *   the split -> keeps every prompt between the two steps fakeable
 */

import * as l10n from "@vscode/l10n";
import type { RejectedCredentialField } from "../../provider/catalog/groupModels";
import {
	narrowGroupCredentials,
	refusedCredentialFields,
	rejectedCredentialKinds,
} from "../../provider/catalog/groupModels";
import {
	ALL_SETTING_KEYS,
	acceptsNumberSetting,
	BOOLEAN_SETTING_SPECS,
	type KeyedSettingId,
	NUMBER_SETTING_SPECS,
	type NumberSettingId,
	SERVERS_SETTING_KEY,
	USAGE_STATUS_BAR_MODES,
	USAGE_STATUS_BAR_SETTING_KEY,
} from "../../shared/config/settingSpec";
import type { SecretFieldId, SecretOwner } from "../../shared/serverEntry";
import { OPTIONAL_ENTRY_FIELDS, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { trimHttpWhitespace } from "../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../shared/util/json";
import { restructureServers } from "../migrations/settingsRedesign/entries";
import { buildGroupArgs } from "../servers/serverSync/engine";
import type { StoredSecretOwners, StoredServerSecrets } from "../servers/serverSync/secrets";
import { secretDestination } from "../servers/serverSync/secrets";
import type { DeclaredServer, ServerEntryReport } from "../servers/serverSync/setting";
import {
	acceptedEntry,
	declaredEntryLabel,
	rawDeclaredLabels,
	refusedUrlField,
	respellEntryUrls,
	serverSettingReports,
} from "../servers/serverSync/setting";
import { stripEntrySecrets } from "./secretSurgery";

/** One non-servers key the plan writes to the user scope. */
export interface SettingWrite {
	readonly key: KeyedSettingId;
	readonly value: unknown;
}

/** One non-servers key the plan refuses, and why. */
export interface SkippedKey {
	readonly key: string;
	/**
	 * The scalar gate (acceptsScalar): a spec'd number key whose value is outside its contract, a boolean key whose value
	 * is not a boolean, or usage.statusBar outside its enum. The other structured keys pass through to their readers'
	 * existing leniency.
	 *
	 *   a servers value that is not an array cannot travel through incomingServers
	 *     -> it lands here rather than dropping
	 */
	readonly reason: "wrong-type";
}

/** One entry of the file's servers array, with its acceptance verdict for the preview. */
export interface IncomingServer {
	/**
	 * The entry as the import would write it: the file's entry normalized to the current settings shape (the
	 * settings-redesign restructure, so a pre-redesign flat export lands working entries instead of waiting for the
	 * next activation's migration), inline secret values still in place. It must never cross the webview boundary or
	 * reach the log buffer; the preview surfaces render the report beside it, not the entry itself.
	 */
	readonly raw: unknown;
	/** The entry's verdict, from the same serverSettingReports pass the dashboard diagnostics run. */
	readonly report: ServerEntryReport;
	/**
	 * True when the entry cannot import at all: no usable label, a reserved one (no SecretStorage key is possible for
	 * either), or an auth shape the secret surgery cannot certify - landing that entry would write presumed credential
	 * text into the settings file, breaking the secrets-go-to-secure-storage promise.
	 */
	readonly skipped: boolean;
}

/** One label collision between the file and the current setting's raw labels. */
export interface ServerCollision {
	readonly label: string;
	/**
	 * With storedSecrets provided, the current side compares by EFFECTIVE secret material, so a secret merely moving
	 * between inline and SecretStorage does not flag.
	 *
	 *   the incoming entry changes connection-level fields (baseUrl or auth material) against the current entry
	 *     -> True
	 */
	readonly connectionChanged: boolean;
}

/** Everything the import preview states and the collision prompts iterate; resolveImportPlan consumes it whole. */
export interface ImportPlan {
	/**
	 * Non-servers keys to write, in ALL_SETTING_KEYS order; the servers key travels through incomingServers instead.
	 */
	readonly settingsWrites: readonly SettingWrite[];
	readonly skippedKeys: readonly SkippedKey[];
	/** The file's servers array, one verdict per entry; empty when the file carries no servers key. */
	readonly incomingServers: readonly IncomingServer[];
	/** Importable incoming labels already present in the current setting (vs rawDeclaredLabels), in file order. */
	readonly collisions: readonly ServerCollision[];
	/**
	 * Inline secret values across the entries that would land (one representative per label; see resolveImportPlan).
	 */
	readonly secretFieldCount: number;
	/** The current servers setting's raw user-scope value, carried verbatim for resolveImportPlan's merge. */
	readonly currentServersRaw: unknown;
}

/**
 * Whether the key's scalar spec takes the incoming value as written: a number by its whole contract, a boolean by
 * type, the status-bar mode by its enum. Structured keys always pass, to their readers' own leniency.
 */
function acceptsScalar(key: string, value: unknown): boolean {
	if (Object.hasOwn(NUMBER_SETTING_SPECS, key)) {
		return acceptsNumberSetting(key as NumberSettingId, value);
	}
	if (Object.hasOwn(BOOLEAN_SETTING_SPECS, key)) {
		return typeof value === "boolean";
	}
	if (key === USAGE_STATUS_BAR_SETTING_KEY) {
		return typeof value === "string" && (USAGE_STATUS_BAR_MODES as readonly string[]).includes(value);
	}
	return true;
}

/**
 * One parsed entry's connection-level material: the field set buildGroupArgs emits, with the entry's inline secret
 * values winning over the supplied blob. name, vendor, and label are omitted because a collision's two sides share the
 * label; what remains is baseUrl plus the flat credential fields, in the descriptor order the fingerprint freezes.
 */
function connectionFingerprint(entry: DeclaredServer | undefined, stored: StoredServerSecrets): string | undefined {
	if (entry === undefined) {
		return undefined;
	}
	const fields: Record<string, string> = { baseUrl: entry.baseUrl };
	for (const field of OPTIONAL_ENTRY_FIELDS) {
		// The parsed entry's secret fields ARE its inline values, so this is exactly buildGroupArgs's
		// inline-over-stored resolution.
		const value = field.secret ? (entry[field.id] ?? stored[field.id]) : entry[field.id];
		if (value !== undefined) {
			fields[field.id] = value;
		}
	}
	return JSON.stringify(fields);
}

/**
 * The labels whose connection-level material differs between two raw servers values, each side resolved against its
 * own pre-fetched blobs.
 *
 *   The undo flow -> feeds it the pre-undo state against the snapshot's
 *   Same one-side-unparseable convention as the import collisions -> one parsed side against an unparseable one
 *       flags, two unparseable sides do not
 */
export function connectionChangedLabels(
	fromRaw: unknown,
	fromBlobs: Readonly<Record<string, StoredServerSecrets>>,
	toRaw: unknown,
	toBlobs: Readonly<Record<string, StoredServerSecrets>>
): string[] {
	const blobOf = (blobs: Readonly<Record<string, StoredServerSecrets>>, label: string): StoredServerSecrets =>
		Object.hasOwn(blobs, label) ? (blobs[label] ?? {}) : {};
	const changed: string[] = [];
	for (const label of new Set([...rawDeclaredLabels(fromRaw), ...rawDeclaredLabels(toRaw)])) {
		const from = connectionFingerprint(acceptedEntry(fromRaw, label)?.entry, blobOf(fromBlobs, label));
		const to = connectionFingerprint(acceptedEntry(toRaw, label)?.entry, blobOf(toBlobs, label));
		if (!(from === undefined && to === undefined) && from !== to) {
			changed.push(label);
		}
	}
	return changed;
}

/**
 * When no element claims, the first labeled element stands in, so a lone fragment still imports.
 *
 *   the parser's claim rule -> the first element with a usable label AND baseUrl claims the label; a baseUrl-less
 *       fragment claims nothing
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

function refusedSecretProblem(field: RejectedCredentialField): string {
	return l10n.t(
		"the {0} cannot be sent as an HTTP header; it is not imported, so enter it again afterwards",
		rejectedCredentialKinds([field]).display
	);
}

/**
 * The import's one reading of an entry's secrets, judged by the same narrowing every request path narrows by: a
 * configured key the narrowing rejects is refused by field and never stored, and the entry still lands without it. An
 * entry the parser does not accept has no carriers to judge a virtual key by, so its secrets are narrowed alone: the
 * API key is still judged, the virtual key value reads as dormant.
 */
function importableSecrets(
	raw: Readonly<Record<string, unknown>>,
	label: string | undefined
): {
	readonly entry: Readonly<Record<string, unknown>>;
	readonly secrets: StoredServerSecrets;
	readonly refused: readonly RejectedCredentialField[];
	readonly unsanitizable: boolean;
} {
	const stripped = stripEntrySecrets(raw);
	const entry = label === undefined ? undefined : acceptedEntry([stripped.entry], label)?.entry;
	const fields = entry === undefined ? stripped.secrets : buildGroupArgs(entry, stripped.secrets);
	const refused = refusedCredentialFields(narrowGroupCredentials(fields).rejections) ?? [];
	const secrets: { -readonly [K in SecretFieldId]?: string } = { ...stripped.secrets };
	for (const field of refused) {
		delete secrets[field];
	}
	return { entry: stripped.entry, secrets, refused, unsanitizable: stripped.unsanitizable };
}

/**
 * `storedSecrets` is the host's pre-fetched SecretStorage blobs by label; when provided, each collision's
 * connectionChanged compares the current side's effective secret material instead of inline text alone. Pure and
 * synchronous either way; the incoming side never has a blob.
 *
 *   Absent -> resolution is inline-only
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
			// Normalize to the current settings shape FIRST - the same restructure
			// the activation migration applies, index-stable. A pre-redesign flat
			// export otherwise lands entries the parser reads as credential-less
			// until the next activation (its group syncs with the wrong credential), and
			// the flat-vs-nested collision rule stays the migration's one rule.
			const restructured = restructureServers(value).value;
			const incoming: readonly unknown[] = Array.isArray(restructured) ? restructured : value;
			const reports = serverSettingReports(incoming);
			incoming.forEach((raw: unknown, index) => {
				const report = reports[index] ?? { index, problems: [], accepted: false };
				const secrets = isRecord(raw) ? importableSecrets(raw, report.label) : undefined;
				// An uncertifiable shape must not land in the settings file (its text is presumed to be a credential);
				// the entry skips with the reason beside the parser's own problem lines.
				if (secrets?.unsanitizable) {
					incomingServers.push({
						raw,
						report: {
							...report,
							accepted: false,
							problems: [...report.problems, "carries credential text the import cannot move into secret storage"],
						},
						skipped: true,
					});
					return;
				}
				// An entry the parser refuses for a URL is never written: landing it could overwrite a working entry under
				// the label with one the parser rejects.
				const refusedUrl = isRecord(raw) ? refusedUrlField(raw) : undefined;
				if (refusedUrl !== undefined) {
					incomingServers.push({
						raw,
						report: {
							...report,
							accepted: false,
							problems: [...report.problems, `is not imported: its ${refusedUrl} is not a URL with a host`],
						},
						skipped: true,
					});
					return;
				}
				const problems = [...report.problems, ...(secrets?.refused ?? []).map(refusedSecretProblem)];
				incomingServers.push({ raw, report: { ...report, problems }, skipped: report.label === undefined });
			});
			continue;
		}
		if (acceptsScalar(key, value)) {
			settingsWrites.push({ key, value });
		} else {
			skippedKeys.push({ key, reason: "wrong-type" });
		}
	}

	const currentLabels = rawDeclaredLabels(currentServersRaw);
	// Skipped entries stay out of the fingerprint parse: a skipped first element under a label would otherwise shadow
	// the valid same-label element resolution actually lands, misreading its connection fingerprint.
	const incomingArray = incomingServers.filter((incoming) => !incoming.skipped).map((incoming) => incoming.raw);
	const representatives = representativeIndices(incomingServers);
	let secretFieldCount = 0;
	for (const index of representatives.values()) {
		const incoming = incomingServers[index];
		if (incoming !== undefined && isRecord(incoming.raw)) {
			secretFieldCount += Object.keys(importableSecrets(incoming.raw, incoming.report.label).secrets).length;
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
		//   A side neither parses is a side whose connection material is unknowable -> one parsed side against an
		//       unparseable one flags (the overwrite turns a dead entry live or vice versa)
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
 * Decisions keyed by colliding label. Every ImportPlan collision label must carry one: the flow aborts the whole import
 * on any dismissed prompt, so a partial decision set never reaches resolveImportPlan.
 */
export type CollisionDecisions = Readonly<Record<string, CollisionDecision>>;

/** One label's SecretStorage writes, stripped out of its incoming entry. */
export interface SecretWrite {
	readonly label: string;
	/** The fields to store; blob fields the label already holds but this record omits are cleared as stale. */
	readonly secrets: StoredServerSecrets;
	/**
	 * The ownership stamp per stored field: the destination the imported entry pairs it with (the import IS the
	 * deliberate pairing).
	 *
	 *   Derived from the written entry as the parser reads it back -> fail closed, so fixing the entry re-pairs the
	 *                                                                 secret deliberately
	 */
	readonly owners: StoredSecretOwners;
}

/** The exact writes the host flow applies (settings first, the servers array last). */
export interface ImportApplication {
	/** The plan's settingsWrites, passed through for the apply loop. */
	readonly settingsWrites: readonly SettingWrite[];
	/**
	 * The full servers array to write LAST, or undefined when the import touches no servers. Secrets are stripped out
	 * of every written entry.
	 *
	 *   Overwrites replace their entry IN PLACE -> the sync engine's removal detector sees an edit rather than a
	 *                                              removal
	 *   existing non-colliding entries          -> are never mutated or reordered
	 */
	readonly serversValue: readonly unknown[] | undefined;
	/** Per-label SecretStorage writes, applied entry by entry before the servers write. */
	readonly secretWrites: readonly SecretWrite[];
	/**
	 * Every label the import writes (overwritten, renamed-to, appended); the pre-import snapshot records their previous
	 * blobs.
	 */
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
	// Labels this import has already placed (rename targets included): the parser's first-entry-wins rule means a
	// second entry under one could never take effect, so it drops into the skipped count.
	const landedLabels = new Set<string>();
	let imported = 0;
	let overwritten = 0;
	let renamed = 0;
	let skipped = 0;

	const land = (label: string, rawEntry: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
		const stripped = importableSecrets(rawEntry, label);
		// The stamp target is the entry as it will be written and parsed back;
		// see SecretWrite.owners for the fail-closed fallback.
		const parsed = acceptedEntry([stripped.entry], label)?.entry;
		// What lands is the entry in the one spelling the parser reads (respellEntryUrls), never the file's.
		const written = parsed === undefined ? stripped.entry : respellEntryUrls(stripped.entry).record;
		const target = parsed ?? {
			baseUrl: typeof rawEntry.baseUrl === "string" ? trimHttpWhitespace(rawEntry.baseUrl) : "",
		};
		const owners: { -readonly [K in SecretFieldId]?: SecretOwner } = {};
		for (const field of SECRET_FIELD_IDS) {
			if (stripped.secrets[field] !== undefined) {
				owners[field] = secretDestination(target, field);
			}
		}
		secretWrites.push({ label, secrets: stripped.secrets, owners });
		if (!touched.has(label)) {
			touched.add(label);
			touchedLabels.push(label);
		}
		return written;
	};

	for (const [index, incoming] of plan.incomingServers.entries()) {
		const label = incoming.report.label;
		if (incoming.skipped || label === undefined || !isRecord(incoming.raw)) {
			skipped += 1;
			continue;
		}
		//   shadowed same-label siblings drop rather than landing dead weight or clobbering the representative's blob
		//     -> Only the label's representative lands
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
		// missing-decision fallback. A missing decision is a contract violation;
		// the safe reading is the one that writes nothing.
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
		// The rename targets the flow already validated; a target it should have rejected would shadow another entry or
		// clobber its blob, so the safe reading is skip. The trim mirrors the parser's label rule, keeping the
		// SecretStorage key and the written entry's label in agreement.
		const newLabel = typeof decision.newLabel === "string" ? trimHttpWhitespace(decision.newLabel) : "";
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

/** The prefill for the rename input box: a variant of `label` that collides with nothing in `takenLabels`. */
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
