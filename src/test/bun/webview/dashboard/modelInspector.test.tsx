/**
 * The merged model inspector: ONE slide-over per model row, sectioned Parameters / Capabilities / Pricing, fed by two
 * reads that ignore uncorrelated responses. A source renders as one compact badge, a beaten value inside a real <del>
 * behind a clipped "Overridden value", and nothing in the panel collapses.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { CapabilityLevel, EffectiveCapabilities } from "../../../../shared/config/capabilityResolution";
import { projectEffectiveParameters } from "../../../../shared/config/parameterResolution";
import { INHERIT_FROM_DIRECTIVE } from "../../../../shared/config/recordResolution";
import { App } from "../../../../webview/dashboard/app";
import type { ModelCapabilitiesResponse, ModelParametersResponse } from "../../../../webview/dashboard/modelInspector";
import { ModelInspector } from "../../../../webview/dashboard/modelInspector";
import { makeSettings } from "../../../dashboardSettingsFixture";
import { makeDeclaredServer, makeExternalServer, makeModel, makeState, statePush } from "../fixtures";
import {
	cleanup,
	fireClick,
	fireKeyDown,
	lastRequest,
	mount,
	postedRequests,
	pushToWebview,
	render,
	resetPosted,
	respondTo,
	textOf,
} from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

const model = makeModel({ id: "gpt-4o", rawId: "gpt-4o", name: "Omni", serverLabel: "Prod", scopeKey: "s0" });

/** One element's text with runs of whitespace collapsed; JSX separators and tips make raw text noisy. */
function normOf(root: ParentNode, selector: string): string {
	return textOf(root, selector).replace(/\s+/g, " ");
}

/** The panel's section titles in document order; every section names itself. */
function sectionTitles(root: ParentNode): string[] {
	return [...root.querySelectorAll(".model-inspector .section-title")].map((title) => (title.textContent ?? "").trim());
}

/**
 * Mount, capture the inspector's own readModelParameters requestId, then rerender with the correlated response. The
 * projection is computed by the SAME shared function the extension answers with; the capability feed stays unanswered,
 * so the params pins must hold regardless of the other section's state.
 */
function mountParamsAnswered(options: {
	globalParameters?: Record<string, Record<string, unknown>>;
	entryParameters?: Record<string, Record<string, unknown>>;
	entryLabel?: string;
	modelOverrides?: Parameters<typeof makeModel>[0];
	chains?: ModelParametersResponse["chains"];
	onClose?: () => void;
}) {
	const inspected = makeModel({ ...model, ...options.modelOverrides });
	const onClose = options.onClose ?? (() => {});
	const container = mount(<ModelInspector currencySymbol="$" model={inspected} stateSeq={0} onClose={onClose} />);
	const request = lastRequest("readModelParameters");
	expect(request.payload.scopeKey).toBe(inspected.scopeKey);
	expect(request.payload.rawId).toBe(inspected.rawId);
	const projection = projectEffectiveParameters({
		rawModelId: inspected.rawId,
		globalParameters: options.globalParameters ?? {},
		entry:
			options.entryParameters === undefined
				? undefined
				: { label: options.entryLabel ?? "Prod", parameters: options.entryParameters },
		maxOutputTokens: inspected.maxOutputTokens,
		outputLimitDeclared: inspected.outputLimitDeclared,
	});
	respondTo(request, { projection, chains: options.chains });
	return container;
}

/** A total EffectiveCapabilities fixture: floor everywhere, overridable per field. */
function makeCapabilities(overrides: Partial<EffectiveCapabilities> = {}): EffectiveCapabilities {
	return {
		fields: {
			context_length: { value: 128000, level: "floor", shadowed: [] },
			max_input_tokens: { value: 112000, level: "derived", shadowed: [] },
			max_output_tokens: { value: 16000, level: "floor", shadowed: [] },
			supports_function_calling: { value: true, level: "floor", shadowed: [] },
			supports_vision: { value: false, level: "floor", shadowed: [] },
			supports_reasoning: { value: false, level: "floor", shadowed: [] },
			supports_audio_input: { value: false, level: "floor", shadowed: [] },
		},
		outputLimitSource: "defaults",
		diagnostics: [],
		...overrides,
	};
}

/**
 * Mount the inspector and answer its readModelCapabilities post; the
 * parameters feed stays unanswered - the caps pins must hold on their own.
 */
function mountCapsAnswered(
	capabilities: EffectiveCapabilities | undefined,
	modelOverrides: Parameters<typeof makeModel>[0] = {},
	chains?: ModelCapabilitiesResponse["chains"]
): HTMLElement {
	const inspected = makeModel(modelOverrides);
	const container = mount(<ModelInspector currencySymbol="$" model={inspected} stateSeq={0} onClose={() => {}} />);
	const request = lastRequest("readModelCapabilities");
	expect(request.payload.scopeKey).toBe(inspected.scopeKey);
	expect(request.payload.rawId).toBe(inspected.rawId);
	respondTo(request, { capabilities, chains });
	return container;
}

test("the models list row carries ONE quiet Inspect action that opens the merged dialog and posts both reads", () => {
	mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()], models: [model] })));
	const row = document.querySelector("li.model-row") as HTMLElement;
	expect(row.querySelectorAll("button.params-action").length).toBe(1);
	const action = document.querySelector("button[aria-label='Inspect Omni on Prod']");
	expect(action).not.toBeNull();
	expect((action?.textContent ?? "").trim()).toBe("Inspect");
	expect(document.querySelector("[role='dialog']")).toBeNull();

	fireClick(action as HTMLButtonElement);
	const dialog = document.querySelector("[role='dialog']") as HTMLElement;
	expect(dialog).not.toBeNull();
	expect(textOf(dialog, "#model-inspector-title")).toContain("Omni");
	// Opening posts BOTH reads for exactly the clicked row; each section
	// renders when its own answer lands.
	for (const method of ["readModelParameters", "readModelCapabilities"] as const) {
		const read = postedRequests(method).at(-1);
		expect(read).not.toBeUndefined();
		expect(read?.payload.scopeKey).toBe("s0");
		expect(read?.payload.rawId).toBe("gpt-4o");
	}
	expect(dialog.textContent).toContain("Resolving parameters...");
	expect(dialog.textContent).toContain("Resolving capabilities...");

	// The X closes it again (SlideOver's close request maps straight to close;
	// a read-only view has nothing to confirm).
	fireClick(dialog.querySelector("button[aria-label='Close']") as HTMLButtonElement);
	expect(document.querySelector("[role='dialog']")).toBeNull();
});

test("the panel reads as one document: Parameters, Capabilities, and Pricing section headers in order", () => {
	const root = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				input_cost_per_token: { value: 0.000005, level: "server", shadowed: [] },
			},
		})
	);
	expect(sectionTitles(root)).toEqual(["Parameters", "Capabilities", "Pricing"]);
	// The unit moves out of the title and onto the header line's summary slot.
	expect(textOf(root, "#inspector-pricing-section .section-meta")).toBe("$ per million tokens");
	// The Diagnostics jump anchors exist on the two addressable sections.
	expect(root.querySelector("#inspector-params-section")).not.toBeNull();
	expect(root.querySelector("#inspector-caps-section")).not.toBeNull();
});

test("without pricing fields the Pricing section states the absence instead of vanishing", () => {
	// Absence is a designed state: a reader who opens the panel to check what a
	// model costs gets an answer, not a missing section - and no invented zero.
	const root = mountCapsAnswered(makeCapabilities());
	expect(sectionTitles(root)).toEqual(["Parameters", "Capabilities", "Pricing"]);
	const pricing = root.querySelector("#inspector-pricing-section") as HTMLElement;
	expect(textOf(pricing, ".absent")).toContain("No prices declared for this model");
	expect(pricing.querySelector("table.resolution")).toBeNull();
	expect(pricing.textContent).not.toContain("$0");
});

