import { afterAll, describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyReferenceTable,
	BEGIN_MARKER,
	buildReferenceTable,
	DOC_LOCALES,
	type DocLocale,
	END_MARKER,
	readSpecSettings,
	SETTINGS_DOC_PATHS,
	type SpecSettings,
	TABLE_HEADERS,
} from "../../../../../scripts/docs/lib";
import { SETTING_PROSE, type SettingProse } from "../../../../../scripts/docs/settingsReferenceProse";
import { REPO_ROOT } from "../../../util/repoRoot";
import { CHILD_PROCESS_TIMEOUT_MS } from "../../childProcessTimeout";

/**
 * The generator against the shipped docs: stamping must touch nothing but the marker region, and every fail-closed edge
 * must abort, not emit a partial. Whether the committed docs are current is `docs:settings:check`'s question, asked by
 * check:static and CI's lint job, not here.
 */

const settings = readSpecSettings();

function readDoc(locale: DocLocale): string {
	return fs.readFileSync(path.join(REPO_ROOT, SETTINGS_DOC_PATHS[locale]), "utf8");
}

/** The doc without its marker lines: the pre-stamping shape the CLI fixture starts from. */
function unstamped(locale: DocLocale): string {
	return readDoc(locale)
		.split("\n")
		.filter((line) => line !== BEGIN_MARKER && line !== END_MARKER)
		.join("\n");
}

