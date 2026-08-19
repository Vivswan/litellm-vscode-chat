/**
 * The provenance vocabulary's two registers cannot drift: every cell shape in
 * the registry below runs through BOTH - the badge register the inspectors
 * render (Provenance + CellMarks) and the diagnostics table's compact-phrase
 * register - and the words must agree, mark for mark and key for key. The
 * guard is fail-closed at both ends: a new capability level fails the total
 * Record at compile time, a new provenance-bearing field on the wire cells
 * fails the satisfies checks, and a field no registry shape exercises fails
 * the coverage test, so a new cell shape cannot ship without a row here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ResolvedCapCell, ResolvedParamCell } from "../../../../dashboard/viewModels";
import type { CapabilityLevel } from "../../../../shared/config/capabilityResolution";
import type {
	CapabilityCellProvenance,
	CellMark,
	ParameterCellProvenance,
	ProvenanceView,
} from "../../../../webview/dashboard/provenance";
import {
	CellMarks,
	capabilityCellProvenance,
	capabilityProvenancePhrase,
	Provenance,
	parameterCellProvenance,
	parameterProvenancePhrase,
} from "../../../../webview/dashboard/provenance";
import { cleanup, mount } from "../harness";

afterEach(cleanup);

/**
 * The wire cells' provenance-bearing fields, total both ways: a field added to
 * ResolvedParamCell/ResolvedCapCell fails the satisfies (missing key), and a
 * stale name here fails it too (excess key). The Exact checks then pin the
 * vocabulary input types to the same key sets in BOTH directions, and the
 * conversion functions prove the field types assignable, so a new wire field
 * cannot ship until the vocabulary types carry it - at which point the
 * coverage test below refuses to pass without a registry shape exercising it.
 * The Omit list is the escape hatch and the only one: a wire field that is
 * genuinely not provenance (a display hint, say) belongs in it, deliberately.
 */
type ParamCellFields = Omit<ResolvedParamCell, "name" | "valueText">;
type CapCellFields = Omit<ResolvedCapCell, "name" | "valueText">;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const PARAM_CELL_FIELDS = { layer: true, key: true, forced: true, inheritedBy: true } as const satisfies Record<
	keyof ParamCellFields,
	true
>;
const CAP_CELL_FIELDS = { level: true, key: true, inheritedBy: true } as const satisfies Record<
	keyof CapCellFields,
	true
>;
const paramKeySetsAgree: Exact<keyof ParamCellFields, keyof ParameterCellProvenance> = true;
const capKeySetsAgree: Exact<keyof CapCellFields, keyof CapabilityCellProvenance> = true;

function paramCellAsVocabularyInput(cell: ParamCellFields): ParameterCellProvenance {
	return cell;
}
function capCellAsVocabularyInput(cell: CapCellFields): CapabilityCellProvenance {
	return cell;
}

/** Every capability level's registry key, total by type: a new level fails compilation here. */
const CAPABILITY_LEVEL_KEYS: Record<CapabilityLevel, string | undefined> = {
	entry: "gpt-4",
	global: "gpt*",
	"entry-fallback": "gpt-4",
	"global-fallback": "*",
	server: undefined,
	directive: "openai/gpt-4o",
	catalog: "openai/gpt-4o",
	derived: undefined,
	floor: undefined,
};

/** The registry: every level, bare and wearing the inherited mark, in the wire cell's own type. */
const CAP_SHAPES: readonly CapCellFields[] = Object.entries(CAPABILITY_LEVEL_KEYS).flatMap(([level, key]) => [
	{ level: level as CapabilityLevel, key },
	{ level: level as CapabilityLevel, key, inheritedBy: "gpt-4.1" },
]);

/** The registry: both layers crossed with every mark combination, in the wire cell's own type. */
const PARAM_SHAPES: readonly ParamCellFields[] = (["entry", "global"] as const).flatMap((layer) =>
	[{}, { forced: true as const }, { inheritedBy: "gpt-4*" }, { forced: true as const, inheritedBy: "gpt-4*" }].map(
		(marks) => ({ layer, key: "gpt*", ...marks })
	)
);

/**
 * The badge register's own words for a cell, read off the rendered DOM exactly
 * as the inspectors compose it, and re-joined with the phrase register's
 * separators. Tip sentences render outside .prov and .mark, so they never leak
 * into the comparison - the registers share words, not tips.
 */
