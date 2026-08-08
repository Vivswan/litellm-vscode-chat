/**
 * The composed settings-redesign pipeline (tracker "Migrations", steps 1-7)
 * as one PURE transformation: an old-world snapshot in, an ordered write
 * plan out. The steps compose in memory - entry restructure first (so scoped
 * keys, declares, and the global headers have their new-shaped destinations),
 * then the record renames with their key rewrites and scoped moves, the
 * global headers copy, the default* trio merge, and the scalar renames last.
 *
 * Idempotency is state detection throughout: every step keys on its own
 * legacy state (an old setting id holding a value, a flat field on an entry)
 * and the plan deletes that state after writing the new one, so a rerun
 * finds nothing to do. Every value write precedes every deletion, and the
 * sync-race rule (a new name already holding a value keeps it and the old
 * key just drops) doubles as crash recovery for the window in between.
 *
 * The plan rewrites the User (Global) layer only. Old names at workspace
 * scope are counted in the log and left untouched; the `servers` setting is
 * machine-scoped, so its restructure has no workspace side. Secrets and sync
 * state are untouched by ruling: SecretStorage keys and blob field ids stay
 * as they are (the stored values keep working under the new entry shape),
 * and provider-group fingerprints stay valid because the group args of a
 * migrated entry are byte-identical.
 */

import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../../shared/util/json";
import {
	entryCanReceiveHeaders,
	entryCanReceiveRecordKeys,
	restructureServers,
	scopedMoveTargets,
	withEntryDeclares,
	withEntryHeaders,
	withEntryRecordAdditions,
} from "./entries";
import {
	LEGACY_HEADERS_ID,
	LEGACY_MODEL_CAPABILITIES_ID,
	LEGACY_MODEL_PARAMETERS_ID,
	LEGACY_SCALAR_RENAMES,
	LEGACY_SETTING_IDS,
	NEW_MODEL_CAPABILITIES_ID,
	NEW_MODEL_PARAMETERS_ID,
	SERVERS_ID,
} from "./legacyIds";
import type { RecordKind } from "./records";
import { transformGlobalRecord } from "./records";
import { mergeTokenDefaults } from "./tokenDefaults";
import type { RedesignPlan, SettingsSnapshot, SettingWrite } from "./types";

/** Count-noun helper: "1 entry" / "3 entries" stays English (log lines feed public issue reports). */
function entriesNoun(count: number): string {
	return count === 1 ? "entry" : "entries";
}