describe("settings reference generation", () => {
	for (const locale of DOC_LOCALES) {
		test(`first stamping of ${locale} replaces the hand-kept table with the marked region and touches nothing else`, () => {
			// A doc from before the markers existed: prose, a hand-kept table under the locale's header, prose.
			// Hand-authored, so the case holds whether or not the shipped doc is current.
			const table = buildReferenceTable(locale, settings);
			const [header, separator] = table.split("\n");
			const before = `# Settings\n\nIntro.\n\n${header}\n${separator}\n| \`old.setting\` | gone | gone |\n\nOutro.\n`;
			assert.strictEqual(
				applyReferenceTable(before, locale, table),
				`# Settings\n\nIntro.\n\n${BEGIN_MARKER}\n${table}\n${END_MARKER}\n\nOutro.\n`
			);
		});

		test(`stamping ${locale} is idempotent, and a stale region body regenerates`, () => {
			const table = buildReferenceTable(locale, settings);
			const once = applyReferenceTable(readDoc(locale), locale, table);
			assert.strictEqual(applyReferenceTable(once, locale, table), once);
			const corrupted = once.replace("`300000`", "`299`");
			assert.notStrictEqual(corrupted, once, "the corruption hit a row");
			assert.strictEqual(applyReferenceTable(corrupted, locale, table), once);
		});

		test(`a ${locale} doc stamped with an older begin-marker wording regenerates to the current one`, () => {
			// The provenance text inside the begin marker changes when the generator's inputs change; a doc carrying
			// the previous wording is still one marked region, not an orphaned end marker.
			const table = buildReferenceTable(locale, settings);
			const current = applyReferenceTable(readDoc(locale), locale, table);
			const older = current.replace(
				BEGIN_MARKER,
				"<!-- settings-reference:begin (generated from an older input list; run the generator) -->"
			);
			assert.notStrictEqual(older, current, "the older wording replaced the marker");
			assert.strictEqual(applyReferenceTable(older, locale, table), current);
		});
	}

	test("a contributed setting without a prose entry fails generation", () => {
		const mutant: Record<string, SettingProse> = { ...SETTING_PROSE };
		delete mutant["chat.timeout"];
		assert.throws(() => buildReferenceTable("en", settings, mutant), /chat\.timeout/);
	});

	test("every undocumented setting is named in one failure, not rediscovered one run at a time", () => {
		// The forcing function for a future feature: land four settings without prose and the first run names all four,
		// so documenting them is one pass instead of four regenerate-and-read cycles.
		const mutant: Record<string, SettingProse> = { ...SETTING_PROSE };
		for (const id of ["chat.timeout", "usage.statusBar", "reviewComments.model"]) {
			delete mutant[id];
		}
		assert.throws(
			() => buildReferenceTable("en", settings, mutant),
			(error: Error) =>
				["chat.timeout", "usage.statusBar", "reviewComments.model"].every((id) => error.message.includes(id))
		);
	});

	test("a prose entry naming no contributed setting fails generation", () => {
		const mutant: Record<string, SettingProse> = {
			...SETTING_PROSE,
			"chat.timout": { en: "typo", zhCn: "typo", zhTw: "typo" },
		};
		assert.throws(() => buildReferenceTable("en", settings, mutant), /chat\.timout/);
	});

	test("a renamed setting reports the obsolete entry and the undocumented key together", () => {
		// The shape a rename actually takes: prose still under the old name, the new name undocumented. Reporting one
		// fault at a time would send the author back for a second run to learn the other half.
		const mutant: Record<string, SettingProse> = { ...SETTING_PROSE };
		const orphaned = mutant["chat.timeout"];
		assert.ok(orphaned);
		delete mutant["chat.timeout"];
		mutant["chat.timeoutMs"] = orphaned;
		assert.throws(
			() => buildReferenceTable("en", settings, mutant),
			(error: Error) => error.message.includes("chat.timeout;") && error.message.includes("chat.timeoutMs")
		);
	});

	test("empty, untrimmed, multiline, column-breaking, and marker-carrying prose each fail generation", () => {
		const base = SETTING_PROSE["chat.timeout"];
		assert.ok(base);
		// "a \\| b" carries a literal backslash then a LIVE pipe: stripping only
		// the escaped form would read it as escaped and let the column through.
		for (const bad of ["", " padded ", "two\nlines", "two\rlines", "a | b", "a \\\\| b", `see ${END_MARKER}`]) {
			const mutant: Record<string, SettingProse> = { ...SETTING_PROSE, "chat.timeout": { ...base, zhTw: bad } };
			assert.throws(() => buildReferenceTable("zhTw", settings, mutant), /chat\.timeout/);
			// The escaped form is the sanctioned way to put a pipe in a cell.
			const escaped: Record<string, SettingProse> = { ...SETTING_PROSE, "chat.timeout": { ...base, zhTw: "a \\| b" } };
			buildReferenceTable("zhTw", settings, escaped);
		}
	});

	test("a setting named after an Object.prototype member reports missing prose, not a TypeError", () => {
		// Without the hasOwn check the row inherits Object.prototype.toString and dies later on a TypeError naming
		// nothing useful.
		const order = [...settings.order, "toString"];
		const defaults = new Map(settings.defaults);
		defaults.set("toString", null);
		assert.throws(
			() => buildReferenceTable("en", { order, defaults, bounds: settings.bounds }, SETTING_PROSE),
			(error: Error) => error.message.includes("no entry for toString")
		);
	});

	test("a setting without a default fails generation", () => {
		const defaults = new Map(settings.defaults);
		defaults.delete("servers");
		const gutted: SpecSettings = { order: settings.order, defaults, bounds: settings.bounds };
		assert.throws(() => buildReferenceTable("en", gutted, SETTING_PROSE), /servers/);
	});

	test("a default that would break the table's code span fails generation", () => {
		// No newline case: JSON.stringify escapes newlines inside string defaults, so a raw newline cannot reach a
		// structured default's cell.
		for (const bad of ["a`b", "a|b"]) {
			const defaults = new Map(settings.defaults);
			defaults.set("usage.currencySymbol", bad);
			const poisoned: SpecSettings = { order: settings.order, defaults, bounds: settings.bounds };
			assert.throws(() => buildReferenceTable("en", poisoned, SETTING_PROSE), /usage\.currencySymbol/);
		}
	});

	test("malformed marker layouts fail instead of regenerating around them", () => {
		const table = buildReferenceTable("en", settings);
		const stamped = applyReferenceTable(unstamped("en"), "en", table);
		for (const malformed of [
			`${END_MARKER}\n${stamped}`, // an orphan end marker before the region
			`${stamped}\n${END_MARKER}`, // a second end marker after it
			`${stamped}\n${BEGIN_MARKER}`, // a second begin marker
			stamped.replace(END_MARKER, ""), // a begin marker with no end
			stamped.replace(BEGIN_MARKER, "").replace(END_MARKER, `${END_MARKER}\n${BEGIN_MARKER}`), // end before begin
		]) {
			assert.throws(() => applyReferenceTable(malformed, "en", table), /marker/);
		}
	});

	test("an ambiguous or separator-less table header fails the first stamping", () => {
		const table = buildReferenceTable("en", settings);
		const original = unstamped("en");
		const quoted = original.replace("## Reference", `## Reference\n\n${TABLE_HEADERS.en}`);
		assert.throws(() => applyReferenceTable(quoted, "en", table), /repeats the reference table header/);
		const lines = original.split("\n");
		const headerAt = lines.indexOf(TABLE_HEADERS.en);
		const gutted = [...lines.slice(0, headerAt + 1), ...lines.slice(headerAt + 2)].join("\n");
		assert.throws(() => applyReferenceTable(gutted, "en", table), /separator row/);
	});
});

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeFixture(): string {
	const root = makeTempDir("settings-reference-cli-");
	for (const locale of DOC_LOCALES) {
		const rel = SETTINGS_DOC_PATHS[locale];
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), unstamped(locale));
	}
	return root;
}

