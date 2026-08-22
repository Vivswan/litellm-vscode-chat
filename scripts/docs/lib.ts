/**
 * Builds and stamps each locale's settings-reference table. Three inputs, each
 * owning one thing: the setting spec the vocabulary, package.json the row order
 * and defaults, settingsReferenceProse.ts the per-locale behavior column.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ALL_SETTING_KEYS, CONFIG_SECTION } from "../../src/shared/config/settingSpec";
import { SETTING_PROSE, type SettingProse } from "./settingsReferenceProse";

export const DOC_LOCALES = ["en", "zhCn", "zhTw"] as const;

export type DocLocale = (typeof DOC_LOCALES)[number];

/** Each locale's settings doc, relative to the repo root. */
export const SETTINGS_DOC_PATHS: Record<DocLocale, string> = {
	en: "docs/settings.md",
	zhCn: "docs/zh-cn/settings.md",
	zhTw: "docs/zh-tw/settings.md",
};

/** The reference table's header row per locale; the anchor the first stamping locates the hand-written table by. */
export const TABLE_HEADERS: Record<DocLocale, string> = {
	en: "| Setting | Default | Behavior |",
	zhCn: "| 设置 | 默认值 | 行为 |",
	zhTw: "| 設定 | 預設值 | 行為 |",
};

const TABLE_SEPARATOR = "|---------|---------|-------------|";

export const BEGIN_MARKER =
	"<!-- settings-reference:begin (generated from src/shared/config/settingSpec.ts, package.json, and scripts/docs/settingsReferenceProse.ts; edit those, then run: bun scripts/docs/generate-settings-reference.ts) -->";
export const END_MARKER = "<!-- settings-reference:end -->";

interface ManifestSettingSchema {
	readonly default?: unknown;
}

interface ManifestConfigurationSection {
	readonly properties: Record<string, ManifestSettingSchema>;
}

interface ManifestShape {
	readonly contributes: {
		readonly configuration: readonly ManifestConfigurationSection[];
	};
}

/** The contributed settings in manifest order (the settings UI's order, which the docs tables follow) with their manifest defaults. */
export interface ManifestSettings {
	readonly order: readonly string[];
	readonly defaults: ReadonlyMap<string, unknown>;
}

/** Refuses a manifest the spec no longer describes: the docs must not regenerate from a drifted vocabulary. */
export function readManifestSettings(repoRoot: string): ManifestSettings {
	const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as ManifestShape;
	const order: string[] = [];
	const defaults = new Map<string, unknown>();
	for (const section of manifest.contributes.configuration) {
		for (const [key, schema] of Object.entries(section.properties)) {
			if (!key.startsWith(`${CONFIG_SECTION}.`)) {
				throw new Error(`setting ${key} is contributed outside the ${CONFIG_SECTION} section`);
			}
			const id = key.slice(`${CONFIG_SECTION}.`.length);
			if (defaults.has(id)) {
				throw new Error(`setting ${key} is contributed twice`);
			}
			order.push(id);
			defaults.set(id, schema.default);
		}
	}
	const contributed = [...order].sort().join("\n");
	const declared = [...ALL_SETTING_KEYS].sort().join("\n");
	if (contributed !== declared) {
		throw new Error(
			"package.json's contributed settings and ALL_SETTING_KEYS disagree; align the manifest and the spec before generating the settings reference"
		);
	}
	return { order, defaults };
}

/**
 * The manifest is the only default pipeline: it is what the settings UI shows,
 * and settingSpec.test.ts already pins every scalar contribution against its
 * spec default, so reading the spec here would render the same number twice.
 */
function renderDefault(id: string, manifest: ManifestSettings): string {
	const value = manifest.defaults.get(id);
	if (value === undefined) {
		throw new Error(`setting ${id} has no manifest default to render`);
	}
	return renderJsonDefault(value);
}

/**
 * The tables space array elements (`[0.8, 0.95]`) and keep objects compact
 * (`{"mode":"block","languages":[]}`); pinning that shape here keeps
 * regeneration from reformatting a default.
 */
function renderJsonDefault(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => renderJsonDefault(item)).join(", ")}]`;
	}
	return JSON.stringify(value);
}

/** The default column renders inside a backtick code span, so a backtick, pipe, or line break in it would break the row. */
function assertDefaultCell(id: string, rendered: string): void {
	if (/[`|\r\n]/.test(rendered)) {
		throw new Error(`setting ${id}'s default ${JSON.stringify(rendered)} cannot render inside a table code span`);
	}
}

function assertProseCell(id: string, locale: DocLocale, text: string): void {
	if (text.length === 0 || text !== text.trim()) {
		throw new Error(`setting ${id} has empty or untrimmed ${locale} prose`);
	}
	if (/[\r\n]/.test(text)) {
		throw new Error(`setting ${id}'s ${locale} prose contains a line break; table rows are single lines`);
	}
	// Strip escaped backslashes before escaped pipes, so a cell ending in a
	// literal backslash (`\\` then `|`) cannot smuggle a live column separator
	// past a guard that only knew how to unescape `\|`.
	if (text.replaceAll("\\\\", "").replaceAll("\\|", "").includes("|")) {
		throw new Error(`setting ${id}'s ${locale} prose contains an unescaped "|"; it would add a table column`);
	}
}

