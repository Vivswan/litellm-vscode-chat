/**
 * The provenance vocabulary's two registers cannot drift: every cell shape in the registry below runs through BOTH -
 * the badge register the inspectors render (Provenance + CellMarks) and the diagnostics table's compact-phrase
 * register - and the words must agree, mark for mark and key for key. At compile time a new capability level fails the
 * total Record, and a wire provenance field missing from the vocabulary types fails the satisfies checks; a new cell
 * shape still needs a row here by hand.
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
 * The wire cells' provenance-bearing fields, total both ways, so a new wire field cannot ship until the vocabulary
 * types carry it. The Omit list is the one escape hatch, for a wire field that is genuinely not provenance (a display
 * hint, say).
 */
type ParamCellFields = Omit<ResolvedParamCell, "name" | "valueText">;
type CapCellFields = Omit<ResolvedCapCell, "name" | "valueText">;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

true satisfies Exact<keyof ParamCellFields, keyof ParameterCellProvenance>;
true satisfies Exact<keyof CapCellFields, keyof CapabilityCellProvenance>;

function paramCellAsVocabularyInput(cell: ParamCellFields): ParameterCellProvenance {
	return cell;
}
function capCellAsVocabularyInput(cell: CapCellFields): CapabilityCellProvenance {
	return cell;
}

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

const CAP_SHAPES: readonly CapCellFields[] = Object.entries(CAPABILITY_LEVEL_KEYS).flatMap(([level, key]) => [
	{ level: level as CapabilityLevel, key },
	{ level: level as CapabilityLevel, key, inheritedBy: "gpt-4.1" },
]);

const PARAM_SHAPES: readonly ParamCellFields[] = (["entry", "global"] as const).flatMap((layer) =>
	[{}, { forced: true as const }, { inheritedBy: "gpt-4*" }, { forced: true as const, inheritedBy: "gpt-4*" }].map(
		(marks) => ({ layer, key: "gpt*", ...marks })
	)
);

/**
 * The badge register's own words for a cell, read off the rendered DOM exactly as the inspectors compose it, and
 * re-joined with the phrase register's separators. Tip sentences render outside .prov and .mark, so they never leak
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
});

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
		// Both resolvers emit inheritedBy only when the layer's winning record inherited the field, and always name
		// that winner - the badge already names the source record, so the mark's key is the one the badge lacks.
		expect(capabilityProvenancePhrase({ level: "global", key: "gpt*", inheritedBy: "gpt-4.1" })).toBe(
			"settings gpt*; inherited by gpt-4.1"
		);
		expect(capabilityProvenancePhrase({ level: "entry-fallback", key: "gpt-4", inheritedBy: "gpt-4.1" })).toBe(
			"entry gpt-4; fallback, inherited by gpt-4.1"
		);
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