function runCli(root: string, ...flags: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({
		cmd: ["bun", path.join(REPO_ROOT, "scripts", "docs", "generate-settings-reference.ts"), "--root", root, ...flags],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("generate-settings-reference CLI", () => {
	test(
		"an unknown argument aborts without writing",
		() => {
			// A typo'd --check must not fall through to generate mode and rewrite docs.
			const root = makeFixture();
			const before = fs.readFileSync(path.join(root, SETTINGS_DOC_PATHS.en), "utf8");
			const typo = runCli(root, "--chekc"); // typos: ignore
			assert.strictEqual(typo.exitCode, 1);
			assert.match(typo.stderr, /Unknown option/);
			assert.strictEqual(fs.readFileSync(path.join(root, SETTINGS_DOC_PATHS.en), "utf8"), before);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"one locale's failure writes nothing anywhere",
		() => {
			// The zh-tw doc loses its table header, so its stamping throws; the two-phase CLI must leave the other
			// locales untouched too.
			const root = makeFixture();
			const zhTwPath = path.join(root, SETTINGS_DOC_PATHS.zhTw);
			fs.writeFileSync(zhTwPath, fs.readFileSync(zhTwPath, "utf8").replace(TABLE_HEADERS.zhTw, "| gone |"));
			const before = fs.readFileSync(path.join(root, SETTINGS_DOC_PATHS.en), "utf8");
			const broken = runCli(root);
			assert.strictEqual(broken.exitCode, 1);
			assert.strictEqual(fs.readFileSync(path.join(root, SETTINGS_DOC_PATHS.en), "utf8"), before);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"--check flags unstamped docs, generation stamps them, then --check passes and drift fails again",
		() => {
			const root = makeFixture();

			// Unstamped docs are drift by definition: the final stamping run has not happened yet, so a wired check
			// would fail until it does.
			const unstamped = runCli(root, "--check");
			assert.strictEqual(unstamped.exitCode, 1);
			assert.match(unstamped.stderr, /docs\/settings\.md is stale/);

			const generate = runCli(root);
			assert.strictEqual(generate.exitCode, 0, generate.stderr);
			for (const locale of DOC_LOCALES) {
				const stamped = fs.readFileSync(path.join(root, SETTINGS_DOC_PATHS[locale]), "utf8");
				assert.ok(stamped.includes(BEGIN_MARKER), `${SETTINGS_DOC_PATHS[locale]} gained the begin marker`);
				assert.ok(stamped.includes(END_MARKER), `${SETTINGS_DOC_PATHS[locale]} gained the end marker`);
			}

			const clean = runCli(root, "--check");
			assert.strictEqual(clean.exitCode, 0, clean.stderr);
			assert.match(clean.stdout, /check passed/);

			const before = fs.readFileSync(path.join(root, "docs", "settings.md"), "utf8");
			const rerun = runCli(root);
			assert.strictEqual(rerun.exitCode, 0, rerun.stderr);
			assert.strictEqual(
				fs.readFileSync(path.join(root, "docs", "settings.md"), "utf8"),
				before,
				"regeneration is a no-op"
			);

			fs.writeFileSync(path.join(root, "docs", "settings.md"), before.replace("`300000`", "`299`"));
			const drifted = runCli(root, "--check");
			assert.strictEqual(drifted.exitCode, 1);
			assert.match(drifted.stderr, /docs\/settings\.md is stale/);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);
});