test("the Parameters section leads with the answer: table, supported params, max_tokens, machinery, record path", () => {
	// The approved hierarchy: answers first, machinery last.
	const container = mount(<ModelInspector currencySymbol="$" model={model} stateSeq={0} onClose={() => {}} />);
	respondTo(lastRequest("readModelParameters"), {
		projection: projectEffectiveParameters({
			rawModelId: model.rawId,
			// The invalid matcher key produces a diagnostics block, so the
			// order pin covers its position too (right after the table).
			globalParameters: { "gpt-4*": { temperature: 0.2 }, "gpt*4o": { top_p: 0.5 } },
			maxOutputTokens: model.maxOutputTokens,
			outputLimitDeclared: model.outputLimitDeclared,
		}),
		chains: [
			{
				layer: "global",
				links: [
					{ key: "*", barrier: false },
					{ key: "gpt-4*", barrier: false },
				],
			},
		],
	});
	respondTo(lastRequest("readModelCapabilities"), {
		capabilities: makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				supported_openai_params: { value: ["temperature", "top_p"], level: "server", shadowed: [] },
			},
		}),
	});
	const section = container.querySelector("#inspector-params-section") as HTMLElement;
	expect(section).not.toBeNull();
	// querySelectorAll returns document order: classify each major block and
	// pin the whole reading sequence.
	const blocks = [
		...section.querySelectorAll(
			"table.resolution, .record-problems, .supported-params, .max-tokens, .inspector-notes, .record-chain"
		),
	].map((element) => {
		if (element.matches(".record-chain")) {
			return "record-path";
		}
		if (element.matches(".record-problems")) {
			return "diagnostics";
		}
		if (element.matches(".max-tokens")) {
			return "max-tokens";
		}
		if (element.matches(".inspector-notes")) {
			return "notes";
		}
		return element.matches(".supported-params") ? "supported-params" : "effective-table";
	});
	expect(blocks).toEqual(["effective-table", "diagnostics", "supported-params", "max-tokens", "notes", "record-path"]);
	// The section names itself through its heading, which is where the
	// Diagnostics jump lands.
	expect(section.getAttribute("aria-labelledby")).toBe("inspector-params-title");
	expect(section.querySelector(".section-head h4#inspector-params-title")).not.toBeNull();
});

test("both section header bands carry their Configure action, right-aligned in the band", () => {
	const root = mount(
		<ModelInspector currencySymbol="$" model={model} stateSeq={0} onClose={() => {}} onEditRecord={() => {}} />
	);
	const actionText = (titleId: string): string | undefined => {
		const head = root.querySelector(`.section-head:has(#${titleId})`);
		return head?.querySelector("button.section-action")?.textContent ?? undefined;
	};
	expect(actionText("inspector-params-title")).toBe("Configure parameters for this model");
	expect(actionText("inspector-caps-title")).toBe("Configure capabilities for this model");
});

test("the record-path figure closes its section in the open: nothing in the panel collapses", () => {
	const root = mountParamsAnswered({
		globalParameters: { "gpt-4*": { temperature: 0.2 } },
		chains: [
			{
				layer: "global",
				links: [
					{ key: "*", barrier: false },
					{ key: "gpt-4*", barrier: false },
				],
			},
		],
	});
	const section = root.querySelector("#inspector-params-section") as HTMLElement;
	const chain = section.querySelector(".record-chain");
	expect(chain).not.toBeNull();
	expect(chain?.textContent).toContain("Record path");
	expect(chain?.textContent).toContain("gpt-4*");
	// A reader who opened the panel has already asked for it: no disclosure
	// anywhere in the overlay, so no state can hide the machinery.
	expect(root.querySelector("details")).toBeNull();
});

test("a state push leaves the record path on screen instead of hiding it under the reader", () => {
	// A state push orphans the answers (fresh requestIds), so the figure
	// unmounts until the new answer lands; what comes back must be the same
	// visible figure, never a re-collapsed one.
	const chains = [
		{
			layer: "global" as const,
			links: [
				{ key: "*", barrier: false },
				{ key: "gpt-4*", barrier: false },
			],
		},
	];
	const props = { model, onClose: () => {} };
	const container = mount(<ModelInspector currencySymbol="$" {...props} stateSeq={0} />);
	const answer = () => {
		respondTo(lastRequest("readModelParameters"), {
			projection: projectEffectiveParameters({
				rawModelId: model.rawId,
				globalParameters: { "gpt-4*": { temperature: 0.2 } },
				maxOutputTokens: model.maxOutputTokens,
				outputLimitDeclared: model.outputLimitDeclared,
			}),
			chains,
		});
	};
	answer();
	expect(container.querySelector(".record-chain")).not.toBeNull();

	// The push: readiness drops (a re-request orphans the answer, so the figure
	// may unmount), then the fresh answer lands.
	void act(() => {
		render(<ModelInspector currencySymbol="$" {...props} stateSeq={1} />, container);
	});
	answer();
	expect(container.querySelector(".record-chain")).not.toBeNull();
	expect(container.querySelector("details")).toBeNull();
});

test("without a chain story the Parameters section renders no record path at all", () => {
	// A single-link chain (or none) tells no inheritance story; a figure with
	// one key would promise detail it cannot show. (The caps feed stays
	// unanswered here; the caps section's own pin is above.)
	const root = mountParamsAnswered({ globalParameters: { "gpt-4o": { temperature: 0.2 } } });
	expect(root.querySelector(".record-chain")).toBeNull();
});

test("the Capabilities section closes with problems, notes, then its record path", () => {
	const root = mountCapsAnswered(
		makeCapabilities({
			diagnostics: [
				{ kind: "unrecognized-key", key: "supports_web_search", layer: "global", recordKey: "gpt-4" },
				{ kind: "invalid-value", key: "context_length", layer: "entry", recordKey: "gpt-4" },
			],
		}),
		{},
		[
			{
				layer: "global",
				links: [
					{ key: "*", barrier: false },
					{ key: "gpt-4*", barrier: false },
				],
			},
		]
	);
	const section = root.querySelector("#inspector-caps-section") as HTMLElement;
	expect(section.querySelector(".record-chain")).not.toBeNull();
	const blocks = [...section.querySelectorAll(".output-limit, .record-problems, .record-chain")].map((element) => {
		if (element.matches(".record-chain")) {
			return "record-path";
		}
		if (element.matches(".record-notes")) {
			return "notes";
		}
		return element.matches(".record-problems") ? "problems" : "output-limit";
	});
	expect(blocks).toEqual(["output-limit", "problems", "notes", "record-path"]);
});

test("the record path's last jump is the trap's boundary: Tab wraps there, back to Close", () => {
	// The always-open figure's chain jumps are ordinary trap members, and this fixture ends the panel there: the last
	// jump is the last tabbable, so the trap wraps at it and Shift+Tab returns to it from the top.
	const inspected = makeModel();
	const container = mount(
		<ModelInspector
			currencySymbol="$"
			model={inspected}
			stateSeq={0}
			onClose={() => {}}
			onEditRecord={() => {}}
			onEditEntry={() => {}}
		/>
	);
	expect(container).not.toBeNull();
	respondTo(lastRequest("readModelCapabilities"), {
		capabilities: makeCapabilities(),
		chains: [
			{
				layer: "global",
				links: [
					{ key: "*", barrier: false },
					{ key: "gpt-4*", barrier: false },
				],
			},
		],
	});
	const panel = document.querySelector(".slide-over") as HTMLElement;
	const jumps = [...panel.querySelectorAll<HTMLElement>("button.chain-key")];
	expect(jumps.length).toBeGreaterThan(0);
	const last = jumps[jumps.length - 1] as HTMLElement;
	const fireTab = (element: HTMLElement, shiftKey: boolean) => {
		void act(() => {
			element.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
		});
	};
	last.focus();
	fireTab(last, false);
	expect((document.activeElement as HTMLElement | null)?.getAttribute("aria-label")).toBe("Close");
	fireTab(document.activeElement as HTMLElement, true);
	expect(document.activeElement).toBe(last);
});

