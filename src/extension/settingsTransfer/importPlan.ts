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

/**
 * One non-servers key the plan refuses, and why. The one reason is the scalar gate (acceptsScalar): a spec'd number
 * key whose value is outside its contract, a boolean key whose value is not a boolean, or usage.statusBar outside its
 * enum; the other structured keys pass through to their readers' existing leniency. A servers value that is not an
 * array cannot travel through incomingServers, so it lands here rather than dropping.
 */
export interface SkippedKey {
	readonly key: string;
	readonly reason: "wrong-type";
}

/**
 * One entry of the file's servers array under the import's one judgment. A kept entry is one the parser accepted,
 * whose auth text the secret surgery could move; its label is therefore usable and unique within the file. Neither
 * variant's entry text may cross the webview boundary or reach the log buffer; the preview surfaces render the
 * remarks beside it, never the entry itself.
 *
 * A kept entry is normalized through the settings-redesign restructure, so a pre-redesign flat export lands working
 * entries instead of waiting for the next activation's migration.
 */
export type IncomingServer =
	| {
			/** The parser accepted the entry and the secret surgery could move its auth text. */
			readonly kept: true;

			/** Usable and unique within the file; the collision and rename flows key on it. */
			readonly label: string;

			/** The entry before respellEntryUrls: normalized to the current settings shape, secret values stripped out. */
			readonly entry: Readonly<Record<string, unknown>>;

			/** The stripped secret values that will be stored: a value the request path could not send is already gone. */
			readonly secrets: StoredServerSecrets;

			/** The parser's verdict, from the same serverSettingReports pass the dashboard diagnostics run. */
			readonly report: ServerEntryReport;

			/** Lines on what will not take effect (ignored diagnostics, refused credentials, unknown keys); never a value. */
			readonly notes: readonly string[];
	  }
	| {
			/** The parser rejected the entry, or its auth text could not be moved. */
			readonly kept: false;

			/** The entry as the judgment saw it, restructured to the current shape; never shown, never logged. */
			readonly raw: unknown;

			/** The parser's verdict for the entry, as for a kept one. */
			readonly report: ServerEntryReport;

			/** The first line the entry failed on, naming the field and never a value. */
			readonly reason: string;
	  };

/** One line about one entry, as the preview and the completion notice state it: `subject text`. */
export interface EntryRemark {
	/** The quoted label, or `entry N` (1-based) when the entry has no usable one; the parser's lines predicate it. */
	readonly subject: string;

	/** The remark, naming fields and never values. */
	readonly text: string;
}

/**
 * One label collision between the file and the current setting's raw labels. `connectionChanged` is true when the
 * incoming entry changes connection-level fields (baseUrl or auth material) against the current entry; with
 * storedSecrets provided, the current side compares by EFFECTIVE secret material, so a secret merely moving between
 * inline and SecretStorage does not flag.
 */
export interface ServerCollision {
	readonly label: string;
	readonly connectionChanged: boolean;
}

/** Everything the import preview states and the collision prompts iterate; resolveImportPlan consumes it whole. */
export interface ImportPlan {
	/** Non-servers keys to write, in ALL_SETTING_KEYS order; the servers key travels through incomingServers instead. */
	readonly settingsWrites: readonly SettingWrite[];

	/** Keys refused as wrong-type: the scalar gate, or a servers value that is not an array; never written. */
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
	return incoming.report.label === undefined
		? `entry ${incoming.report.index + 1}`
		: labelSubject(incoming.report.label);
}

/**
 * The file's servers entries judged one by one, after the same restructure the activation migration applies,
 * index-stable. A pre-redesign flat export otherwise lands entries the parser reads as credential-less until the next
 * activation (its group syncs with the wrong credential), and the flat-vs-nested collision rule stays the migration's
 * one rule.
 */
