/**
 * The provenance vocabulary's two registers speak the same words: the badge+mark
 * register (the inspectors) and the compact-phrase register (the diagnostics
 * resolved-models table) both derive from the one map in provenance.tsx, and these
 * pins hold every level's words - a panel re-minting a local literal for a level
 * word ("server-reported", "forced", bare "default") is the regression this guards.
 */
import { describe, expect, test } from "bun:test";
import type { CapabilityLevel } from "../../../../shared/config/capabilityResolution";
import {
	capabilityProvenance,
	capabilityProvenancePhrase,
	parameterProvenance,
	parameterProvenancePhrase,
} from "../../../../webview/dashboard/provenance";

/**
 * Every capability level's pinned phrase, total by type: a new CapabilityLevel
 * fails this Record before it can ship an unreviewed word.
 */
const CAPABILITY_PHRASES: Record<CapabilityLevel, { key?: string; phrase: string }> = {
	entry: { key: "gpt-4", phrase: "entry gpt-4" },
	global: { key: "gpt*", phrase: "settings gpt*" },
	"entry-fallback": { key: "gpt-4", phrase: "entry gpt-4; fallback" },
	"global-fallback": { key: "*", phrase: "settings *; fallback" },
	server: { phrase: "server" },
	directive: { key: "openai/gpt-4o", phrase: "OpenRouter openai/gpt-4o; _openrouter_model" },
	catalog: { key: "openai/gpt-4o", phrase: "OpenRouter openai/gpt-4o; matched" },
	derived: { phrase: "derived" },
	floor: { phrase: "built-in default" },
};

describe("webview/dashboard/provenance phrase register", () => {
	test("every capability level's compact phrase is pinned", () => {
		for (const [level, { key, phrase }] of Object.entries(CAPABILITY_PHRASES)) {
			expect(capabilityProvenancePhrase({ level: level as CapabilityLevel, key })).toBe(phrase);
		}
	});

	test("the phrase register renders the badge register's own words, level by level", () => {
		for (const [level, { key }] of Object.entries(CAPABILITY_PHRASES)) {
			const { source, mark } = capabilityProvenance(level as CapabilityLevel, key);
			const phrase = capabilityProvenancePhrase({ level: level as CapabilityLevel, key });
			expect(phrase.startsWith(source.scope)).toBe(true);
			if (source.recordKey !== undefined) {
				expect(phrase).toContain(source.recordKey);
			}
			if (mark !== undefined) {
				expect(phrase).toContain(mark.word);
			}
		}
	});

	test("an inherited value appends the inherited mark on presence, like the inspectors' badge register", () => {
		// Both resolvers set inheritedFrom only when the winning record
		// inherited the field, and always to the source record's own key
		// (source.key): presence IS the signal, so the equal shape - the only
		// shape production emits - must speak the mark.
		expect(capabilityProvenancePhrase({ level: "global", key: "gpt*", inheritedFrom: "gpt*" })).toBe(
			"settings gpt*; inherited from gpt*"
		);
		expect(capabilityProvenancePhrase({ level: "entry-fallback", key: "gpt-4", inheritedFrom: "gpt-4" })).toBe(
			"entry gpt-4; fallback, inherited from gpt-4"
		);
		// Absent means the winning record wrote the field itself: no mark.
		expect(capabilityProvenancePhrase({ level: "entry", key: "gpt-4" })).toBe("entry gpt-4");
	});

	test("parameter phrases speak the badge scopes and the editors' directive word, never 'forced'", () => {
		expect(parameterProvenancePhrase({ layer: "entry", key: "gpt-4*" })).toBe("entry gpt-4*");
		expect(parameterProvenancePhrase({ layer: "global", key: "*" })).toBe("settings *");
		expect(parameterProvenancePhrase({ layer: "entry", key: "gpt-4*", forced: true })).toBe("entry gpt-4*; force");
		expect(parameterProvenancePhrase({ layer: "global", key: "*", forced: true, inheritedFrom: "*" })).toBe(
			"settings *; force, inherited from *"
		);
		expect(parameterProvenancePhrase({ layer: "global", key: "*", inheritedFrom: "*" })).toBe(
			"settings *; inherited from *"
		);
	});

	test("the parameter badge and phrase share one scope word per layer", () => {
		for (const layer of ["entry", "global"] as const) {
			const badge = parameterProvenance({ layer, key: "k" });
			expect(parameterProvenancePhrase({ layer, key: "k" })).toBe(`${badge.scope} k`);
		}
	});
});