test("a stateSeq bump re-requests BOTH feeds, so an open inspector follows configuration edits", () => {
	const container = mount(<ModelInspector currencySymbol="$" model={model} stateSeq={0} onClose={() => {}} />);
	expect(postedRequests("readModelParameters")).toHaveLength(1);
	expect(postedRequests("readModelCapabilities")).toHaveLength(1);

	// The same tree re-rendered with a bumped stateSeq (a state push landed):
	// the inspector must ask again instead of trusting its pre-edit answers.
	void act(() => {
		render(<ModelInspector currencySymbol="$" model={model} stateSeq={1} onClose={() => {}} />, container);
	});
	for (const method of ["readModelParameters", "readModelCapabilities"] as const) {
		const requests = postedRequests(method);
		expect(requests).toHaveLength(2);
		// A fresh correlation id per request, so the first answer cannot satisfy the second ask.
		expect(requests[0]?.id).not.toBe(requests[1]?.id);
	}
});

test("a params response for another request id is ignored; the loading note stays", () => {
	const root = mount(<ModelInspector currencySymbol="$" model={model} stateSeq={0} onClose={() => {}} />);
	pushToWebview({
		kind: "response",
		id: "someone-elses",
		method: "readModelParameters",
		payload: {
			projection: projectEffectiveParameters({
				rawModelId: model.rawId,
				globalParameters: { "gpt-4*": { temperature: 0.2 } },
				maxOutputTokens: model.maxOutputTokens,
				outputLimitDeclared: model.outputLimitDeclared,
			}),
		},
	});
	expect(root.textContent).toContain("Resolving parameters...");
	expect(root.querySelector("table.resolution")).toBeNull();
});

test("a caps response for another request id is ignored; only the correlated one renders", () => {
	const root = mount(<ModelInspector currencySymbol="$" model={makeModel()} stateSeq={0} onClose={() => {}} />);
	pushToWebview({
		kind: "response",
		id: "someone-elses",
		method: "readModelCapabilities",
		payload: { capabilities: makeCapabilities() },
	});
	expect(root.textContent).toContain("Resolving capabilities...");
	expect(root.querySelector("table.resolution")).toBeNull();
});

test("a projection-less params response says the state moved on instead of inventing values", () => {
	const container = mount(<ModelInspector currencySymbol="$" model={model} stateSeq={0} onClose={() => {}} />);
	respondTo(lastRequest("readModelParameters"), {});
	expect(container.textContent).toContain("The model list changed");
	expect(container.querySelector("table.resolution")).toBeNull();
});

test("the header states the raw ID and the server label", () => {
	const root = mountParamsAnswered({});
	expect(textOf(root, ".inspector-identity")).toBe("gpt-4o on Prod");
	expect(root.textContent).toContain("Always sent");
});

test("a global match renders as a sent row sourced to the settings layer and its winning key", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { temperature: 0.2 } } });
	const row = root.querySelector("table.resolution tbody tr") as HTMLElement;
	const cells = Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").trim());
	// The source is a badge - scope then winning key - not a sentence.
	expect(cells).toEqual(["temperature", "0.2", "settings gpt-4*"]);
	expect(row.querySelector(".prov-scope")?.textContent).toBe("settings");
	expect(row.querySelector(".prov-key")?.textContent).toBe("gpt-4*");
	expect(row.classList.contains("res-not-sent")).toBe(false);
});

test("an entry override names the entry layer and shows the shadowed global value struck through", () => {
	const root = mountParamsAnswered({
		entryParameters: { "gpt-4*": { temperature: 0.1 } },
		entryLabel: "Team A",
		globalParameters: { "gpt-4*": { temperature: 0.8, top_p: 0.9 } },
	});
	const rows = Array.from(root.querySelectorAll("table.resolution tbody tr"));
	const texts = rows.map((row) =>
		Array.from(row.querySelectorAll("td"))
			.map((cell) => (cell.textContent ?? "").trim())
			.join(" | ")
	);
	// The beaten value sits under its winner, opened by a clipped word that
	// keeps a screen reader from announcing it as another parameter.
	expect(texts).toEqual([
		"temperature | 0.1 | entry gpt-4*",
		"Overridden value | 0.8 | settings gpt-4*",
		"top_p | 0.9 | settings gpt-4*",
	]);
	const shadowed = root.querySelector("tr.res-shadow") as HTMLElement;
	expect(shadowed.querySelector(".res-name .visually-hidden")?.textContent).toBe("Overridden value");
	// A real deletion, not a line-through class: the semantics have to survive
	// a stylesheet the reader never loads.
	expect(shadowed.querySelector(".res-value del")?.textContent).toBe("0.8");
});

test("an inherited field renders its writer badge with the winning record on the inherited mark", () => {
	const root = mountParamsAnswered({
		globalParameters: {
			"*": { top_p: 0.9, _inheritable: true },
			"gpt-4*": { temperature: 0.3 },
		},
	});
	const rows = Array.from(root.querySelectorAll("table.resolution tbody tr"));
	const texts = rows.map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim());
	// The inheritance is a quiet directive mark naming the winning record that
	// pulled the value in, beside the badge naming the record that wrote it.
	expect(texts.some((text) => text.includes("settings *") && text.includes("inherited by gpt-4*"))).toBe(true);
	expect(texts.some((text) => text.includes("settings gpt-4*") && !text.includes("inherited"))).toBe(true);
	expect(root.querySelector(".mark")?.textContent?.replace(/\s+/g, " ").trim()).toBe("inherited by gpt-4*");
});

test("unknown underscore keys never surface; provider-owned keys render muted with the not-sent reason", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { _internal: true, stream: false } } });
	const rows = Array.from(root.querySelectorAll("table.resolution tbody tr")) as HTMLElement[];
	expect(rows.length).toBe(1);
	expect(rows.every((row) => row.classList.contains("res-not-sent"))).toBe(true);
	expect(root.textContent).not.toContain("_internal");
	// The mark is one quiet phrase; the rule behind it rides a focusable tip,
	// because that sentence exists nowhere else on the panel.
	expect(textOf(root, ".mark-quiet")).toContain("not sent");
	const tip = root.querySelector('.mark-quiet [role="tooltip"]');
	expect(tip?.textContent).toBe("A provider-owned request field: the extension owns it and never sends an override.");
	expect(root.querySelector(".mark-quiet .tip-wrap")?.getAttribute("tabindex")).toBe("0");
});

test("a forced row states that it overrides runtime options, and the runtime caveat excepts it", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { temperature: 0.2, _force: true } } });
	expect(textOf(root, "tbody .mark")).toBe("force");
	expect(root.querySelector('tbody .res-source [role="tooltip"]')?.textContent).toBe(
		"Overrides runtime options and the picker configuration."
	);
	expect(root.textContent).toContain("Overrides every table row above except forced rows.");
});

test("without forced rows the runtime caveat keeps its unconditional wording", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { temperature: 0.2 } } });
	expect(root.querySelector("tbody .mark")).toBeNull();
	expect(root.textContent).toContain("Overrides every table row above.");
});

