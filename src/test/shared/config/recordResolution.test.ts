/**
 * The inheritance engine's unit pins, driven through the parameters-record
 * parser (resolveParameterLayer - an open field vocabulary keeps the cases
 * readable; capabilityResolution.test.ts covers the capability-specific
 * parsing). Pinned here: the wholesale-winner default, pass-through
 * transparency, `_inheritable` (true and lists), `_inherit_from` in all four
 * forms, the barrier, the exclusive list's literal-fields/nearest-first/
 * bypass rules, markings riding with fields, the receiver re-marking ban,
 * and every directive diagnostic ruling (O1-O4).
 */
import * as assert from "node:assert";
import { resolveParameterLayer } from "../../../shared/config/parameterResolution";
import type { RecordDiagnostic, RecordDiagnosticKind } from "../../../shared/config/recordResolution";
import { INHERIT_FROM_DIRECTIVE, INHERITABLE_DIRECTIVE } from "../../../shared/config/recordResolution";

/** The resolved view as a plain record of values, for terse assertions. */
function valuesOf(id: string, records: Record<string, Record<string, unknown>>): Record<string, unknown> {
	const resolution = resolveParameterLayer(id, records);
	return Object.fromEntries([...resolution.fields].map(([name, field]) => [name, field.value]));
}

function diagnosticsOf(id: string, records: Record<string, Record<string, unknown>>): RecordDiagnostic[] {
	return [...resolveParameterLayer(id, records).diagnostics];
}

suite("shared/config recordResolution directive names", () => {
	test("the exported directive constants are the documented spellings", () => {
		assert.strictEqual(INHERITABLE_DIRECTIVE, "_inheritable");
		assert.strictEqual(INHERIT_FROM_DIRECTIVE, "_inherit_from");
		const kinds: readonly RecordDiagnosticKind[] = ["invalid-matcher", "invalid-directive", "unknown-inherit-key"];
		assert.strictEqual(kinds.length, 3, "the shape pin keeps the diagnostic vocabulary imported");
	});
});

