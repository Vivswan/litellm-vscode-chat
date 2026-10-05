/**
 * The one path for a settings write that acts on a displayed row or appends beside one. A row was rendered from an
 * older setting, so every write binds to what the row carried and derives its array from a read made in the same
 * tick as the write.
 */

import { isDeepStrictEqual } from "node:util";
import * as l10n from "@vscode/l10n";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { isRecord } from "../../shared/util/json";
import type { DeclaredServer } from "../servers/serverSync";
import {
	acceptedEntry,
	declaredEntryLabel,
	drawableRejects,
	parseServersSetting,
	rawDeclaredLabels,
	serverSettingReports,
} from "../servers/serverSync/setting";
import type { IntentEnvironment } from "./intents";
import { DashboardValidationError, rawServerEntries } from "./intents";

/** The write IntentEnvironment.writeServersSetting accepts: one a guard in this module produced, and nothing else. */
const MINT = Symbol("mint");

class ValidatedServersWrite {
	readonly #entries: readonly unknown[];
	constructor(entries: readonly unknown[], key: symbol) {
		if (key !== MINT) {
			throw new TypeError("ValidatedServersWrite is minted by rowBoundWrite.ts only");
		}
		this.#entries = entries;
	}
	static entriesOf(write: ValidatedServersWrite): readonly unknown[] {
		return write.#entries;
	}
}
Object.freeze(ValidatedServersWrite);

export type { ValidatedServersWrite };

function mint(entries: readonly unknown[]): ValidatedServersWrite {
	return new ValidatedServersWrite(entries, MINT);
}

/** The guarded array behind a token; a TypeError for an object this module never minted, whatever its shape. */
export function entriesOf(write: ValidatedServersWrite): readonly unknown[] {
	return ValidatedServersWrite.entriesOf(write);
}

/** What a displayed row carries about its entry. */
export interface RowIdentity {
	readonly label: string;
	readonly baseUrl: string;
}

/** Trimmed like the parser reads it, so a padded raw base URL still matches the URL its row shows. */
function sameBaseUrl(entryBaseUrl: unknown, rowBaseUrl: string): boolean {
	return (
		typeof entryBaseUrl === "string" && normalizeBaseUrl(entryBaseUrl.trim()) === normalizeBaseUrl(rowBaseUrl.trim())
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
	const label = row.label.trim();
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

/** Raw labels count as taken: a parser-rejected sibling still occupies its label, and appending beside it would land two entries under one. */
export function requireLabelFree(entries: readonly unknown[], label: string): void {
	if (rawDeclaredLabels(entries).has(label)) {
		throw new DashboardValidationError(`label: ${l10n.t("an entry with this label already exists")}`);
	}
}

/**
 * A decision made on `setting` (ServerSyncEngine.resolveDeclaredIdentities) is written only while the setting still
 * reads the same, in the same tick as the write; a promise continuation between the two is a yield point.
 */
export function requireSettingUnchanged(env: IntentEnvironment, setting: unknown): void {
	if (!isDeepStrictEqual(rawServerEntries(env.readServersSetting()), rawServerEntries(setting))) {
		throw new DashboardValidationError(l10n.t("The servers setting changed while this action ran; retry"));
	}
}

export function appendFree(fresh: readonly unknown[], label: string, entry: unknown): ValidatedServersWrite {
	requireLabelFree(fresh, label);
	return mint([...fresh, entry]);
}

/** `shown` is the element the form displayed and the plans resolved against; a rename also needs its new label free. */
export function replaceShown(
	fresh: readonly unknown[],
	index: number,
	shown: unknown,
	entry: unknown,
	renamedTo?: string
): ValidatedServersWrite {
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
	return mint(next);
}

export function removeRow(fresh: readonly unknown[], row: RowIdentity): ValidatedServersWrite {
	const carriers = new Set(carriersOfRow(fresh, row));
	return mint(fresh.filter((_, index) => !carriers.has(index)));
}

export function patchRow(
	fresh: readonly unknown[],
	row: RowIdentity,
	patch: (rawEntry: Record<string, unknown>) => Record<string, unknown> | undefined
): ValidatedServersWrite | undefined {
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
	return mint(next);
}

/** Nothing awaits between the read here and the write. */
export async function writeServersSettingFrom(
	env: IntentEnvironment,
	next: (fresh: readonly unknown[]) => ValidatedServersWrite | undefined
): Promise<boolean> {
	const write = next(rawServerEntries(env.readServersSetting()));
	if (write === undefined) {
		return false;
	}
	await env.writeServersSetting(write);
	return true;
}