test("_force diagnostics render like the capability side's: unforceable keys and malformed lists", () => {
	const root = mountParamsAnswered({
		globalParameters: { "gpt-4*": { temperature: 0.2, model: "other", _force: ["model", "typo_entry"] } },
	});
	// A label doing a heading's job is a heading, so assistive tech can jump to it; the items name the key and the
	// record, and the warning tone says the rest.
	expect(textOf(root, ".record-problems h5")).toBe("Record problems");
	// The refused provider-owned key names itself and the record that carried it.
	expect(root.textContent).toContain('"model" cannot be forced and its mark is skipped');
	// A listed name the record does not set malforms the directive; the copy
	// leads with the shape that works and must not claim the whole directive is
	// dead - valid entries stay forced.
	expect(root.textContent).toContain('"_force" must be true or a list of fields the record sets');
	expect(root.textContent).toContain('e.g. ["temperature"]; offending entries are ignored (settings key gpt-4*)');
});

test("an invalid matcher key renders its own diagnostic", () => {
	const root = mountParamsAnswered({
		globalParameters: { "gpt*4o": { temperature: 0.2 }, "gpt-4o": { top_p: 0.5 } },
	});
	expect(root.textContent).toContain('"gpt*4o" is not a valid matcher key and never matches');
});

test("the params section's unknown-inherit-key message spells the directive by its registered name", () => {
	// The message must spell the directive literally for l10n extraction, so a
	// registry rename would leave it (and its translations) telling users about
	// a gone directive; this pin fails the rename until the message moves too.
	const root = mountParamsAnswered({
		globalParameters: { "gpt-4o": { temperature: 0.2, _inherit_from: ["missing"] } },
	});
	expect(textOf(root, ".record-problems")).toContain(`"${INHERIT_FROM_DIRECTIVE}" names "missing"`);
});

test("the caps section's unknown-inherit-key message spells the directive by its registered name", () => {
	// The capability side's copy of the same message; the same rename pin.
	const root = mountCapsAnswered(
		makeCapabilities({
			diagnostics: [{ kind: "unknown-inherit-key", key: "missing", layer: "global", recordKey: "gpt-4" }],
		})
	);
	expect(textOf(root, ".record-problems")).toContain(`"${INHERIT_FROM_DIRECTIVE}" names "missing"`);
});

test("clean configuration renders no diagnostics block", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { temperature: 0.2, _force: ["temperature"] } } });
	expect(root.querySelector(".record-problems")).toBeNull();
});

test("the max_tokens derivation states the configured branch with its attribution", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { max_tokens: 2222 } } });
	// The configured branch carries the same badge a row would: scope and key,
	// no sentence.
	expect(normOf(root, ".max-tokens")).toBe("max_tokens 2,222 settings gpt-4*");
	// A configured max_tokens is the derivation's story, never a table row -
	// and it is real configuration, so the absence line must not claim nothing
	// matched.
	expect(root.querySelector("table.resolution")).toBeNull();
	expect(root.querySelector(".absent")).toBeNull();
});

test("the max_tokens derivation states the declared and capped-default branches", () => {
	// Neither derived branch has a record to point at, so neither wears a
	// badge: they say in words where the number came from.
	const declared = mountParamsAnswered({ modelOverrides: { maxOutputTokens: 32000, outputLimitDeclared: true } });
	// The derivation line formats its count like the tables do: the same number
	// in two renderings on one screen reads as two numbers.
	expect(normOf(declared, ".max-tokens")).toBe("max_tokens 32,000 the model's declared output limit");
	expect(declared.querySelector(".max-tokens .prov")).toBeNull();

	const capped = mountParamsAnswered({ modelOverrides: { maxOutputTokens: 32000, outputLimitDeclared: false } });
	// One rendering of one number, including inside the formula.
	expect(normOf(capped, ".max-tokens")).toBe("max_tokens 4,096 min(4,096, model max) - a default, not declared");
});

test("a forced max_tokens reports the forced derivation with its attribution", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { max_tokens: 2222, _force: ["max_tokens"] } } });
	// Badge plus the force mark, whose tip states the rule.
	expect(normOf(root, ".max-tokens")).toContain("max_tokens 2,222 settings gpt-4* force");
	// A forced max_tokens renders on the derivation line, never as a row - but runtime options lose to it as they lose
	// to a forced row, so the caveat below makes the exception with no forced row in the table.
	expect(root.textContent).toContain("Overrides every table row above except forced rows.");
	expect(root.querySelector('.max-tokens [role="tooltip"]')?.textContent).toBe(
		"Overrides runtime options and the picker configuration; never clamped."
	);
});

test("the runtime caveat always renders; the picker caveat only on reasoning models", () => {
	const plain = mountParamsAnswered({});
	expect(plain.textContent).toContain("Runtime options");
	expect(plain.textContent).not.toContain("Configure Model pick");

	cleanup();
	resetPosted();
	const reasoning = mountParamsAnswered({ modelOverrides: { reasoning: true } });
	expect(reasoning.textContent).toContain("Runtime options");
	expect(reasoning.textContent).toContain("Overrides reasoning_effort here.");
});

test("the zero-config empty state still shows max_tokens and the caveats", () => {
	const root = mountParamsAnswered({});
	expect(textOf(root, ".absent")).toContain("No configured parameters match this model");
	expect(root.querySelector(".max-tokens")).not.toBeNull();
	expect(root.textContent).toContain("Runtime options");
});

test("a state push that drops the inspected model closes the inspector instead of rendering stale data", () => {
	mount(<App />);
	const withModel = makeState({
		servers: [makeDeclaredServer()],
		models: [model],
		settings: makeSettings(),
	});
	pushToWebview(statePush(withModel));
	fireClick(document.querySelector("button[aria-label='Inspect Omni on Prod']") as HTMLButtonElement);
	expect(document.querySelector("[role='dialog']")).not.toBeNull();

	pushToWebview(statePush({ ...withModel, models: [] }));
	expect(document.querySelector("[role='dialog']")).toBeNull();
});

test("two rows sharing an ID and display label still ask about their own snapshot", () => {
	// The inspected identity includes scopeKey: two snapshots can render the same raw ID under the same display label,
	// and each Inspect action must ask about exactly the row it sits on. Declared labels are setting-unique, so the
	// second same-label scope is an external group.
	const rows = [makeModel({ ...model, scopeKey: "s0" }), makeModel({ ...model, scopeKey: "s1" })];
	mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				servers: [makeDeclaredServer(), makeExternalServer({ label: "Prod", baseUrl: "http://other:4000" })],
				models: rows,
			})
		)
	);
	const actions = document.querySelectorAll("button[aria-label='Inspect Omni on Prod']");
	expect(actions.length).toBe(2);
	fireClick(actions[1] as HTMLButtonElement);
	expect(document.querySelector("[role='dialog']")).not.toBeNull();
	const request = lastRequest("readModelParameters");
	expect(request.payload.scopeKey).toBe("s1");
	expect(request.payload.rawId).toBe("gpt-4o");
});

test("one snapshot rendered under two labels: the inspector stays on the clicked row's label", () => {
	// The inspected identity includes serverLabel too: a group snapshot can
	// render under several labels with identical (scopeKey, rawId), and the
	// overlay must attribute the clicked row, not the first claimant.
	const rows = [
		makeModel({ ...model, scopeKey: "s0", serverLabel: "A" }),
		makeModel({ ...model, scopeKey: "s0", serverLabel: "B" }),
	];
	mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				servers: [makeDeclaredServer({ label: "A" }), makeDeclaredServer({ label: "B" })],
				models: rows,
			})
		)
	);
	fireClick(document.querySelector("button[aria-label='Inspect Omni on B']") as HTMLButtonElement);
	const dialog = document.querySelector("[role='dialog']") as HTMLElement;
	expect(dialog).not.toBeNull();
	expect(textOf(dialog, ".inspector-identity")).toBe("gpt-4o on B");
});