suite("shared/config recordResolution defaults", () => {
	test("the most specific matching record wins wholesale; nothing leaks without directives", () => {
		const records = {
			"*": { temperature: 0.7, top_p: 0.9 },
			"gpt-5*": { temperature: 0.3 },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { temperature: 0.3 });
		assert.deepStrictEqual(valuesOf("claude-4", records), { temperature: 0.7, top_p: 0.9 });
	});

	test("nothing matching resolves to nothing", () => {
		const resolution = resolveParameterLayer("claude-4", { "gpt-5*": { temperature: 0.3 } });
		assert.strictEqual(resolution.fields.size, 0);
		assert.strictEqual(resolution.winnerKey, undefined);
	});

	test("_inheritable fields flow to a more specific silent record; unmarked fields stay put", () => {
		const records = {
			"*": { temperature: 0.7, top_p: 0.9, _inheritable: ["top_p"] },
			"gpt-5*": { max_tokens: 8192 },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { max_tokens: 8192, top_p: 0.9 });
	});

	test("the nearest inheritable value wins per field; own fields always beat inherited ones", () => {
		const records = {
			"*": { temperature: 0.7, _inheritable: true },
			"gpt*": { temperature: 0.5, _inheritable: true },
			"gpt-5*": { temperature: 0.3 },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { temperature: 0.3 });
		const silent = {
			"*": { temperature: 0.7, _inheritable: true },
			"gpt*": { temperature: 0.5, _inheritable: true },
			"gpt-5*": { max_tokens: 1 },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", silent), { max_tokens: 1, temperature: 0.5 });
	});

	test("a silent record is transparent: inheritable fields cross it with their source markings", () => {
		const records = {
			"*": { top_p: 0.9, _inheritable: true },
			"claude*": { max_tokens: 4000 },
			"claude-4": { temperature: 1.0 },
		};
		const resolution = resolveParameterLayer("claude-4", records);
		assert.strictEqual(resolution.fields.get("top_p")?.value, 0.9);
		assert.strictEqual(resolution.fields.get("top_p")?.sourceKey, "*", "the field still names its writer");
		assert.strictEqual(resolution.fields.get("top_p")?.inheritable, true, "the marking rides");
		assert.strictEqual(resolution.fields.get("max_tokens"), undefined, "the silent record's own field stays put");
	});
});

suite("shared/config recordResolution _inherit_from", () => {
	const base = {
		"*": { temperature: 0.7, top_p: 0.9, _inheritable: true },
		"gpt-5*": { temperature: 0.3, _inheritable: true, _inherit_from: false },
	};

	test("false is the barrier: the record shields itself and everything more specific", () => {
		assert.deepStrictEqual(valuesOf("gpt-5", base), { temperature: 0.3 });
		const withLeaf = { ...base, "gpt-5.6": { max_tokens: 8192 } };
		assert.deepStrictEqual(valuesOf("gpt-5.6", withLeaf), {
			max_tokens: 8192,
			temperature: 0.3,
		});
	});

	test("the empty list behaves exactly like false, barrier included", () => {
		const records = {
			"*": { top_p: 0.9, _inheritable: true },
			"gpt-5*": { temperature: 0.3, _inheritable: true, _inherit_from: [] },
			"gpt-5.6": {},
		};
		assert.deepStrictEqual(valuesOf("gpt-5", records), { temperature: 0.3 });
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { temperature: 0.3 });
	});

	test("true inherits the next broader match's full resolved view, inheritable or not", () => {
		const records = {
			"*": { top_p: 0.9 },
			"gpt-5*": { temperature: 0.3, _inherit_from: true },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { top_p: 0.9, temperature: 0.3 });
	});

	test("true reads one resolved view deep: it does not see past a barrier", () => {
		const records = {
			"*": { top_p: 0.9, _inheritable: true },
			"gpt*": { temperature: 0.5, _inherit_from: false },
			"gpt-5*": { _inherit_from: true },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { temperature: 0.5 }, "the barrier's view is its own fields");
	});

	test("a list inherits exactly the named records' literal fields and bypasses barriers", () => {
		const records = {
			"*": { temperature: 0.7, top_p: 0.9, _inheritable: true },
			"gpt-5*": { temperature: 0.3, _inheritable: true, _inherit_from: false },
			"gpt-5.6": { max_tokens: 8192, _inherit_from: ["gpt-5*", "*"] },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), {
			max_tokens: 8192,
			temperature: 0.3,
			top_p: 0.9,
		});
	});

	test("naming only the barrier record refuses the catch-all (the user-quiz case)", () => {
		const records = {
			"*": { temperature: 0.7, top_p: 0.9, _inheritable: true },
			"gpt-5*": { temperature: 0.3, _inheritable: true, _inherit_from: false },
			"gpt-5.6": { max_tokens: 8192, _inherit_from: ["gpt-5*"] },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { max_tokens: 8192, temperature: 0.3 });
	});

	test("named records contribute LITERAL fields only: their own inheritance never carries over", () => {
		const records = {
			"*": { top_p: 0.9, _inheritable: true },
			"gpt*": { temperature: 0.5, _inherit_from: true },
			"gpt-5*": { _inherit_from: ["gpt*"] },
		};
		assert.deepStrictEqual(
			valuesOf("gpt-5.6", records),
			{ temperature: 0.5 },
			"no transitivity through the named record"
		);
	});

	test("list order does not matter and duplicates add nothing: specificity decides per field", () => {
		const records = {
			"*": { temperature: 0.7, seed: 1 },
			"gpt*": { temperature: 0.5 },
			"gpt-5*": { _inherit_from: ["*", "gpt*", "*"] },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { temperature: 0.5, seed: 1 });
		const reversed = {
			"*": { temperature: 0.7, seed: 1 },
			"gpt*": { temperature: 0.5 },
			"gpt-5*": { _inherit_from: ["gpt*", "*"] },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", reversed), { temperature: 0.5, seed: 1 });
	});

	test("a named record must match the model to contribute (O3): non-matching names are inert, silently", () => {
		const records = {
			"claude*": { temperature: 1.0 },
			"gpt-5*": { max_tokens: 1, _inherit_from: ["claude*"] },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { max_tokens: 1 });
		assert.deepStrictEqual(diagnosticsOf("gpt-5.6", records), [], "a matching-elsewhere record is not an error");
	});

	test("naming a key that does not exist is diagnosed and the rest of the list still applies", () => {
		const records = {
			"*": { top_p: 0.9 },
			"gpt-5*": { _inherit_from: ["no-such-key", "*"] },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { top_p: 0.9 });
		assert.deepStrictEqual(diagnosticsOf("gpt-5.6", records), [
			{ kind: "unknown-inherit-key", recordKey: "gpt-5*", key: "no-such-key" },
		]);
	});

	test("a record naming itself is a no-op", () => {
		const records = { "gpt-5*": { temperature: 0.3, _inherit_from: ["gpt-5*"] } };
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { temperature: 0.3 });
	});

	test('false on the "*" record changes nothing for receiving; its _inheritable still gives', () => {
		const records = {
			"*": { top_p: 0.9, _inheritable: true, _inherit_from: false },
			"gpt-5*": { temperature: 0.3 },
		};
		assert.deepStrictEqual(valuesOf("claude-4", records), { top_p: 0.9 });
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { temperature: 0.3, top_p: 0.9 });
	});
});