/**
 * Both directions are collected before either throws, so a renamed setting
 * reports the obsolete entry AND the undocumented key in one run. Returning the
 * pairs keeps the caller's loop total.
 */
function validatedRows(
	manifest: ManifestSettings,
	prose: Readonly<Record<string, SettingProse>>
): readonly (readonly [string, SettingProse])[] {
	const contributed = new Set(manifest.order);
	const unknown = Object.keys(prose).filter((id) => !contributed.has(id));
	const rows: (readonly [string, SettingProse])[] = [];
	const missing: string[] = [];
	for (const id of manifest.order) {
		// hasOwn, not a truthiness check: a setting named for an Object.prototype
		// member would otherwise inherit a value here and fail later on a
		// nonsense TypeError instead of this actionable message.
		const entry = Object.hasOwn(prose, id) ? prose[id] : undefined;
		if (entry === undefined) {
			missing.push(id);
			continue;
		}
		rows.push([id, entry]);
	}
	const faults: string[] = [];
	if (missing.length > 0) {
		faults.push(
			`settingsReferenceProse.ts has no entry for ${missing.join(", ")}; every contributed setting needs behavior prose in all three locales`
		);
	}
	if (unknown.length > 0) {
		faults.push(
			`settingsReferenceProse.ts names ${unknown.join(", ")}, which package.json does not contribute; delete those entries`
		);
	}
	if (faults.length > 0) {
		throw new Error(faults.join("\n"));
	}
	return rows;
}

/** One locale's table: header, separator, and one row per contributed setting in manifest order. */
export function buildReferenceTable(
	locale: DocLocale,
	manifest: ManifestSettings,
	prose: Readonly<Record<string, SettingProse>> = SETTING_PROSE
): string {
	const lines = [TABLE_HEADERS[locale], TABLE_SEPARATOR];
	for (const [id, entry] of validatedRows(manifest, prose)) {
		const text = entry[locale];
		assertProseCell(id, locale, text);
		const rendered = renderDefault(id, manifest);
		assertDefaultCell(id, rendered);
		const row = `| \`${CONFIG_SECTION}.${id}\` | \`${rendered}\` | ${text} |`;
		// A cell carrying marker text would corrupt the next run's region scan
		// there; refuse it here, where the blame is the poisoned entry.
		if (row.includes(BEGIN_MARKER) || row.includes(END_MARKER)) {
			throw new Error(`setting ${id}'s ${locale} row contains the region marker text`);
		}
		lines.push(row);
	}
	return lines.join("\n");
}

/**
 * With a marker region present the body is replaced, which is what makes
 * regeneration idempotent; without one the table found in place is wrapped,
 * which is how a hand-written doc becomes a generated one exactly once.
 */
export function applyReferenceTable(content: string, locale: DocLocale, table: string): string {
	const region = `${BEGIN_MARKER}\n${table}\n${END_MARKER}`;
	const begins = markerCount(content, BEGIN_MARKER);
	const ends = markerCount(content, END_MARKER);
	if (begins > 1 || ends > 1 || begins !== ends) {
		throw new Error(
			`${SETTINGS_DOC_PATHS[locale]} has a malformed marker region: ${begins} begin and ${ends} end markers (exactly one pair, or none, expected)`
		);
	}
	if (begins === 1) {
		const beginAt = content.indexOf(BEGIN_MARKER);
		const endAt = content.indexOf(END_MARKER);
		if (endAt < beginAt) {
			throw new Error(`${SETTINGS_DOC_PATHS[locale]} has its end marker before its begin marker`);
		}
		return content.slice(0, beginAt) + region + content.slice(endAt + END_MARKER.length);
	}
	const lines = content.split("\n");
	const headerAt = lines.indexOf(TABLE_HEADERS[locale]);
	if (headerAt === -1) {
		throw new Error(
			`${SETTINGS_DOC_PATHS[locale]} has neither a marker region nor the ${TABLE_HEADERS[locale]} table header to stamp`
		);
	}
	if (lines.indexOf(TABLE_HEADERS[locale], headerAt + 1) !== -1) {
		throw new Error(
			`${SETTINGS_DOC_PATHS[locale]} repeats the reference table header; cannot decide which table to stamp`
		);
	}
	if (lines[headerAt + 1] !== TABLE_SEPARATOR) {
		throw new Error(`${SETTINGS_DOC_PATHS[locale]}'s reference table header is not followed by its separator row`);
	}
	let endLine = headerAt + 1;
	while (endLine < lines.length && (lines[endLine] ?? "").startsWith("|")) {
		endLine += 1;
	}
	return [...lines.slice(0, headerAt), region, ...lines.slice(endLine)].join("\n");
}

function markerCount(content: string, marker: string): number {
	let count = 0;
	let at = content.indexOf(marker);
	while (at !== -1) {
		count += 1;
		at = content.indexOf(marker, at + marker.length);
	}
	return count;
}