test("the header keeps ONE orientation line - family and capability chips - and repeats no token counts", () => {
	// The header orients only (family and capability chips): the token limits render exactly once below with their
	// sources, and pricing exactly once in the Pricing section.
	const root = mountParamsAnswered({
		modelOverrides: {
			family: "gpt",
			maxInputTokens: 128000,
			maxOutputTokens: 4096,
			outputLimitDeclared: false,
			inputCost: 2.5,
			outputCost: 10,
			cacheReadCost: 0.25,
			longContextInputCost: 5,
			toolCalling: true,
			imageInput: true,
			promptCaching: false,
			reasoning: false,
		},
	});
	const line = root.querySelector(".inspector-orientation");
	expect(line).not.toBeNull();
	expect(line?.textContent).toContain("Family");
	expect(line?.textContent).toContain("gpt");
	const chips = [...(line?.querySelectorAll(".cap-chip") ?? [])].map((chip) => chip.textContent);
	expect(chips).toEqual(["tools", "vision"]);
	// Capability words are prose about the model, so they wear the soft-fill
	// chip - never the outline badge, which means provenance and nothing else.
	expect(line?.querySelector(".cap-chip")?.getAttribute("data-slot")).toBe("badge");
	expect(line?.querySelector(".prov")).toBeNull();
	expect(root.querySelector(".model-facts")).toBeNull();
	expect(line?.textContent).not.toContain("Input tokens");
	expect(line?.textContent).not.toContain("Output tokens");
	expect(line?.textContent).not.toContain("128,000");
	expect(line?.textContent).not.toContain("4,096");
	expect(line?.textContent).not.toContain("$2.5");
});

test("a model with no capability flags says none declared instead of an empty chip strip", () => {
	const root = mountParamsAnswered({
		modelOverrides: { toolCalling: false, imageInput: false, promptCaching: false, reasoning: false },
	});
	const line = root.querySelector(".inspector-orientation");
	expect(line?.querySelectorAll(".cap-chip").length).toBe(0);
	expect(line?.textContent).toContain("none declared");
});

test("the correlated caps response renders every field with its value and source level", () => {
	const root = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				context_length: {
					value: 200000,
					level: "entry",
					key: "gpt-4",
					shadowed: [{ level: "global", key: "gpt", value: 128000 }],
				},
				supports_vision: { value: true, level: "server", shadowed: [] },
			},
		})
	);
	const table = root.querySelector("table.resolution");
	expect(table).not.toBeNull();
	// 7 field rows + 1 shadowed row.
	expect(table?.querySelectorAll("tbody tr").length).toBe(8);
	const text = (table?.textContent ?? "").replace(/\s+/g, " ");
	expect(text).toContain("Context length");
	expect(text).toContain((200000).toLocaleString());
	// Every level renders as a badge; the walk's levels that no record can own
	// (the report, the floor) carry a scope word and no key.
	expect(text).toContain("entry gpt-4");
	expect(text).toContain("Overridden value");
	expect(text).toContain("settings gpt");
	expect(text).toContain("server");
	expect(text).toContain("built-in default");
});

test("every level of the capability walk renders as one badge, with the directive as a mark", () => {
	// A badge names WHERE (scope plus the record key you would go and edit); a mark names the DIRECTIVE that did the
	// work, in the record editors' own word. Nothing here is a sentence, and the badge carries no state class.
	const levels: [CapabilityLevel, string | undefined, string, string | undefined][] = [
		["entry", "gpt-4", "entry gpt-4", undefined],
		["global", "gpt*", "settings gpt*", undefined],
		["entry-fallback", "gpt-4", "entry gpt-4", "fallback"],
		["global-fallback", "*", "settings *", "fallback"],
		["server", undefined, "server", undefined],
		["directive", "openai/gpt-4o", "OpenRouter openai/gpt-4o", "_openrouter_model"],
		["catalog", "openai/gpt-4o", "OpenRouter openai/gpt-4o", "matched"],
		["derived", undefined, "derived", undefined],
		["floor", undefined, "built-in default", undefined],
	];
	for (const [level, key, badge, mark] of levels) {
		const root = mountCapsAnswered(
			makeCapabilities({
				fields: {
					...makeCapabilities().fields,
					context_length: { value: 128000, level, ...(key === undefined ? {} : { key }), shadowed: [] },
				},
			})
		);
		const row = root.querySelector("table.resolution tbody tr") as HTMLElement;
		expect(row.querySelector(".prov")?.textContent?.replace(/\s+/g, " ").trim()).toBe(badge);
		expect(row.querySelector(".prov")?.className).toBe("prov");
		expect(row.querySelector(".mark")?.textContent?.trim()).toBe(mark);
		cleanup();
		resetPosted();
	}
});

test("a scope word a reader cannot infer carries its sentence in a focusable tip", () => {
	// "derived" is a computation, not a place, and the rule behind it exists
	// nowhere else on the panel - so it has to be reachable without a pointer.
	const root = mountCapsAnswered(
		makeCapabilities({
			fields: { ...makeCapabilities().fields, max_input_tokens: { value: 112000, level: "derived", shadowed: [] } },
		})
	);
	const tip = root.querySelector(".res-source .tip-wrap");
	expect(tip?.getAttribute("tabindex")).toBe("0");
	expect(tip?.querySelector('[role="tooltip"]')?.textContent).toBe(
		"Context length minus max output tokens: nothing declared this field directly."
	);
});

test("a record key too long for its column carries the full badge text in a focusable tip", () => {
	// The stylesheet ellipsizes a badge that outgrows the source column, and a
	// long unbroken regex matcher is exactly the text a reader opened the panel
	// for - so a clipped badge joins the Tab order with its full text.
	const key = "/^(gpt|claude)-[0-9.]+-(preview|latest)$/i";
	const root = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				context_length: { value: 128000, level: "global", key, shadowed: [] },
			},
		})
	);
	// The context_length row is the table's first; the derived row below it has
	// a tip of its own, so both reads stay scoped to their own row.
	const tip = root.querySelector("tbody tr")?.querySelector(".res-source .tip-wrap");
	expect(tip?.getAttribute("tabindex")).toBe("0");
	expect(tip?.querySelector('[role="tooltip"]')?.textContent).toBe(`settings ${key}`);
	// A key that comfortably fits stays plain text, outside the Tab order.
	cleanup();
	resetPosted();
	const short = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				context_length: { value: 128000, level: "global", key: "gpt-4*", shadowed: [] },
			},
		})
	);
	expect(short.querySelector("tbody tr")?.querySelector(".res-source .tip-wrap") ?? null).toBeNull();
});

test("every resolution table names its three columns for assistive tech", () => {
	// A provenance table always names name, value and source, now through visible heads.
	const root = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				input_cost_per_token: { value: 0.000005, level: "server", shadowed: [] },
			},
		})
	);
	const heads = [...root.querySelectorAll("table.resolution")].map((table) =>
		[...table.querySelectorAll("thead th")].map((cell) => (cell.textContent ?? "").trim())
	);
	expect(heads).toEqual([
		["Capability", "Value", "Source"],
		["Tokens", "Price", "Source"],
	]);
});