suite("shared/config recordResolution markings and diagnostics", () => {
	test("an inherited field keeps its source's _force marking; receivers cannot re-mark", () => {
		const records = {
			"*": { temperature: 1, top_p: 0.9, _force: ["temperature"], _inheritable: true },
			// O2: a directive list may only name fields present in its own
			// record - the receiver's attempt to force the inherited top_p is a
			// diagnostic, and the inherited temperature stays forced.
			"gpt-5*": { seed: 3, _force: ["top_p"] },
		};
		const resolution = resolveParameterLayer("gpt-5.6", records);
		assert.strictEqual(resolution.fields.get("temperature")?.forced, true, "the source's marking rides");
		assert.strictEqual(resolution.fields.get("top_p")?.forced, false, "the receiver cannot re-mark");
		assert.deepStrictEqual(resolution.diagnostics, [{ kind: "invalid-directive", recordKey: "gpt-5*", key: "_force" }]);
	});

	test("directives themselves never flow: a broader _inherit_from or _inheritable is not inherited", () => {
		const records = {
			"*": { top_p: 0.9, _inheritable: true },
			"gpt*": { temperature: 0.5, _inheritable: true, _inherit_from: false },
			// gpt-5* inherits gpt*'s FIELDS (with markings) but not its barrier:
			// nothing here says _inherit_from, so the default flow applies to it.
			"gpt-5*": { seed: 3 },
		};
		const resolution = resolveParameterLayer("gpt-5.6", records);
		assert.strictEqual(resolution.fields.get("temperature")?.value, 0.5);
		assert.strictEqual(resolution.fields.get("top_p"), undefined, "the barrier still cut the catch-all off");
	});

	test("an _inheritable list naming an absent field is diagnosed and skipped; the rest applies (O2)", () => {
		const records = { "*": { temperature: 0.7, _inheritable: ["temperature", "absent"] }, "gpt-5*": {} };
		const resolution = resolveParameterLayer("gpt-5.6", records);
		assert.strictEqual(resolution.fields.get("temperature")?.value, 0.7);
		assert.deepStrictEqual(resolution.diagnostics, [
			{ kind: "invalid-directive", recordKey: "*", key: "_inheritable" },
		]);
	});

	test("a known directive of the other record type is diagnosed and ignored (O4)", () => {
		const records = { "gpt-5*": { temperature: 0.3, _fallback: true, _openrouter_model: "x/y", _declare: true } };
		const diagnostics = diagnosticsOf("gpt-5.6", records);
		assert.deepStrictEqual(diagnostics.map((d) => `${d.kind}:${d.key}`).sort(), [
			"wrong-record-type:_declare",
			"wrong-record-type:_fallback",
			"wrong-record-type:_openrouter_model",
		]);
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { temperature: 0.3 });
	});

	test("truly unknown underscore keys stay silently ignored (O4)", () => {
		const records = { "gpt-5*": { temperature: 0.3, _future_directive: { anything: 1 } } };
		assert.deepStrictEqual(diagnosticsOf("gpt-5.6", records), []);
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { temperature: 0.3 });
	});

	test("a malformed _inherit_from value is diagnosed and treated as absent", () => {
		const records = {
			"*": { top_p: 0.9, _inheritable: true },
			"gpt-5*": { temperature: 0.3, _inherit_from: "yes" },
		};
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { temperature: 0.3, top_p: 0.9 });
		assert.deepStrictEqual(diagnosticsOf("gpt-5.6", records), [
			{ kind: "invalid-directive", recordKey: "gpt-5*", key: "_inherit_from" },
		]);
	});

	test("_force: false and _inheritable: false are explicit no-ops, never diagnostics", () => {
		const resolution = resolveParameterLayer("m1", { m1: { temperature: 0.5, _force: false, _inheritable: false } });
		assert.strictEqual(resolution.fields.get("temperature")?.forced, false);
		assert.strictEqual(resolution.fields.get("temperature")?.inheritable, false);
		assert.deepStrictEqual([...resolution.diagnostics], []);
	});

	test("identical diagnostics deduplicate; distinct keys in one directive do not", () => {
		const records = {
			"gpt-5*": { temperature: 0.3, _inherit_from: ["ghost", "ghost", "phantom"] },
		};
		assert.deepStrictEqual(diagnosticsOf("gpt-5.6", records), [
			{ kind: "unknown-inherit-key", recordKey: "gpt-5*", key: "ghost" },
			{ kind: "unknown-inherit-key", recordKey: "gpt-5*", key: "phantom" },
		]);
		// One record parsed for the chain AND as a named source reports once.
		const shared = {
			"*": { seed: 1, _force: [42] },
			"gpt-5*": { temperature: 0.3, _inherit_from: ["*"] },
		};
		assert.deepStrictEqual(diagnosticsOf("gpt-5.6", shared), [
			{ kind: "invalid-directive", recordKey: "*", key: "_force" },
		]);
	});

	test("an invalid matcher key is diagnosed once and its record never matches (O1)", () => {
		const records = { "gpt*5": { temperature: 1 }, "gpt-5*": { temperature: 0.3 } };
		assert.deepStrictEqual(valuesOf("gpt-5.6", records), { temperature: 0.3 });
		assert.deepStrictEqual(diagnosticsOf("gpt-5.6", records), [
			{ kind: "invalid-matcher", recordKey: "gpt*5", key: "gpt*5" },
		]);
	});
});