function judgeIncomingServers(value: readonly unknown[]): IncomingServer[] {
	const restructured = restructureServers(value).value;
	const incoming: readonly unknown[] = Array.isArray(restructured) ? restructured : value;
	const reports = serverSettingReports(incoming);
	const accepted = new Map(acceptedEntries(incoming).map(({ index, entry }) => [index, entry]));
	return incoming.map((raw: unknown, index) => {
		const report = reports[index] ?? { index, problems: [], accepted: false };
		return judgeEntry(raw, report, accepted.get(index));
	});
}

/** The envelope's non-servers writes and refusals, and its servers entries judged. */
interface EnvelopeReading {
	readonly settingsWrites: SettingWrite[];
	readonly skippedKeys: SkippedKey[];
	readonly incomingServers: IncomingServer[];
}

/** Every known key the envelope carries: scalars into writes, wrong types into refusals, servers judged entry by entry. */
function readEnvelopeSettings(envelopeSettings: Readonly<Record<string, unknown>>): EnvelopeReading {
	const settingsWrites: SettingWrite[] = [];
	const skippedKeys: SkippedKey[] = [];
	const incomingServers: IncomingServer[] = [];
	for (const key of ALL_SETTING_KEYS) {
		if (!Object.hasOwn(envelopeSettings, key)) {
			continue;
		}
		const value = envelopeSettings[key];
		if (key === SERVERS_SETTING_KEY) {
			if (Array.isArray(value)) {
				incomingServers.push(...judgeIncomingServers(value));
			} else {
				skippedKeys.push({ key, reason: "wrong-type" });
			}
			continue;
		}
		if (acceptsScalar(key, value)) {
			settingsWrites.push({ key, value });
		} else {
			skippedKeys.push({ key, reason: "wrong-type" });
		}
	}
	return { settingsWrites, skippedKeys, incomingServers };
}

type KeptServer = IncomingServer & { readonly kept: true };

/**
 * One kept entry's collision with the current entry of its label. A side neither parses is a side whose connection
 * material is unknowable, so one parsed side against an unparseable one flags (the overwrite turns a dead entry live
 * or vice versa).
 */
function collisionFor(
	incoming: KeptServer,
	currentServersRaw: unknown,
	storedSecrets: Readonly<Record<string, StoredServerSecrets>> | undefined
): ServerCollision {
	// hasOwn: labels like "toString" must not read Object.prototype.
	const currentBlob =
		storedSecrets !== undefined && Object.hasOwn(storedSecrets, incoming.label)
			? storedSecrets[incoming.label]
			: undefined;
	const current = connectionFingerprint(acceptedEntry(currentServersRaw, incoming.label)?.entry, currentBlob ?? {});
	const imported = connectionFingerprint(acceptedEntry([incoming.entry], incoming.label)?.entry, incoming.secrets);
	const connectionChanged = current === undefined && imported === undefined ? false : current !== imported;
	return { label: incoming.label, connectionChanged };
}

/** The preview's remarks over the judged entries: the dropped reasons, the kept notes, collisions, and secret total. */
interface ServerRemarks {
	readonly dropped: EntryRemark[];
	readonly notes: EntryRemark[];
	readonly collisions: ServerCollision[];
	readonly secretFieldCount: number;
}