function renderedPhrase(source: ProvenanceView, marks: readonly CellMark[]): string {
	const root = mount(
		<span>
			<Provenance source={source} /> <CellMarks marks={marks} />
		</span>
	);
	const normalize = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
	const badge = normalize(root.querySelector(".prov")?.textContent);
	const markTexts = Array.from(root.querySelectorAll(".mark")).map((el) => normalize(el.textContent));
	cleanup();
	return markTexts.length > 0 ? `${badge}; ${markTexts.join(", ")}` : badge;
}

describe("webview/dashboard/provenance register agreement", () => {
	test("every capability cell shape speaks the same words in both registers", () => {
		for (const cell of CAP_SHAPES) {
			const { source, marks } = capabilityCellProvenance(cell);
			expect(capabilityProvenancePhrase(capCellAsVocabularyInput(cell))).toBe(renderedPhrase(source, marks));
		}
	});

	test("every parameter cell shape speaks the same words in both registers", () => {
		for (const cell of PARAM_SHAPES) {
			const { source, marks } = parameterCellProvenance(cell);
			expect(parameterProvenancePhrase(paramCellAsVocabularyInput(cell))).toBe(renderedPhrase(source, marks));
		}
	});

	test("every provenance-bearing wire field is exercised by a registry shape", () => {
		expect(paramKeySetsAgree).toBe(true);
		expect(capKeySetsAgree).toBe(true);
		const paramExercised = new Set(PARAM_SHAPES.flatMap((cell) => Object.keys(cell)));
		for (const field of Object.keys(PARAM_CELL_FIELDS)) {
			expect(paramExercised.has(field)).toBe(true);
		}
		const capExercised = new Set(CAP_SHAPES.flatMap((cell) => Object.keys(cell)));
		for (const field of Object.keys(CAP_CELL_FIELDS)) {
			expect(capExercised.has(field)).toBe(true);
		}
	});
});

/**
 * Every capability level's pinned phrase, total by type: a new CapabilityLevel
 * fails this Record before it can ship an unreviewed word.
 */
const CAPABILITY_PHRASES: Record<CapabilityLevel, string> = {
	entry: "entry gpt-4",
	global: "settings gpt*",
	"entry-fallback": "entry gpt-4; fallback",
	"global-fallback": "settings *; fallback",
	server: "server",
	directive: "OpenRouter openai/gpt-4o; _openrouter_model",
	catalog: "OpenRouter openai/gpt-4o; matched",
	derived: "derived",
	floor: "built-in default",
};

describe("webview/dashboard/provenance phrase register", () => {
	test("every capability level's compact phrase is pinned", () => {
		for (const [level, phrase] of Object.entries(CAPABILITY_PHRASES)) {
			const key = CAPABILITY_LEVEL_KEYS[level as CapabilityLevel];
			expect(capabilityProvenancePhrase({ level: level as CapabilityLevel, key })).toBe(phrase);
		}
	});

	test("an inherited value appends the inherited mark naming the winning record, never the badge's own key", () => {
		// Both resolvers emit inheritedBy only when the layer's winning record
		// inherited the field, and always name that winner - the badge already
		// names the source record, so the mark's key is the one the badge lacks.
		expect(capabilityProvenancePhrase({ level: "global", key: "gpt*", inheritedBy: "gpt-4.1" })).toBe(
			"settings gpt*; inherited by gpt-4.1"
		);
		expect(capabilityProvenancePhrase({ level: "entry-fallback", key: "gpt-4", inheritedBy: "gpt-4.1" })).toBe(
			"entry gpt-4; fallback, inherited by gpt-4.1"
		);
		// Absent means the winning record wrote the field itself: no mark.
		expect(capabilityProvenancePhrase({ level: "entry", key: "gpt-4" })).toBe("entry gpt-4");
	});

	test("parameter phrases speak the badge scopes and the editors' directive word, never 'forced'", () => {
		expect(parameterProvenancePhrase({ layer: "entry", key: "gpt-4*" })).toBe("entry gpt-4*");
		expect(parameterProvenancePhrase({ layer: "global", key: "*" })).toBe("settings *");
		expect(parameterProvenancePhrase({ layer: "entry", key: "gpt-4*", forced: true })).toBe("entry gpt-4*; force");
		expect(parameterProvenancePhrase({ layer: "global", key: "*", forced: true, inheritedBy: "gpt-4*" })).toBe(
			"settings *; force, inherited by gpt-4*"
		);
		expect(parameterProvenancePhrase({ layer: "global", key: "*", inheritedBy: "gpt-4*" })).toBe(
			"settings *; inherited by gpt-4*"
		);
	});
});
