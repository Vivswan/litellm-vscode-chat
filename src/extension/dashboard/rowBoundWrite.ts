/**
 * The dashboard guards for a settings write that acts on a displayed row or appends beside one. A row was rendered from
 * an older setting, so every guard binds to what the row carried and derives its array from `fresh`, the read
 * settingsWriteTurn.ts's turn made in the same tick as the write it then performs.
 */

import { isDeepStrictEqual } from "node:util";
import * as l10n from "@vscode/l10n";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { trimHttpWhitespace } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import { drawableRejects } from "../servers/serverSync/rejects";
import type { DeclaredServer } from "../servers/serverSync/setting";
import {
	acceptedEntry,
	declaredEntryLabel,
	parseServersSetting,
	rawDeclaredLabels,
	serverSettingReports,
} from "../servers/serverSync/setting";
import type { ServersSettingStore } from "../settingsWriteTurn";
import { rawServerEntries } from "../settingsWriteTurn";
import { DashboardValidationError } from "./intents";

export interface RowIdentity {
	readonly label: string;
	readonly baseUrl: string;
}

/** Trimmed like the parser reads it, so a padded raw base URL still matches the URL its row shows. */
function sameBaseUrl(entryBaseUrl: unknown, rowBaseUrl: string): boolean {
	return (
		typeof entryBaseUrl === "string" &&
		normalizeBaseUrl(trimHttpWhitespace(entryBaseUrl)) === normalizeBaseUrl(trimHttpWhitespace(rowBaseUrl))
	);
}

function noEntryUnderLabel(): DashboardValidationError {
	return new DashboardValidationError(
		l10n.t("No servers setting entry has this label; the server is managed outside the setting")
	);
}

function entryMoved(): DashboardValidationError {
	return new DashboardValidationError(
		l10n.t("The entry under this label now points at another base URL; wait for the dashboard to refresh, then retry")
	);
}

/**
 * The indices of every raw carrier of the row's label, a parser-rejected sibling included. Authorization follows
 * the one entry that can have a row: the accepted entry when one exists, otherwise the drawable reject
 * (drawableRejects, the rule the Misconfigured rows are drawn by).
 */
function carriersOfRow(entries: readonly unknown[], row: RowIdentity): readonly number[] {
	const label = trimHttpWhitespace(row.label);
	const carriers = entries.flatMap((entry, index) => (declaredEntryLabel(entry) === label ? [index] : []));
	if (carriers.length === 0) {
		throw noEntryUnderLabel();
	}
	const parsed = parseServersSetting(entries).entries;
	const acceptedLabels = new Set(parsed.map((entry) => entry.label));
	const drawn =
		parsed.find((entry) => entry.label === label)?.baseUrl ??
		drawableRejects(serverSettingReports(entries), acceptedLabels).find((reject) => reject.label === label)?.baseUrl;
	if (drawn === undefined || !sameBaseUrl(drawn, row.baseUrl)) {
		throw entryMoved();
	}
	return carriers;
}

/** The accepted entry a declared row described, refused when none exists or it points elsewhere now. */
function acceptedEntryOfRow(
	entries: readonly unknown[],
	row: RowIdentity
): { readonly index: number; readonly entry: DeclaredServer } {
	const match = acceptedEntry(entries, row.label);
	if (match === undefined) {
		throw noEntryUnderLabel();
	}
	if (!sameBaseUrl(match.entry.baseUrl, row.baseUrl)) {
		throw entryMoved();
	}
	return match;
}

/**
 * Raw labels count as taken: a parser-rejected sibling still occupies its label, and appending beside it would land
 * two entries under one.
 */
export function requireLabelFree(entries: readonly unknown[], label: string): void {
	if (rawDeclaredLabels(entries).has(label)) {
		throw new DashboardValidationError(`label: ${l10n.t("an entry with this label already exists")}`);
	}
}

/**
 * A decision made on `setting` (ServerSyncEngine.resolveDeclaredIdentities) is written only while the setting still
 * reads the same, in the same tick as the write; a promise continuation between the two is a yield point. The
 * engine read the effective value and this reads the user scope, so an unset setting is [] there and undefined here.
 *
 *   same entries, an array or unset          -> unchanged
 *   different entries, or a malformed value  -> changed; a container turning non-array counts
 */
export function requireSettingUnchanged(
	store: Pick<ServersSettingStore, "readServersSetting">,
	setting: unknown
): void {
	const current = store.readServersSetting();
	const unchanged =
		(current === undefined || Array.isArray(current)) &&
		isDeepStrictEqual(rawServerEntries(current), rawServerEntries(setting));
	if (!unchanged) {
		throw new DashboardValidationError(l10n.t("The servers setting changed while this action ran; retry"));
	}
}

export function appendFree(fresh: readonly unknown[], label: string, entry: unknown): unknown[] {
	requireLabelFree(fresh, label);
	return [...fresh, entry];
}

/** `shown` is the element the form displayed and the plans resolved against; a rename also needs its new label free. */
export function replaceShown(
	fresh: readonly unknown[],
	index: number,
	shown: unknown,
	entry: unknown,
	renamedTo?: string
): unknown[] {
	if (renamedTo !== undefined) {
		requireLabelFree(fresh, renamedTo);
	}
	if (index === -1 || !isDeepStrictEqual(fresh[index], shown)) {
		throw new DashboardValidationError(
			l10n.t("The entry being edited changed in the servers setting while the form was open; close the form and retry")
		);
	}
	const next = [...fresh];
	next[index] = entry;
	return next;
}

export function removeRow(fresh: readonly unknown[], row: RowIdentity): unknown[] {
	const carriers = new Set(carriersOfRow(fresh, row));
	return fresh.filter((_, index) => !carriers.has(index));
}

export function patchRow(
	fresh: readonly unknown[],
	row: RowIdentity,
	patch: (rawEntry: Record<string, unknown>) => Record<string, unknown> | undefined
): unknown[] | undefined {
	const accepted = acceptedEntryOfRow(fresh, row);
	const rawEntry = fresh[accepted.index];
	if (!isRecord(rawEntry)) {
		throw noEntryUnderLabel();
	}
	const patched = patch(rawEntry);
	if (patched === undefined) {
		return undefined;
	}
	const next = [...fresh];
	next[accepted.index] = patched;
	return next;
}
