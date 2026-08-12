/**
 * Record-level lint pins: the map-wide problems the per-model chain
 * resolution can never report because no live model visits the record. The
 * Diagnostics tab renders these (through configDiagnostics.ts), so what
 * counts as a problem - and what stays silent - is pinned here at the source.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { lintCapabilityRecords, parseCapabilityRecord } from "../../../../shared/config/capabilityResolution";
import { lintParameterRecords, parseParameterRecord } from "../../../../shared/config/parameterResolution";
import { lintRecordMap } from "../../../../shared/config/recordResolution";

describe("shared/config record-level lints", () => {
	test("a clean map lints clean", () => {
		assert.deepStrictEqual(
			lintParameterRecords({
				"gpt*": { temperature: 0.5, _inheritable: true, _force: ["temperature"] },
				"gpt-4": { top_p: 1, _inherit_from: ["gpt*"] },
			}),
			[]
		);
		assert.deepStrictEqual(
			lintCapabilityRecords({
				"gpt*": { context_length: 128000, _fallback: true },
				"gpt-4": { supports_vision: true, _inherit_from: false, _openrouter_model: "openai/gpt-4o" },
			}),
			[]
		);
	});

	test("an unknown _inherit_from key reports even on a record NO model matches - the lint's whole point", () => {
		// "no-model-is-named-this*" matches nothing in any live catalog, so
		// resolveRecordChain never walks it; only the record-level lint can
		// surface the dangling name.
		const diagnostics = lintParameterRecords({
			"no-model-is-named-this*": { temperature: 1, _inherit_from: ["defaults"] },
		});
		assert.deepStrictEqual(diagnostics, [
			{ kind: "unknown-inherit-key", recordKey: "no-model-is-named-this*", key: "defaults" },
		]);

		const capabilities = lintCapabilityRecords({
			"no-model-is-named-this*": { context_length: 1000, _inherit_from: ["defaults"] },
		});
		assert.deepStrictEqual(capabilities, [
			{ kind: "unknown-inherit-key", recordKey: "no-model-is-named-this*", key: "defaults" },
		]);
	});

	test("invalid matcher keys report as their own diagnostic, keyed to themselves", () => {
		const diagnostics = lintParameterRecords({ "a*b": { temperature: 1 }, "/[/": { top_p: 1 } });
		assert.deepStrictEqual(diagnostics, [
			{ kind: "invalid-matcher", recordKey: "a*b", key: "a*b" },
			{ kind: "invalid-matcher", recordKey: "/[/", key: "/[/" },
		]);
	});

	test("parameter records: unforceable _force names, malformed directives, and the wrong record type's directives", () => {
		const diagnostics = lintParameterRecords({
			"gpt*": {
				temperature: 1,
				_force: ["model", "unset_name"],
				_inheritable: "yes",
				_fallback: true,
			},
		});
		assert.deepStrictEqual(diagnostics, [
			{ kind: "unforceable-key", recordKey: "gpt*", key: "model" },
			{ kind: "invalid-directive", recordKey: "gpt*", key: "_force" },
			{ kind: "wrong-record-type", recordKey: "gpt*", key: "_fallback" },
			{ kind: "invalid-directive", recordKey: "gpt*", key: "_inheritable" },
		]);
	});

	test("capability records: unrecognized fields (kept, informational), wrong-typed values, and _force as the wrong record type", () => {
		const diagnostics = lintCapabilityRecords({
			"gpt*": {
				supports_levitation: true,
				context_length: -5,
				supports_vision: "yes",
				_force: true,
			},
		});
		assert.deepStrictEqual(diagnostics, [
			{ kind: "unrecognized-key", recordKey: "gpt*", key: "supports_levitation" },
			{ kind: "invalid-value", recordKey: "gpt*", key: "context_length" },
			{ kind: "invalid-value", recordKey: "gpt*", key: "supports_vision" },
			{ kind: "wrong-record-type", recordKey: "gpt*", key: "_force" },
		]);
		// The unrecognized field is advisory, not gating: the record keeps it.
		assert.deepStrictEqual(parseCapabilityRecord({ supports_levitation: true }).fields, {
			supports_levitation: true,
		});
	});

	test("lintRecordMap deduplicates identical diagnostics from one record", () => {
		// Two invalid _inheritable entries collapse to one (kind, record, key)
		// report, matching the chain walk's dedup.
		const diagnostics = lintRecordMap({ "gpt*": { temperature: 1, _inheritable: [1, 2] } }, parseParameterRecord);
		assert.deepStrictEqual(diagnostics, [{ kind: "invalid-directive", recordKey: "gpt*", key: "_inheritable" }]);
	});

	test("an _inherit_from list naming an INVALID key in the map still resolves the name as existing", () => {
		// The named key exists (Object.hasOwn), so no unknown-inherit-key fires;
		// the invalid matcher carries its own diagnostic instead.
		const diagnostics = lintParameterRecords({
			"a*b": { temperature: 1 },
			"gpt*": { top_p: 1, _inherit_from: ["a*b"] },
		});
		assert.deepStrictEqual(diagnostics, [{ kind: "invalid-matcher", recordKey: "a*b", key: "a*b" }]);
	});
});