test("the Pricing section states its own in-flight state instead of vanishing", () => {
	// Pricing rides the capability feed, so it has nothing to show until that
	// answer lands - which is a state to render, not a section to withhold.
	const container = mount(<ModelInspector currencySymbol="$" model={model} stateSeq={0} onClose={() => {}} />);
	expect(sectionTitles(container)).toEqual(["Parameters", "Capabilities", "Pricing"]);
	const pricing = container.querySelector("#inspector-pricing-section") as HTMLElement;
	expect(pricing.querySelector("[role='status']")?.textContent).toBe("Resolving capabilities...");
	expect(pricing.querySelector("table.resolution")).toBeNull();
	expect(pricing.querySelector(".absent")).toBeNull();
});

test("the fixed machinery renders while the projection is still in flight", () => {
	// "Resolving parameters..." followed by nothing reads as a section that
	// failed to load; the always-sent fields and the caveats are truth about the
	// extension, not about this answer.
	const container = mount(<ModelInspector currencySymbol="$" model={model} stateSeq={0} onClose={() => {}} />);
	expect(container.textContent).toContain("Resolving parameters...");
	expect(container.querySelector(".inspector-notes")).not.toBeNull();
	// The always-sent fields and the tools pair in full: three-part markup that no single localized string pins.
	const notes = [...container.querySelectorAll(".inspector-notes dd")].map((dd) =>
		(dd.textContent ?? "").replace(/\s+/g, " ").trim()
	);
	expect(notes[0]).toBe("model messages stream stream_options max_tokens");
	expect(notes[1]).toBe("tools tool_choice");
	expect(container.textContent).toContain("Sent with tools");
	// With no projection to read, the runtime caveat keeps its unconditional
	// wording rather than claiming there are forced rows.
	expect(container.textContent).toContain("Overrides every table row above.");
});

test("a configured max_tokens whose layer the projection could not name wears no badge", () => {
	// The projection reports the branch and the value; the layer is a separate
	// lookup that can come back empty. A badge would then name a layer the panel
	// does not know - so it says so in words instead.
	const container = mount(<ModelInspector currencySymbol="$" model={model} stateSeq={0} onClose={() => {}} />);
	respondTo(lastRequest("readModelParameters"), {
		projection: { rows: [], maxTokens: { source: "configured", value: 2222 }, diagnostics: [] },
	});
	expect(normOf(container, ".max-tokens")).toBe("max_tokens 2,222 set in configuration");
	expect(container.querySelector(".max-tokens .prov")).toBeNull();
});

test("a beaten value keeps the directive that put it in the running", () => {
	// A shadowed fallback fill is still a fallback: dropping the mark from the
	// loser leaves the reader guessing why a record they never see in the
	// winner's chain was competing at all.
	const root = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				context_length: {
					value: 200000,
					level: "entry",
					key: "gpt-4",
					shadowed: [{ level: "global-fallback", key: "*", value: 128000 }],
				},
			},
		})
	);
	const shadow = root.querySelector("tr.res-shadow") as HTMLElement;
	expect(shadow.querySelector(".prov")?.textContent?.replace(/\s+/g, " ").trim()).toBe("settings *");
	expect(shadow.querySelector(".mark")?.textContent?.trim()).toBe("fallback");
});

test("declared, directive-not-found, inherited fields, and diagnostics all render their notes", () => {
	const root = mountCapsAnswered(
		makeCapabilities({
			directive: { kind: "not-found", id: "openai/nope" },
			fields: {
				...makeCapabilities().fields,
				context_length: { value: 200000, level: "global", key: "gpt*", inheritedBy: "gpt-4", shadowed: [] },
			},
			diagnostics: [{ kind: "unrecognized-key", key: "supports_web_search", layer: "global", recordKey: "gpt-4" }],
		}),
		{ declared: true }
	);
	const text = root.textContent ?? "";
	expect(text).toContain("Declared model");
	expect(text).toContain('"openai/nope" was not found');
	expect(root.querySelector("tbody .mark")?.textContent?.replace(/\s+/g, " ").trim()).toBe("inherited by gpt-4");
	expect(text).toContain('"supports_web_search" is not a field this extension knows');
});

/**
 * A name cell's VISIBLE text: a labeled field renders its label inside the
 * wire-key tip (the tooltip text would otherwise concatenate onto
 * textContent), an open field renders its raw key directly.
 */
function nameText(cell: Element | null): string | null {
	if (cell === null) {
		return null;
	}
	return (cell.querySelector(".tip-wrap > span:not(.tip-bubble)") ?? cell).textContent;
}

test("the core fields render first in their pinned order; open fields land under Other fields, sorted by wire key", () => {
	const root = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				supports_prompt_caching: { value: true, level: "server", shadowed: [] },
				supports_web_search: { value: true, level: "entry", key: "gpt-4", shadowed: [] },
				custom_rank: { value: 3, level: "global", key: "gpt*", shadowed: [] },
			},
		})
	);
	const names = [...root.querySelectorAll("table.resolution tbody tr:not(.res-shadow) td.res-name")].map(nameText);
	expect(names).toEqual([
		"Context length",
		"Max input tokens",
		"Max output tokens",
		"Tool calling",
		"Vision",
		"Reasoning",
		"Audio input",
		// The consumed booleans follow the core with friendly labels.
		"Prompt caching",
		// The open fields, code-unit sorted, labeled by their raw wire keys.
		"custom_rank",
		"supports_web_search",
	]);
	// The extras open the labeled Other-fields band inside the caps table.
	const bands = [...root.querySelectorAll("tr.res-group th")].map((cell) => cell.textContent);
	expect(bands).toEqual(["Other fields"]);
	const text = root.textContent ?? "";
	// Open values render as plain numbers, never token-formatted.
	expect(text).toContain("custom_rank");
	// An open boolean keeps the yes/no idiom.
	const webSearchRow = [...root.querySelectorAll("table.resolution tbody tr")].find((row) =>
		row.textContent?.includes("supports_web_search")
	);
	expect(webSearchRow?.textContent).toContain("yes");
	expect(webSearchRow?.textContent?.replace(/\s+/g, " ")).toContain("entry gpt-4");
});

test("a core-only response renders no in-table bands; the section headers carry the document structure", () => {
	const root = mountCapsAnswered(makeCapabilities());
	expect(root.querySelectorAll("tr.res-group").length).toBe(0);
	expect(sectionTitles(root)).toEqual(["Parameters", "Capabilities", "Pricing"]);
	// The capabilities header line summarizes what the table holds.
	expect(textOf(root, "#inspector-caps-section .section-meta")).toBe("7 fields");
});

test("cost fields render as $/M in the Pricing section, exactly once, never in scientific notation", () => {
	const root = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				input_cost_per_token: { value: 0.000005, level: "server", shadowed: [] },
				output_cost_per_token: { value: 0.000025, level: "server", shadowed: [] },
				// The regression case: 5e-7 stringifies to "5e-7", and the raw
				// rendering leaked exactly that into the table.
				cache_read_input_token_cost: { value: 5e-7, level: "server", shadowed: [] },
				cache_creation_input_token_cost: {
					value: 6.25e-6,
					level: "entry",
					key: "gpt-4",
					shadowed: [{ level: "server", value: 3.75e-5 }],
				},
			},
		})
	);
	// The cost rows live under the Pricing section header - the one pricing rendering in the whole panel.
	const pricingSection = root.querySelector("#inspector-pricing-section") as HTMLElement;
	expect(pricingSection).not.toBeNull();
	const pricingRows = [...pricingSection.querySelectorAll("table.resolution tbody tr")].filter((row) =>
		row.querySelector(".res-value")
	);
	const values = pricingRows.map((row) => row.querySelector(".res-value")?.textContent ?? "");
	expect(values).toContain("$5.00");
	expect(values).toContain("$25.00");
	expect(values).toContain("$0.50");
	expect(values).toContain("$6.25");
	// The shadowed cost formats as $/M too, and nothing renders as 5e-7.
	expect(pricingSection.querySelector("tr.res-shadow .res-value")?.textContent).toBe("$37.50");
	for (const value of values) {
		expect(value).not.toMatch(/\de[+-]?\d/);
	}
	// No dollar amount renders anywhere outside the Pricing section, whose own
	// header line states the unit once.
	const outside = (root.textContent ?? "").split("Pricing")[0] ?? "";
	expect(outside).not.toContain("$");
	// The friendly labels replace the raw wire keys, which stay one focusable
	// tip away (the label hides the very key a capabilities record needs).
	const names = pricingRows.map((row) => nameText(row.querySelector(".res-name")));
	expect(names).toContain("Input");
	expect(names).toContain("Cache read");
	expect(names).not.toContain("input_cost_per_token");
	const inputRow = pricingRows.find((row) => nameText(row.querySelector(".res-name")) === "Input");
	const nameTip = inputRow?.querySelector(".res-name .tip-wrap");
	expect(nameTip?.getAttribute("tabindex")).toBe("0");
	expect(nameTip?.querySelector('[role="tooltip"]')?.textContent).toBe("input_cost_per_token");
});

