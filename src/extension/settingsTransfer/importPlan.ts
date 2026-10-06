/**
 * Import planning in two pure steps: planSettingsImport reduces a parsed envelope plus the current servers setting to
 * an ImportPlan, and resolveImportPlan folds the user's collision decisions into an ImportApplication. No direct vscode
 * usage; the impurities are the serverSync setting parser and the group credential narrowing, whose module graphs
 * reach vscode at load time in the host - which is why this core sits in extension/ rather than dashboard/.
 *
 *   the split -> keeps every prompt between the two steps fakeable
 *
 * A file is something the import only reads, so nothing in it is repaired by guessing: judgeEntry keeps an entry the
 * servers parser accepts (the one definition of a valid entry the dashboard and the sync engine share) and drops the
 * rest with the parser's first line as the reason. The one spelling respellEntryUrls settles is a spelling, not a
 * repair.
 */

import * as l10n from "@vscode/l10n";
import { narrowGroupCredentials, refusedCredentialFields } from "../../provider/catalog/groupModels";
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
import { rejectedCredentialKinds } from "../../shared/failureCause";
import type { RejectedCredentialField, SecretFieldId, SecretOwner } from "../../shared/serverEntry";
import { OPTIONAL_ENTRY_FIELDS, SECRET_FIELD_IDS, SERVER_ENTRY_KEYS } from "../../shared/serverEntry";
import { trimHttpWhitespace } from "../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../shared/util/json";
import { restructureServers } from "../migrations/settingsRedesign/entries";
import { buildGroupArgs } from "../servers/serverSync/engine";
import type { StoredSecretOwners, StoredServerSecrets } from "../servers/serverSync/secrets";
import { secretDestination } from "../servers/serverSync/secrets";
import type { DeclaredServer, ServerEntryReport } from "../servers/serverSync/setting";
import {
	acceptedEntries,
	acceptedEntry,
	declaredEntryLabel,
	rawDeclaredLabels,
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

/**
 * One entry of the file's servers array under the import's one judgment. A kept entry is one the parser accepted,
 * whose auth text the secret surgery could move; its label is therefore usable and unique within the file. Neither
 * variant's entry text may cross the webview boundary or reach the log buffer; the preview surfaces render the
 * remarks beside it, never the entry itself.
 */
export type IncomingServer =
	| {
			readonly kept: true;
			readonly label: string;
			/**
			 * The entry as it lands before respellEntryUrls: the file's entry normalized to the current settings shape (the
			 * settings-redesign restructure, so a pre-redesign flat export lands working entries instead of waiting for the
			 * next activation's migration), secret values stripped out.
			 */
			readonly entry: Readonly<Record<string, unknown>>;
			/** The stripped secret values that will be stored: a value the request path could not send is already gone. */
			readonly secrets: StoredServerSecrets;
			/** The parser's verdict, from the same serverSettingReports pass the dashboard diagnostics run. */
			readonly report: ServerEntryReport;
			/**
			 * What the entry carries that will not take effect, each line naming a field and never a value: the parser's
			 * ignored diagnostics, a credential the request path would refuse, a key outside the entry vocabulary.
			 */
			readonly notes: readonly string[];
	  }
	| {
			readonly kept: false;
			readonly raw: unknown;
			readonly report: ServerEntryReport;
			/** The first line the entry failed on, naming the field and never a value. */
			readonly reason: string;
	  };

/** One line about one entry, as the preview and the completion notice state it: `subject text`. */
export interface EntryRemark {
	/** The quoted label, or `entry N` (1-based) when the entry has no usable one; the parser's lines predicate it. */
	readonly subject: string;
	readonly text: string;
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
	/** The dropped entries' first reasons, in file order. */
	readonly dropped: readonly EntryRemark[];
	/** Every note on a kept entry, in file order. */
	readonly notes: readonly EntryRemark[];
	/** Kept incoming labels already present in the current setting (vs rawDeclaredLabels), in file order. */
	readonly collisions: readonly ServerCollision[];
	/** Inline secret values across the kept entries that will move into secret storage. */
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

function refusedSecretProblem(field: RejectedCredentialField): string {
	return l10n.t(
		"has {0} text that cannot be sent as an HTTP header; it is not imported, so enter it again afterwards",
		rejectedCredentialKinds([field]).display
	);
}

/**
 * The import's one judgment of a file entry. `parsed` is the parser's accepted reading of this element within the
 * whole file array (so a repeated label is the parser's rejection, not a second rule here); undefined means rejected,
 * and the parser's first line is the reason. An accepted entry still drops when text the secret surgery cannot reach
 * may hide a credential: landing it would write presumed credential text into the settings file. A kept entry's
 * secrets are judged by the same narrowing every request path narrows by, so a configured key the narrowing rejects
 * is never stored and the entry lands without it, noted by field.
 */
function judgeEntry(raw: unknown, report: ServerEntryReport, parsed: DeclaredServer | undefined): IncomingServer {
	if (parsed === undefined || !isRecord(raw)) {
		return { kept: false, raw, report, reason: report.problems[0] ?? "is not a server entry" };
	}
	const stripped = stripEntrySecrets(raw);
	if (stripped.unsanitizable) {
		return { kept: false, raw, report, reason: "carries credential text the import cannot move into secret storage" };
	}
	const refused =
		refusedCredentialFields(narrowGroupCredentials(buildGroupArgs(parsed, stripped.secrets)).rejections) ?? [];
	const secrets: { -readonly [K in SecretFieldId]?: string } = { ...stripped.secrets };
	for (const field of refused) {
		delete secrets[field];
	}
	const unknownKeys = Object.keys(raw).filter((key) => !SERVER_ENTRY_KEYS.includes(key));
	return {
		kept: true,
		label: parsed.label,
		entry: stripped.entry,
		secrets,
		report,
		notes: [
			...report.problems,
			...refused.map(refusedSecretProblem),
			...unknownKeys.map((key) => l10n.t('has an unknown key "{0}", ignored', key)),
		],
	};
}

function labelSubject(label: string): string {
	return `"${label}"`;
}

function remarkSubject(incoming: IncomingServer): string {
	if (incoming.kept) {
		return labelSubject(incoming.label);
	}
	return incoming.report.label !== undefined
		? labelSubject(incoming.report.label)
		: `entry ${incoming.report.index + 1}`;
}

/**
 * `storedSecrets` is the host's pre-fetched SecretStorage blobs by label; when provided, each collision's
 * connectionChanged compares the current side's effective secret material instead of inline text alone. Pure and
 * synchronous either way; the incoming side's material is the kept entry's own stripped secrets.
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
			const accepted = new Map(acceptedEntries(incoming).map(({ index, entry }) => [index, entry]));
			incoming.forEach((raw: unknown, index) => {
				const report = reports[index] ?? { index, problems: [], accepted: false };
				incomingServers.push(judgeEntry(raw, report, accepted.get(index)));
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
	const dropped: EntryRemark[] = [];
	const notes: EntryRemark[] = [];
	const collisions: ServerCollision[] = [];
	let secretFieldCount = 0;
	for (const incoming of incomingServers) {
		if (!incoming.kept) {
			dropped.push({ subject: remarkSubject(incoming), text: incoming.reason });
			continue;
		}
		const subject = remarkSubject(incoming);
		notes.push(...incoming.notes.map((text) => ({ subject, text })));
		secretFieldCount += Object.keys(incoming.secrets).length;
		if (!currentLabels.has(incoming.label)) {
			continue;
		}
		// hasOwn: labels like "toString" must not read Object.prototype.
		const currentBlob =
			storedSecrets !== undefined && Object.hasOwn(storedSecrets, incoming.label)
				? storedSecrets[incoming.label]
				: undefined;
		const current = connectionFingerprint(acceptedEntry(currentServersRaw, incoming.label)?.entry, currentBlob ?? {});
		const imported = connectionFingerprint(acceptedEntry([incoming.entry], incoming.label)?.entry, incoming.secrets);
		//   A side neither parses is a side whose connection material is unknowable -> one parsed side against an
		//       unparseable one flags (the overwrite turns a dead entry live or vice versa)
		const connectionChanged = current === undefined && imported === undefined ? false : current !== imported;
		collisions.push({ label: incoming.label, connectionChanged });
	}

	return {
		settingsWrites,
		skippedKeys,
		incomingServers,
		dropped,
		notes,
		collisions,
		secretFieldCount,
		currentServersRaw,
	};
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
	/** The plan's dropped entries, passed through for the completion notice. */
	readonly dropped: readonly EntryRemark[];
	/**
	 * The notes of the entries that landed, under the label each landed as: a renamed entry's notes name the new
	 * label, a skipped entry's notes are not carried (nothing to re-enter). The plan's notes stay the preview's.
	 */
	readonly notes: readonly EntryRemark[];
	/** The summary notification's counts. */
	readonly counts: {
		/** New entries appended under their own label. */
		readonly imported: number;
		readonly overwritten: number;
		readonly renamed: number;
		/** Skip decisions, plus a rename whose target the flow should have refused. */
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
	const appended: unknown[] = [];
	const secretWrites: SecretWrite[] = [];
	const touchedLabels: string[] = [];
	const notes: EntryRemark[] = [];
	// Labels this import has already placed: kept labels are unique within the file, so only a rename target can
	// repeat one, and a second entry under it could never take effect under the parser's first-entry-wins rule.
	const landedLabels = new Set<string>();
	let imported = 0;
	let overwritten = 0;
	let renamed = 0;
	let skipped = 0;

	// Reached only for a label landedLabels does not hold yet, so the label is new to every list it joins.
	const land = (label: string, incoming: IncomingServer & { readonly kept: true }): unknown => {
		const entry = incoming.label === label ? incoming.entry : { ...incoming.entry, label };
		// What lands is the entry in the one spelling the parser reads (respellEntryUrls), never the file's; the
		// ownership stamp targets that written entry as the parser reads it back (the import IS the deliberate pairing).
		const written = respellEntryUrls(entry).record;
		const target = acceptedEntry([written], label)?.entry;
		if (target === undefined) {
			throw new Error("settings import: a kept entry stopped parsing at landing");
		}
		const owners: { -readonly [K in SecretFieldId]?: SecretOwner } = {};
		for (const field of SECRET_FIELD_IDS) {
			if (incoming.secrets[field] !== undefined) {
				owners[field] = secretDestination(target, field);
			}
		}
		secretWrites.push({ label, secrets: incoming.secrets, owners });
		landedLabels.add(label);
		touchedLabels.push(label);
		notes.push(...incoming.notes.map((text) => ({ subject: labelSubject(label), text })));
		return written;
	};

	for (const incoming of plan.incomingServers) {
		if (!incoming.kept) {
			continue;
		}
		const { label } = incoming;
		if (landedLabels.has(label)) {
			skipped += 1;
			continue;
		}
		if (!collisionLabels.has(label)) {
			appended.push(land(label, incoming));
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
			const overwriteIndex = indexByLabel.get(label);
			const landed = land(label, incoming);
			if (overwriteIndex !== undefined) {
				base[overwriteIndex] = landed;
			} else {
				appended.push(landed);
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
		appended.push(land(newLabel, incoming));
		renamed += 1;
	}

	const landed = imported + overwritten + renamed;
	return {
		settingsWrites: plan.settingsWrites,
		serversValue: landed > 0 ? [...base, ...appended] : undefined,
		secretWrites,
		touchedLabels,
		dropped: plan.dropped,
		notes,
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