export function planSettingsRedesign(snapshot: SettingsSnapshot): RedesignPlan {
	const globalOf = (id: string): unknown => snapshot[id]?.globalValue;
	const logLines: string[] = [];
	const valueWrites: SettingWrite[] = [];
	const deletions: string[] = [];

	let renamedSettings = 0;
	let keptNewNames = 0;
	let movedScoped = 0;
	let inertScoped = 0;

	// --- Step 2 (+ the entry side of steps 4 and 7): restructure the entries.
	const rawServers = globalOf(SERVERS_ID);
	const restructured = restructureServers(rawServers);
	let serversValue = restructured.value;
	const counts = restructured.counts;
	// Acceptance over the restructured value; indices are stable (the
	// restructure maps in place), so targets stay valid while additions land.
	const targets = scopedMoveTargets(serversValue);

	const entryAt = (index: number): unknown => (Array.isArray(serversValue) ? serversValue[index] : undefined);
	const updateEntry = (index: number, update: (entry: Record<string, unknown>) => Record<string, unknown>): void => {
		if (!Array.isArray(serversValue)) {
			return;
		}
		const entry = serversValue[index];
		if (!isRecord(entry)) {
			return;
		}
		const next = update(entry);
		if (next !== entry) {
			const copy = [...serversValue];
			copy[index] = next;
			serversValue = copy;
		}
	};

	// --- Steps 1, 4, 5, and the global side of 7: the record renames.
	const processRecord = (oldId: string, newId: string, kind: RecordKind): { value: unknown } => {
		const oldValue = globalOf(oldId);
		const newValue = globalOf(newId);
		if (oldValue === undefined) {
			return { value: newValue };
		}
		if (newValue !== undefined) {
			// The sync-race rule, which is also the crash-recovery rule: the new
			// name already holds a value (Settings Sync delivered it from an
			// upgraded machine, or this machine's earlier run wrote it and
			// crashed before the deletion) - keep it, drop the old key.
			deletions.push(oldId);
			keptNewNames += 1;
			return { value: newValue };
		}
		const receivable = targets.filter((target) => entryCanReceiveRecordKeys(entryAt(target.entryIndex), kind));
		const transform = transformGlobalRecord(oldValue, kind, receivable);
		counts.starredKeys += transform.starredKeys;
		counts.droppedAliasKeys += transform.droppedAliasKeys;
		counts.strippedInertDeclares += transform.strippedInertDeclares;
		movedScoped += transform.movedScopedKeys;
		inertScoped += transform.inertScopedKeys;
		for (const [index, additions] of transform.entryAdditions) {
			updateEntry(index, (entry) => withEntryRecordAdditions(entry, kind, additions).entry);
		}
		for (const [index, ids] of transform.entryDeclares) {
			counts.movedDeclares += ids.length;
			updateEntry(index, (entry) => withEntryDeclares(entry, ids).entry);
		}
		valueWrites.push({ section: newId, value: transform.value });
		deletions.push(oldId);
		renamedSettings += 1;
		return { value: transform.value };
	};

	processRecord(LEGACY_MODEL_PARAMETERS_ID, NEW_MODEL_PARAMETERS_ID, "parameters");
	const capabilitiesState = processRecord(LEGACY_MODEL_CAPABILITIES_ID, NEW_MODEL_CAPABILITIES_ID, "capabilities");

	// --- Step 3: the global headers move into the entries. A value that
	// really carried headers and gets deleted is PARKED (the plan reports it;
	// the applier stores it once in globalState): the old setting also
	// reached servers without a declared entry - externally managed groups -
	// which the new world cannot express headers for, so the parked copy
	// keeps the loss recoverable through the dashboard's hint and the adopt
	// flow. A value that carried nothing (empty or non-record) parks nothing:
	// there is no lost behavior to recover, and a permanent hint for it would
	// contradict its own log line.
	let parkedHeaders: Readonly<Record<string, unknown>> | undefined;
	const rawHeaders = globalOf(LEGACY_HEADERS_ID);
	if (rawHeaders !== undefined) {
		if (!isRecord(rawHeaders) || Object.keys(rawHeaders).length === 0) {
			// Nothing any entry could receive: the old readers sent nothing for
			// this value, so it drains without a copy.
			deletions.push(LEGACY_HEADERS_ID);
			logLines.push("Removed the global headers setting from user settings; it carried no usable headers");
		} else {
			const receivers = targets.filter((target) => entryCanReceiveHeaders(entryAt(target.entryIndex)));
			if (receivers.length === 0) {
				logLines.push(
					"Left the global headers setting in place: no declared server entry can receive it (see the dashboard hint)"
				);
			} else {
				for (const target of receivers) {
					updateEntry(target.entryIndex, (entry) => withEntryHeaders(entry, rawHeaders).entry);
				}
				deletions.push(LEGACY_HEADERS_ID);
				parkedHeaders = rawHeaders;
				logLines.push(
					`Copied the global headers setting into ${receivers.length} server ${entriesNoun(receivers.length)} and removed it`
				);
			}
		}
	}

	// --- Step 6: the default* token trio merges into the models.capabilities "*" record.
	const trio = mergeTokenDefaults(capabilitiesState.value, snapshot);
	if (trio.capabilitiesValue !== undefined) {
		const existing = valueWrites.findIndex((write) => write.section === NEW_MODEL_CAPABILITIES_ID);
		const write: SettingWrite = { section: NEW_MODEL_CAPABILITIES_ID, value: trio.capabilitiesValue };
		if (existing >= 0) {
			valueWrites[existing] = write;
		} else {
			valueWrites.push(write);
		}
	}
	deletions.push(...trio.consumedIds);
	if (trio.movedFields > 0) {
		logLines.push(
			`Moved ${trio.movedFields} default token setting value(s) into the models.capabilities "*" record in user settings`
		);
	}
	if (trio.drainedKeys > 0) {
		logLines.push(
			`Removed ${trio.drainedKeys} default token setting key(s) from user settings; the models.capabilities "*" record already covered them`
		);
	}
	if (trio.blockedValues > 0) {
		logLines.push(
			`Left ${trio.blockedValues} default token setting value(s) in user settings: the models.capabilities "*" record is not a mergeable record`
		);
	}

	// --- Step 1: the scalar renames, values carried verbatim.
	for (const { oldId, newId } of LEGACY_SCALAR_RENAMES) {
		const oldValue = globalOf(oldId);
		if (oldValue === undefined) {
			continue;
		}
		if (globalOf(newId) !== undefined) {
			deletions.push(oldId);
			keptNewNames += 1;
			continue;
		}
		valueWrites.push({ section: newId, value: oldValue });
		deletions.push(oldId);
		renamedSettings += 1;
	}

	// --- Assemble the plan: servers first, then the other value writes, deletions last.
	const writes: SettingWrite[] = [];
	if (!isDeepStrictEqual(serversValue, rawServers)) {
		writes.push({ section: SERVERS_ID, value: serversValue });
	}
	writes.push(...valueWrites);
	writes.push(...deletions.map((section) => ({ section, value: undefined })));

	if (renamedSettings > 0) {
		logLines.unshift(`Renamed ${renamedSettings} setting(s) to their new names in user settings`);
	}
	if (keptNewNames > 0) {
		logLines.push(`Dropped ${keptNewNames} old setting key(s) whose new names already hold a value`);
	}
	if (counts.restructuredEntries > 0) {
		logLines.push(
			`Restructured ${counts.restructuredEntries} server ${entriesNoun(counts.restructuredEntries)} to the redesigned shape`
		);
	}
	if (counts.droppedJunkFields > 0) {
		logLines.push(`Dropped ${counts.droppedJunkFields} legacy entry field value(s) the old readers never honored`);
	}
	if (counts.starredKeys > 0) {
		logLines.push(`Rewrote ${counts.starredKeys} record key(s) to explicit matchers`);
	}
	if (counts.droppedAliasKeys > 0) {
		logLines.push(`Dropped ${counts.droppedAliasKeys} duplicate catch-all record key(s)`);
	}
	if (movedScoped > 0) {
		logLines.push(`Moved ${movedScoped} server-scoped record key(s) into their matching entries`);
	}
	if (inertScoped > 0) {
		logLines.push(
			`Left ${inertScoped} server-scoped record key(s) in place: no declared entry could receive them (see the dashboard hint)`
		);
	}
	if (counts.movedDeclares > 0) {
		logLines.push(`Moved ${counts.movedDeclares} _declare directive(s) into their entries' declared model lists`);
	}
	if (counts.strippedInertDeclares > 0) {
		logLines.push(`Removed ${counts.strippedInertDeclares} inert _declare directive(s)`);
	}
	const workspaceHits = LEGACY_SETTING_IDS.reduce((count, id) => {
		const layers = snapshot[id];
		return (
			count + (layers?.workspaceValue !== undefined ? 1 : 0) + (layers?.workspaceFolderValue !== undefined ? 1 : 0)
		);
	}, 0);
	if (workspaceHits > 0) {
		logLines.push(
			`${workspaceHits} workspace-layer value(s) of renamed or removed settings were left in place (use the new setting names in that scope instead)`
		);
	}

	return {
		writes,
		logLines,
		outcome: writes.length > 0 ? "migrated" : "nothing-to-do",
		...(parkedHeaders !== undefined ? { parkedHeaders } : {}),
	};
}