test("the supported-params list renders in the PARAMETERS section: header line count plus the sorted names", () => {
	const long = [
		"frequency_penalty",
		"logit_bias",
		"logprobs",
		"top_logprobs",
		"max_tokens",
		"max_completion_tokens",
		"modalities",
		"prediction",
		"n",
		"presence_penalty",
		"seed",
		"stop",
		"stream",
		"stream_options",
		"temperature",
		"top_p",
		"tools",
		"tool_choice",
		"function_call",
		"functions",
		"parallel_tool_calls",
		"audio",
		"web_search_options",
		"response_format",
		"user",
		"reasoning_effort",
		"thinking",
	];
	const root = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				supported_openai_params: {
					value: long,
					level: "global",
					key: "gpt-5*",
					shadowed: [{ level: "server", value: ["temperature"] }],
				},
			},
		})
	);
	// What the model ACCEPTS renders beside what we send: the block lives in
	// the Parameters section, not the Capabilities table, while staying a
	// capability on the wire (it arrived on the modelCapabilities response).
	const paramsSection = root.querySelector("#inspector-params-section") as HTMLElement;
	expect(paramsSection).not.toBeNull();
	const block = paramsSection.querySelector(".supported-params") as HTMLElement;
	expect(block).not.toBeNull();
	// The block's header line carries the name, the count and the source, so
	// the body below is nothing but names.
	expect(textOf(block, "h5")).toBe("Supported parameters");
	expect(textOf(block, ".params-count")).toBe("27 parameters");
	expect(textOf(block, ".prov").replace(/\s+/g, " ")).toBe("settings gpt-5*");
	// Quiet monospace text, not a wall of pills: one element per name so
	// boundaries survive a comma inside a name, nothing hidden behind a tip.
	const listItems = [...block.querySelectorAll(".params-names li")].map((item) => item.textContent);
	expect(listItems).toEqual([...long].sort());
	expect(block.querySelector('[role="tooltip"]')).toBeNull();
	expect(block.querySelector(".params-names")?.getAttribute("aria-label")).toBe("Supported parameters");
	// A shadowed list stays count-only (its record holds the value), struck
	// through behind the same clipped word every beaten value carries.
	const shadowedLine = block.querySelector(".params-shadow") as HTMLElement;
	expect(shadowedLine?.querySelector("del")?.textContent).toBe("1 parameter");
	expect(shadowedLine?.querySelector(".visually-hidden")?.textContent).toBe("Overridden value");
	// The clipped marker and the value are separate words to a screen reader,
	// not "Overridden value1 parameter".
	expect(shadowedLine?.textContent?.replace(/\s+/g, " ")).toContain("Overridden value 1 parameter");
	expect(shadowedLine?.textContent).not.toContain("temperature");
	// The Capabilities section renders the list nowhere - one rendering only.
	const capsSection = root.querySelector("#inspector-caps-section") as HTMLElement;
	expect(capsSection.textContent).not.toContain("27 parameters");
	cleanup();
	resetPosted();
	const empty = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				supported_openai_params: { value: [], level: "server", shadowed: [] },
			},
		})
	);
	expect(empty.textContent).toContain("0 parameters");
	// An empty list renders no list at all - a bare strip under the count would
	// read as a rendering bug.
	expect(empty.querySelector(".params-names")).toBeNull();
});

test("prototype-named open fields render from the bag, never from Object.prototype", () => {
	const core = makeCapabilities().fields;
	const fields = Object.fromEntries([
		...Object.entries(core),
		["__proto__", { value: 1, level: "server", shadowed: [] }],
		["toString", { value: "shadowed-name", level: "global", key: "*", shadowed: [] }],
	]) as EffectiveCapabilities["fields"];
	const root = mountCapsAnswered(makeCapabilities({ fields }));
	const names = [...root.querySelectorAll("table.resolution tbody tr td.res-name")].map((cell) => cell.textContent);
	expect(names).toContain("__proto__");
	expect(names).toContain("toString");
	const text = root.textContent ?? "";
	expect(text).toContain('"shadowed-name"');
	expect(({} as Record<string, unknown>).toString).toBe(Object.prototype.toString);
});

test("a value long enough to clip gets the focusable full-text tip; short values stay plain", () => {
	const long = ["temperature", "top_p", "max_tokens", "stream", "stop", "tools", "tool_choice"];
	const root = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				// An OPEN field with a long JSON value; the consumed params list
				// has its own count rendering and is pinned elsewhere.
				custom_param_list: { value: long, level: "server", shadowed: [] },
			},
		})
	);
	const tipWrap = root.querySelector(".res-value .tip-wrap");
	expect(tipWrap).not.toBeNull();
	expect(tipWrap?.getAttribute("tabindex")).toBe("0");
	expect(tipWrap?.querySelector('[role="tooltip"]')?.textContent).toBe(JSON.stringify(long));
	// The short core values stay plain text outside the Tab order.
	expect(root.querySelectorAll(".res-value .tip-wrap").length).toBe(1);
});

test("the clip tip's threshold sits exactly at the 8ch box, counting wide glyphs double", () => {
	const tipCount = (value: string): number => {
		const root = mountCapsAnswered(
			makeCapabilities({
				fields: { ...makeCapabilities().fields, note: { value, level: "server", shadowed: [] } },
			})
		);
		const count = root.querySelectorAll(".res-value .tip-wrap").length;
		cleanup();
		resetPosted();
		return count;
	};
	// JSON.stringify adds the two quotes: 6 chars render as exactly 8.
	expect(tipCount("x".repeat(6))).toBe(0);
	expect(tipCount("x".repeat(7))).toBe(1);
	// 4 CJK glyphs plus the quotes approximate 10ch: clipped well before the
	// code-unit length reaches 8, so the tip must already be there.
	expect(tipCount("字".repeat(4))).toBe(1);
});

test("an unrecognized-key diagnostic renders as an informational note, apart from real problems", () => {
	const root = mountCapsAnswered(
		makeCapabilities({
			diagnostics: [
				{ kind: "unrecognized-key", key: "supports_web_search", layer: "global", recordKey: "gpt-4" },
				{ kind: "invalid-value", key: "context_length", layer: "entry", recordKey: "gpt-4" },
			],
		})
	);
	const advisories = root.querySelector(".record-notes");
	expect(advisories).not.toBeNull();
	expect(textOf(advisories as HTMLElement, "h5")).toBe("Record notes");
	expect(advisories?.textContent).toContain("applied as an override as-is");
	expect(advisories?.querySelector("li")?.className).toBe("hint");
	// The record diagnostics live at the end of the Capabilities section (near
	// the records they judge), never dangling after Pricing.
	expect(advisories?.closest("section")?.id).toBe("inspector-caps-section");
	// The real problem stays under the problems heading, not among the notes.
	expect(textOf(root, ".record-problems:not(.record-notes) h5")).toBe("Record problems");
	expect(advisories?.textContent).not.toContain("invalid value");
});