/** The judged entries sorted into the preview's remarks, each kept entry judged against the current entry of its label. */
function remarkServers(
	incomingServers: readonly IncomingServer[],
	currentServersRaw: unknown,
	storedSecrets: Readonly<Record<string, StoredServerSecrets>> | undefined
): ServerRemarks {
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
		if (currentLabels.has(incoming.label)) {
			collisions.push(collisionFor(incoming, currentServersRaw, storedSecrets));
		}
	}
	return { dropped, notes, collisions, secretFieldCount };
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
	const reading = readEnvelopeSettings(envelopeSettings);
	const remarks = remarkServers(reading.incomingServers, currentServersRaw, storedSecrets);
	return {
		settingsWrites: reading.settingsWrites,
		skippedKeys: reading.skippedKeys,
		incomingServers: reading.incomingServers,
		dropped: remarks.dropped,
		notes: remarks.notes,
		collisions: remarks.collisions,
		secretFieldCount: remarks.secretFieldCount,
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

/**
 * One label's SecretStorage writes, stripped out of its incoming entry. `owners` is derived from the written entry as
 * the parser reads it back, so it fails closed: fixing the entry re-pairs the secret deliberately.
 */
export interface SecretWrite {
	/** The label the entry lands under: a renamed entry's new label. */
	readonly label: string;

	/** The fields to store; blob fields the label already holds but this record omits are cleared as stale. */
	readonly secrets: StoredServerSecrets;

	/** Per stored field, the destination the imported entry pairs it with; the import IS the deliberate pairing. */
	readonly owners: StoredSecretOwners;
}

/**
 * The exact writes the host flow applies (settings first, the servers array last). Overwrites replace their entry IN
 * PLACE, so the sync engine's removal detector sees an edit rather than a removal, and existing non-colliding entries
 * are never mutated or reordered. A renamed entry's notes name the new label; a skipped entry's notes are not carried,
 * since there is nothing to re-enter.
 */
export interface ImportApplication {
	/** The plan's settingsWrites, passed through for the apply loop. */
	readonly settingsWrites: readonly SettingWrite[];

	/** The full servers array, written LAST, or undefined when no servers are touched; secrets stripped out. */
	readonly serversValue: readonly unknown[] | undefined;

	/** Per-label SecretStorage writes, applied entry by entry before the servers write. */
	readonly secretWrites: readonly SecretWrite[];

	/** Every label the import writes (overwritten, renamed-to, appended); the snapshot records their previous blobs. */
	readonly touchedLabels: readonly string[];

	/** The plan's dropped entries, passed through for the completion notice. */
	readonly dropped: readonly EntryRemark[];

	/** The landed entries' notes under the label each landed as; the plan's notes stay the preview's. */
	readonly notes: readonly EntryRemark[];

	/** The summary notification's counts. */
	readonly counts: {
		/** New entries appended under their own label. */
		readonly imported: number;

		/** Counts the overwrite decisions; each replaced the current entry in place. */
		readonly overwritten: number;

		/** Counts the rename decisions; each appended the entry under its new label. */
		readonly renamed: number;

		/** Skip decisions, plus a rename whose target the flow should have refused. */
		readonly skipped: number;
	};
}

/** Each label's first index in the current servers array: the entry the parser's first-entry-wins rule reads. */
function firstIndexByLabel(base: readonly unknown[]): Map<string, number> {
	const indexByLabel = new Map<string, number>();
	base.forEach((item, index) => {
		const label = declaredEntryLabel(item);
		if (label !== undefined && !indexByLabel.has(label)) {
			indexByLabel.set(label, index);
		}
	});
	return indexByLabel;
}

/**
 * What the import has placed so far: the writes it accumulates and the labels it must not place twice. Kept labels are
 * unique within the file, so only a rename target can repeat a landed one, and a second entry under it could never
 * take effect under the parser's first-entry-wins rule.
 */
interface Landing {
	readonly secretWrites: SecretWrite[];
	readonly touchedLabels: string[];
	readonly notes: EntryRemark[];
	readonly landedLabels: Set<string>;
}

/**
 * The entry as it lands under `label`, its secrets queued for SecretStorage. Reached only for a label the landing does
 * not hold yet, so the label is new to every list it joins. What lands is the entry in the one spelling the parser
 * reads (respellEntryUrls), never the file's; the ownership stamp targets that written entry as the parser reads it
 * back (the import IS the deliberate pairing).
 */
function landEntry(label: string, incoming: KeptServer, landing: Landing): unknown {
	const entry = incoming.label === label ? incoming.entry : { ...incoming.entry, label };
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
	landing.secretWrites.push({ label, secrets: incoming.secrets, owners });
	landing.landedLabels.add(label);
	landing.touchedLabels.push(label);
	landing.notes.push(...incoming.notes.map((text) => ({ subject: labelSubject(label), text })));
	return written;
}

/** Where one kept entry goes, named after the summary count it bumps; every kind but skipped carries its label. */
type Placement =
	| { readonly kind: "skipped" }
	| { readonly kind: "imported"; readonly label: string }
	| { readonly kind: "overwritten"; readonly label: string }
	| { readonly kind: "renamed"; readonly label: string };

/** What a placement is decided against: the collisions, the user's answers, and the labels already taken. */
interface PlacementContext {
	readonly collisionLabels: ReadonlySet<string>;
	readonly decisions: CollisionDecisions;
	readonly landedLabels: ReadonlySet<string>;
	readonly indexByLabel: ReadonlyMap<string, number>;
}

/**
 * One kept entry's placement. A missing decision is a contract violation whose safe reading writes nothing. A rename
 * target the flow should have rejected would shadow another entry or clobber its blob, so its safe reading is skip;
 * the trim mirrors the parser's label rule, keeping the SecretStorage key and the written entry's label in agreement.
 */
function placementOf(incoming: KeptServer, context: PlacementContext): Placement {
	const { label } = incoming;
	if (context.landedLabels.has(label)) {
		return { kind: "skipped" };
	}
	if (!context.collisionLabels.has(label)) {
		return { kind: "imported", label };
	}
	// hasOwn, not indexing: labels like "toString" are legal, and a plain index read would hand back an
	// Object.prototype method instead of the missing-decision fallback.
	const decision = Object.hasOwn(context.decisions, label) ? context.decisions[label] : undefined;
	if (decision === undefined || decision.action === "skip") {
		return { kind: "skipped" };
	}
	if (decision.action === "overwrite") {
		return { kind: "overwritten", label };
	}
	const newLabel = typeof decision.newLabel === "string" ? trimHttpWhitespace(decision.newLabel) : "";
	if (
		newLabel.length === 0 ||
		isUnsafeRecordKey(newLabel) ||
		context.landedLabels.has(newLabel) ||
		context.indexByLabel.has(newLabel)
	) {
		return { kind: "skipped" };
	}
	return { kind: "renamed", label: newLabel };
}

/** Fold the collision decisions into the plan; see ImportApplication for the merge invariants. */
export function resolveImportPlan(plan: ImportPlan, decisions: CollisionDecisions): ImportApplication {
	const base: unknown[] = Array.isArray(plan.currentServersRaw) ? [...plan.currentServersRaw] : [];
	const indexByLabel = firstIndexByLabel(base);
	const collisionLabels = new Set(plan.collisions.map((collision) => collision.label));
	const appended: unknown[] = [];
	const landing: Landing = { secretWrites: [], touchedLabels: [], notes: [], landedLabels: new Set() };
	const counts = { imported: 0, overwritten: 0, renamed: 0, skipped: 0 };

	for (const incoming of plan.incomingServers) {
		if (!incoming.kept) {
			continue;
		}
		const context = { collisionLabels, decisions, landedLabels: landing.landedLabels, indexByLabel };
		const placement = placementOf(incoming, context);
		counts[placement.kind] += 1;
		if (placement.kind === "skipped") {
			continue;
		}
		const landed = landEntry(placement.label, incoming, landing);
		const overwriteIndex = placement.kind === "overwritten" ? indexByLabel.get(placement.label) : undefined;
		if (overwriteIndex === undefined) {
			appended.push(landed);
		} else {
			base[overwriteIndex] = landed;
		}
	}

	const landed = counts.imported + counts.overwritten + counts.renamed;
	return {
		settingsWrites: plan.settingsWrites,
		serversValue: landed > 0 ? [...base, ...appended] : undefined,
		secretWrites: landing.secretWrites,
		touchedLabels: landing.touchedLabels,
		dropped: plan.dropped,
		notes: landing.notes,
		counts,
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
