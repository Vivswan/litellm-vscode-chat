import * as assert from "node:assert";
import type { ParseEnvelopeResult, SettingsExportEnvelope } from "../../../extension/settingsTransfer/envelope";
import {
	buildEnvelope,
	parseEnvelope,
	SETTINGS_EXPORT_FORMAT_VERSION,
} from "../../../extension/settingsTransfer/envelope";
import { ALL_SETTING_KEYS, CONFIG_SECTION } from "../../../shared/config/settingSpec";

suite("extension/settingsTransfer/envelope", () => {
	test("the frozen signatures and the format version", () => {
		assert.strictEqual(SETTINGS_EXPORT_FORMAT_VERSION, 1);
		const build: (settings: Readonly<Record<string, unknown>>, exportedBy: string) => SettingsExportEnvelope =
			buildEnvelope;
		const parse: (raw: string) => ParseEnvelopeResult = parseEnvelope;
		assert.strictEqual(typeof build, "function");
		assert.strictEqual(typeof parse, "function");
	});

	test("buildEnvelope wraps the settings under the config-section discriminant", () => {
		const settings = { "chat.timeout": 60000, servers: [] };
		const envelope = buildEnvelope(settings, "1.2.3");
		assert.deepStrictEqual(envelope, {
			[CONFIG_SECTION]: SETTINGS_EXPORT_FORMAT_VERSION,
			exportedBy: "1.2.3",
			settings,
		});
	});

	test("unparseable text reads as not-json", () => {
		for (const raw of ["", "{", "not json at all", '{"a":}', "'single'"]) {
			assert.deepStrictEqual(parseEnvelope(raw), { ok: false, reason: "not-json" });
		}
	});

	test("JSON without the discriminant shape reads as not-an-export", () => {
		const cases = [
			"null",
			"42",
			'"text"',
			"[]",
			"{}",
			'{"settings":{}}',
			`{"${CONFIG_SECTION}":"1","settings":{}}`,
			`{"${CONFIG_SECTION}":true,"settings":{}}`,
			`{"${CONFIG_SECTION}":null,"settings":{}}`,
			`{"${CONFIG_SECTION}":1}`,
			`{"${CONFIG_SECTION}":1,"settings":null}`,
			`{"${CONFIG_SECTION}":1,"settings":[]}`,
			`{"${CONFIG_SECTION}":1,"settings":"x"}`,
		];
		for (const raw of cases) {
			assert.deepStrictEqual(parseEnvelope(raw), { ok: false, reason: "not-an-export" }, raw);
		}
	});

	test("a higher format version reads as newer-version, with exportedBy provenance when it is a string", () => {
		assert.deepStrictEqual(parseEnvelope(`{"${CONFIG_SECTION}":2,"settings":{},"exportedBy":"9.9.9"}`), {
			ok: false,
			reason: "newer-version",
			exportedBy: "9.9.9",
		});
		assert.deepStrictEqual(parseEnvelope(`{"${CONFIG_SECTION}":2,"settings":{}}`), {
			ok: false,
			reason: "newer-version",
			exportedBy: undefined,
		});
		assert.deepStrictEqual(parseEnvelope(`{"${CONFIG_SECTION}":99,"exportedBy":7}`), {
			ok: false,
			reason: "newer-version",
			exportedBy: undefined,
		});
	});

	test("known keys land in settings, unknown keys are reported in file order and never written", () => {
		const raw = JSON.stringify({
			[CONFIG_SECTION]: 1,
			exportedBy: "0.4.5",
			settings: {
				mystery: 1,
				"chat.timeout": 60000,
				"models.parameters": { "*": { temperature: 0 } },
				"another.unknown": true,
				servers: [],
			},
		});
		const result = parseEnvelope(raw);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.settings, {
			"chat.timeout": 60000,
			"models.parameters": { "*": { temperature: 0 } },
			servers: [],
		});
		assert.deepStrictEqual(result.unknownKeys, ["mystery", "another.unknown"]);
		assert.strictEqual(result.exportedBy, "0.4.5");
	});

	test("exportedBy is provenance only, never a compatibility gate", () => {
		// Garbage, missing, and non-string exportedBy values all still parse ok.
		for (const exportedBy of [undefined, 42, null, { v: 1 }, "999.999.999", ""]) {
			const raw = JSON.stringify({ [CONFIG_SECTION]: 1, exportedBy, settings: { "chat.timeout": 1 } });
			const result = parseEnvelope(raw);
			assert.ok(result.ok, `exportedBy=${JSON.stringify(exportedBy)} must not gate parsing`);
			assert.strictEqual(result.exportedBy, typeof exportedBy === "string" ? exportedBy : undefined);
		}
	});

	test("version leniency: any number at or below the format version parses", () => {
		// The discriminant gates on "is a number" and "is not newer"; older or
		// odd numbers stay readable rather than inventing a lower bound.
		for (const version of [1, 0, 0.5, -3]) {
			const result = parseEnvelope(JSON.stringify({ [CONFIG_SECTION]: version, settings: {} }));
			assert.ok(result.ok, `version ${version} must parse`);
		}
	});

	test("build -> stringify -> parse round-trips every known key with no unknowns", () => {
		const settings: Record<string, unknown> = {};
		ALL_SETTING_KEYS.forEach((key, index) => {
			settings[key] = { probe: index };
		});
		const result = parseEnvelope(JSON.stringify(buildEnvelope(settings, "0.0.1")));
		assert.ok(result.ok);
		assert.deepStrictEqual(result.settings, settings);
		assert.deepStrictEqual(result.unknownKeys, []);
		assert.strictEqual(result.exportedBy, "0.0.1");
	});
});