test("the declared badge follows the model's verdict: a discovered model shows no badge", () => {
	// The badge rides model.declared (what registration served), never the
	// record configuration; a discovered model must not claim "not discovered".
	const root = mountCapsAnswered(makeCapabilities());
	expect(root.textContent).not.toContain("Declared model");
});

test("the output-limit note names the limit's source and nothing the request does", () => {
	// A label plus a value, in the parameters machinery's idiom. It says only where the limit came from: what the
	// REQUEST sends is conditional (a configured or forced max_tokens beats the limit), and the max_tokens line owns it.
	const user = mountCapsAnswered(makeCapabilities({ outputLimitSource: "user" }));
	expect(textOf(user, ".output-limit dt")).toBe("Output limit");
	expect(textOf(user, ".output-limit dd")).toBe("User-set.");
	// The branch every screenshot renders needs its own pin, not just the two
	// edge branches.
	cleanup();
	resetPosted();
	expect(textOf(mountCapsAnswered(makeCapabilities({ outputLimitSource: "provider" })), ".output-limit dd")).toBe(
		"Server-declared."
	);
	cleanup();
	resetPosted();
	const defaults = mountCapsAnswered(makeCapabilities({ outputLimitSource: "defaults" }));
	expect(textOf(defaults, ".output-limit dd")).toBe("A default.");
	// Never a cap claim: a configured max_tokens beats the limit, and this
	// section cannot see whether one exists.
	expect(defaults.textContent).not.toContain("capped at");
});

test("only numbers right-align in the value column", () => {
	// D16 is about NUMERICS: the column also carries yes/no and JSON, and
	// right-aligning a word pushes it away from the name it belongs to.
	const root = mountCapsAnswered(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				input_cost_per_token: { value: 0.000005, level: "server", shadowed: [] },
			},
		})
	);
	const kind = (label: string): string | undefined => {
		const row = [...root.querySelectorAll("table.resolution tbody tr")].find((candidate) =>
			(candidate.querySelector(".res-name")?.textContent ?? "").includes(label)
		);
		return row?.querySelector(".res-value")?.className;
	};
	// `num` is the stylesheet's own name for a right-aligned numeric cell.
	expect(kind("Context length")).toBe("res-value num");
	expect(kind("Tool calling")).toBe("res-value");
	// A whole column of numbers takes its head with it; a mixed one does not.
	const heads = [...root.querySelectorAll("table.resolution thead th:nth-child(2)")].map((th) => th.className);
	expect(heads).toEqual(["", "num"]);
});

test("an empty-capabilities response says the state moved on instead of inventing values", () => {
	const root = mountCapsAnswered(undefined);
	expect(root.textContent).toContain("The model list changed");
	expect(root.querySelector("table.resolution")).toBeNull();
});

test("the Diagnostics jump links open the merged panel scrolled to their section", () => {
	// happy-dom implements scrollIntoView as a no-op; capture the landing
	// element instead of a scroll position.
	const landings: string[] = [];
	const original = Element.prototype.scrollIntoView;
	Element.prototype.scrollIntoView = function (this: Element) {
		landings.push(this.id);
	};
	try {
		mount(<App />);
		pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()], models: [model] })));
		// The models table's plain Inspect opens unanchored: no landing recorded.
		fireClick(document.querySelector("button[aria-label='Inspect Omni on Prod']") as HTMLButtonElement);
		expect(document.querySelector("[role='dialog']")).not.toBeNull();
		expect(landings).toEqual([]);
		fireClick(document.querySelector("button[aria-label='Close']") as HTMLButtonElement);

		// Land on the Diagnostics tab and answer its resolved-models read so the
		// jump-linked rows exist.
		pushToWebview({ kind: "focusSection", section: "diagnostics" });
		respondTo(lastRequest("readResolvedModels"), {
			view: {
				trees: [],
				rows: [
					{ serverLabel: "Prod", rawId: "gpt-4o", scopeKey: "s0", matchedKeys: [], parameters: [], capabilities: [] },
				],
				recordCount: 0,
			},
		});

		// The row's ONE Inspect action opens the panel anchored on its Parameters section - scrolled there AND focused
		// there, so the next Tab continues from the section instead of the panel's first field.
		const inspectLink = document.querySelector("button[aria-label='Inspect gpt-4o on Prod']") as HTMLButtonElement;
		expect(inspectLink).not.toBeNull();
		fireClick(inspectLink);
		expect(document.querySelector("[role='dialog']")).not.toBeNull();
		expect(textOf(document.body, "#model-inspector-title")).toContain("Omni");
		expect(landings).toContain("inspector-params-section");
		expect((document.activeElement as HTMLElement | null)?.id).toBe("inspector-params-section");
	} finally {
		Element.prototype.scrollIntoView = original;
	}
});

test("the anchor stops re-scrolling for good once both feeds have answered", () => {
	// Readiness flips false again on every state push (fresh requestIds orphan
	// the old answers) - a reader who scrolled away must not be yanked back to
	// the anchor by a configuration change landing minutes later.
	const landings: string[] = [];
	const original = Element.prototype.scrollIntoView;
	Element.prototype.scrollIntoView = function (this: Element) {
		landings.push(this.id);
	};
	try {
		const props = { model, anchor: "caps" as const, onClose: () => {} };
		const container = mount(<ModelInspector currencySymbol="$" {...props} stateSeq={0} />);
		expect(landings).toContain("inspector-caps-section");

		const answer = () => {
			respondTo(lastRequest("readModelParameters"), {
				projection: projectEffectiveParameters({
					rawModelId: model.rawId,
					globalParameters: {},
					maxOutputTokens: model.maxOutputTokens,
					outputLimitDeclared: model.outputLimitDeclared,
				}),
			});
			respondTo(lastRequest("readModelCapabilities"), { capabilities: makeCapabilities() });
		};
		// Both feeds answer: the anchor may re-scroll against the settled layout.
		answer();
		landings.length = 0;

		// A state push bumps stateSeq (readiness drops), then fresh answers land:
		// no further scroll, in either window.
		void act(() => {
			render(<ModelInspector currencySymbol="$" {...props} stateSeq={1} />, container);
		});
		answer();
		expect(landings).toEqual([]);
	} finally {
		Element.prototype.scrollIntoView = original;
	}
});

test("a slide-over with no field still lands focus inside itself, so Esc reaches the panel", () => {
	// The inspector is the one slide-over with nothing to type into, so focus falls back to the panel's first focusable:
	// Radix's own open-autofocus is declined, and the opener the dialog just hid from assistive tech is where focus
	// would otherwise sit, taking the panel's Esc handler with it.
	let closed = 0;
	const opener = document.createElement("button");
	document.body.appendChild(opener);
	opener.focus();
	const container = mount(
		<ModelInspector
			currencySymbol="$"
			model={model}
			stateSeq={0}
			onClose={() => {
				closed++;
			}}
		/>
	);
	const panel = container.querySelector(".slide-over") as HTMLElement;
	expect(panel.contains(document.activeElement)).toBe(true);
	expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Close");

	fireKeyDown(document.activeElement as HTMLElement, "Escape");
	expect(closed).toBe(1);
	opener.remove();
});
