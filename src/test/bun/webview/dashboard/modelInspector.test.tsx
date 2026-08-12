/**
 * The merged model inspector's rendering pins: ONE slide-over per model row,
 * sectioned Parameters / Capabilities / Pricing, fed by BOTH request/response
 * reads (readModelParameters and readModelCapabilities; uncorrelated
 * responses ignored per feed).
 *
 * The parameters side pins the row action that opens the panel, the identity
 * header, source naming, shadowed and inherited rendering, the not-sent
 * reasons, the max_tokens derivation wording per branch, the honest caveats,
 * and the empty state; the projection is computed by the SAME shared function
 * the extension answers with. The capabilities side pins the provenance table
 * with shadowed values, the directive and declared notes, the diagnostics
 * lists, and the section split: supported parameters render in the
 * Parameters section (next to what we send), pricing renders exactly once in
 * its own section, and the old params-side pricing facts are gone. The
 * hierarchy pins hold the approved reading order - answers first, machinery
 * last: the header keeps one orientation line without token counts, each
 * section leads with its table, and the record-path figures sit collapsed
 * behind a "Record paths" disclosure at their section's end.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { EffectiveCapabilities } from "../../../../shared/config/capabilityResolution";
import { projectEffectiveParameters } from "../../../../shared/config/parameterResolution";
import { App } from "../../../../webview/dashboard/app";
import type { ModelCapabilitiesResponse, ModelParametersResponse } from "../../../../webview/dashboard/modelInspector";
import { ModelInspector } from "../../../../webview/dashboard/modelInspector";
import { makeDeclaredServer, makeModel, makeSettings, makeState, statePush } from "../fixtures";
import {
	cleanup,
	fireClick,
	lastRequest,
	mount,
	postedRequests,
	pushToWebview,
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

/**
 * Mount the inspector, capture its own posted readModelParameters requestId,
 * then rerender the same tree with the correlated response - exactly how
 * App's response state reaches an already-open inspector. The projection is
 * computed by the SAME shared function the extension answers with, over the
 * inputs the options describe. The capability feed stays unanswered: the
 * params pins must hold regardless of the other section's state.
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
	const container = mount(<ModelInspector model={inspected} stateSeq={0} onClose={onClose} />);
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
	const container = mount(<ModelInspector model={inspected} stateSeq={0} onClose={() => {}} />);
	const request = lastRequest("readModelCapabilities");
	expect(request.payload.scopeKey).toBe(inspected.scopeKey);
	expect(request.payload.rawId).toBe(inspected.rawId);
	respondTo(request, { capabilities, chains });
	return container;
}

test("the models table row carries ONE quiet Inspect action that opens the merged dialog and posts both reads", () => {
	mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()], models: [model] })));
	const row = document.querySelector("table.models tbody tr") as HTMLElement;
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
	const headers = [...root.querySelectorAll("h4.inspector-section")].map((h) =>
		(h.firstChild?.textContent ?? "").trim()
	);
	expect(headers).toEqual(["Parameters", "Capabilities", "Pricing ($/M tokens)"]);
	// The Diagnostics jump anchors exist on the two addressable sections.
	expect(root.querySelector("#inspector-section-params")).not.toBeNull();
	expect(root.querySelector("#inspector-section-caps")).not.toBeNull();
});

test("without pricing fields the Pricing section does not render at all", () => {
	const root = mountCapsAnswered(makeCapabilities());
	const headers = [...root.querySelectorAll("h4.inspector-section")].map((h) =>
		(h.firstChild?.textContent ?? "").trim()
	);
	expect(headers).toEqual(["Parameters", "Capabilities"]);
});

test("the Parameters section leads with the answer: table, supported params, max_tokens, machinery, record paths", () => {
	// The approved hierarchy: answers first, machinery last. The effective-sends
	// table opens the section, the supported-parameters block and the max_tokens
	// line follow, and the fixed machinery (always-sent chips, caveats) plus the
	// collapsed record-path figure close it.
	const container = mount(<ModelInspector model={model} stateSeq={0} onClose={() => {}} />);
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
	const section = container.querySelector("#inspector-section-params")?.closest("section") as HTMLElement;
	expect(section).not.toBeNull();
	// querySelectorAll returns document order: classify each major block and
	// pin the whole reading sequence.
	const blocks = [
		...section.querySelectorAll(
			"table.params, .params-replaced, .params-max-tokens, .params-fixed, .params-caveats, details.record-paths"
		),
	].map((element) => {
		if (element.matches("details.record-paths")) {
			return "record-paths";
		}
		if (element.matches(".params-replaced")) {
			return "diagnostics";
		}
		if (element.matches(".params-max-tokens")) {
			return "max-tokens";
		}
		if (element.matches(".params-fixed")) {
			return "always-sent";
		}
		if (element.matches(".params-caveats")) {
			return "caveats";
		}
		return element.closest(".caps-inspector") !== null ? "supported-params" : "effective-table";
	});
	expect(blocks).toEqual([
		"effective-table",
		"diagnostics",
		"supported-params",
		"max-tokens",
		"always-sent",
		"caveats",
		"record-paths",
	]);
	// The Diagnostics jump anchor stays on the h4 inside the head band.
	expect(section.querySelector(".inspector-section-head h4#inspector-section-params")).not.toBeNull();
});

test("both section header bands carry their Configure action, right-aligned in the band", () => {
	const root = mount(<ModelInspector model={model} stateSeq={0} onClose={() => {}} onEditRecord={() => {}} />);
	const actionText = (anchorId: string): string | undefined => {
		const head = root.querySelector(`.inspector-section-head:has(#${anchorId})`);
		return head?.querySelector("button.section-action")?.textContent ?? undefined;
	};
	expect(actionText("inspector-section-params")).toBe("Configure parameters for this model");
	expect(actionText("inspector-section-caps")).toBe("Configure capabilities for this model");
});

test("the record-path figures render collapsed under a Record paths summary at their section's end", () => {
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
	const section = root.querySelector("#inspector-section-params")?.closest("section") as HTMLElement;
	const details = section.querySelector("details.record-paths") as HTMLDetailsElement;
	expect(details).not.toBeNull();
	// Collapsed by default: the figure is the WHY, read on demand.
	expect(details.open).toBe(false);
	expect(details.querySelector("summary")?.textContent).toBe("Record paths");
	// The existing figure renders unchanged inside and shows once opened.
	details.open = true;
	const chain = details.querySelector(".record-chain");
	expect(chain).not.toBeNull();
	expect(chain?.textContent).toContain("Record path (settings):");
	expect(chain?.textContent).toContain("gpt-4*");
});

test("an open Record paths disclosure survives a state push instead of collapsing under the reader", () => {
	// A state push orphans the answers (fresh requestIds), so the disclosure
	// unmounts until the new answer lands; the controlled open state must carry
	// across the remount.
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
	const container = mount(<ModelInspector {...props} stateSeq={0} />);
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
	const details = container.querySelector("details.record-paths") as HTMLDetailsElement;
	expect(details.open).toBe(false);
	// The reader opens it (the native toggle the summary click produces).
	void act(() => {
		details.open = true;
		details.dispatchEvent(new Event("toggle"));
	});

	// The push: readiness drops (a re-request orphans the answer, so the
	// disclosure may unmount), then the fresh answer lands.
	void act(() => {
		render(<ModelInspector {...props} stateSeq={1} />, container);
	});
	answer();
	const after = container.querySelector("details.record-paths") as HTMLDetailsElement;
	expect(after).not.toBeNull();
	expect(after.open).toBe(true);
});

test("without a chain story the Parameters section renders no Record paths disclosure", () => {
	// A single-link chain (or none) tells no inheritance story; an empty
	// disclosure would promise detail it cannot show. (The caps feed stays
	// unanswered here; the caps section's own pin is above.)
	const root = mountParamsAnswered({ globalParameters: { "gpt-4o": { temperature: 0.2 } } });
	expect(root.querySelector("details.record-paths")).toBeNull();
});

test("the Capabilities section closes with problems, notes, then its collapsed record-path disclosure", () => {
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
	const section = root.querySelector("#inspector-section-caps")?.closest("section") as HTMLElement;
	const details = section.querySelector("details.record-paths") as HTMLDetailsElement;
	expect(details).not.toBeNull();
	expect(details.open).toBe(false);
	// The disclosure is the section's LAST block: the output-limit note, the
	// problems, and the advisory notes all come before it, in that order.
	const blocks = [...section.querySelectorAll(".params-max-tokens, .params-replaced, details.record-paths")].map(
		(element) => {
			if (element.matches("details.record-paths")) {
				return "record-paths";
			}
			if (element.matches(".params-advisories")) {
				return "notes";
			}
			return element.matches(".params-replaced") ? "problems" : "output-limit";
		}
	);
	expect(blocks).toEqual(["output-limit", "problems", "notes", "record-paths"]);
});

test("the collapsed disclosure joins the focus trap: Tab wraps at the summary, never at a hidden chain button", () => {
	// The disclosure is the dialog's last tabbable while collapsed. The trap
	// must treat the SUMMARY as the boundary: counting the chain-jump buttons
	// hidden inside the closed details would let Tab escape the dialog at the
	// real boundary and land Shift+Tab wrapping on an unfocusable control.
	const inspected = makeModel();
	const container = mount(
		<ModelInspector model={inspected} stateSeq={0} onClose={() => {}} onEditRecord={() => {}} onEditEntry={() => {}} />
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
	const details = panel.querySelector("details.record-paths") as HTMLDetailsElement;
	expect(details.open).toBe(false);
	// The chain-jump buttons exist inside the closed disclosure.
	expect(details.querySelectorAll("button.chain-key").length).toBeGreaterThan(0);
	const summary = details.querySelector("summary") as HTMLElement;
	const fireTab = (element: HTMLElement, shiftKey: boolean) => {
		void act(() => {
			element.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
		});
	};
	summary.focus();
	fireTab(summary, false);
	expect((document.activeElement as HTMLElement | null)?.getAttribute("aria-label")).toBe("Close");
	fireTab(document.activeElement as HTMLElement, true);
	expect(document.activeElement).toBe(summary);
});

test("a stateSeq bump re-requests BOTH feeds, so an open inspector follows configuration edits", () => {
	const container = mount(<ModelInspector model={model} stateSeq={0} onClose={() => {}} />);
	expect(postedRequests("readModelParameters")).toHaveLength(1);
	expect(postedRequests("readModelCapabilities")).toHaveLength(1);

	// The same tree re-rendered with a bumped stateSeq (a state push landed):
	// the inspector must ask again instead of trusting its pre-edit answers.
	void act(() => {
		render(<ModelInspector model={model} stateSeq={1} onClose={() => {}} />, container);
	});
	for (const method of ["readModelParameters", "readModelCapabilities"] as const) {
		const requests = postedRequests(method);
		expect(requests).toHaveLength(2);
		// A fresh correlation id per request, so the first answer cannot satisfy the second ask.
		expect(requests[0]?.id).not.toBe(requests[1]?.id);
	}
});

test("a params response for another request id is ignored; the loading note stays", () => {
	const root = mount(<ModelInspector model={model} stateSeq={0} onClose={() => {}} />);
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
	expect(root.querySelector("table.params")).toBeNull();
});

test("a caps response for another request id is ignored; only the correlated one renders", () => {
	const root = mount(<ModelInspector model={makeModel()} stateSeq={0} onClose={() => {}} />);
	pushToWebview({
		kind: "response",
		id: "someone-elses",
		method: "readModelCapabilities",
		payload: { capabilities: makeCapabilities() },
	});
	expect(root.textContent).toContain("Resolving capabilities...");
	expect(root.querySelector("table.params")).toBeNull();
});

test("a projection-less params response says the state moved on instead of inventing values", () => {
	const container = mount(<ModelInspector model={model} stateSeq={0} onClose={() => {}} />);
	respondTo(lastRequest("readModelParameters"), {});
	expect(container.textContent).toContain("The model list changed");
	expect(container.querySelector("table.params")).toBeNull();
});

test("the header states the raw ID and the server label", () => {
	const root = mountParamsAnswered({});
	expect(textOf(root, ".params-identity")).toBe("gpt-4o on Prod");
	expect(root.textContent).toContain("Always sent");
});

test("a global match renders as a sent row sourced to the settings layer and its winning key", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { temperature: 0.2 } } });
	const row = root.querySelector("table.params tbody tr") as HTMLElement;
	const cells = Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").trim());
	expect(cells).toEqual(["temperature", "0.2", "Settings - gpt-4*"]);
	expect(row.classList.contains("param-not-sent")).toBe(false);
});

test("an entry override names the entry layer and shows the shadowed global value struck through", () => {
	const root = mountParamsAnswered({
		entryParameters: { "gpt-4*": { temperature: 0.1 } },
		entryLabel: "Team A",
		globalParameters: { "gpt-4*": { temperature: 0.8, top_p: 0.9 } },
	});
	const rows = Array.from(root.querySelectorAll("table.params tbody tr"));
	const texts = rows.map((row) =>
		Array.from(row.querySelectorAll("td"))
			.map((cell) => (cell.textContent ?? "").trim())
			.join(" | ")
	);
	expect(texts).toEqual([
		'temperature | 0.1 | Server entry "Team A" - gpt-4*',
		" | 0.8 | overridden: Settings - gpt-4*",
		"top_p | 0.9 | Settings - gpt-4*",
	]);
	const shadowed = root.querySelector("tr.param-shadowed") as HTMLElement;
	expect(shadowed.querySelector(".param-value")).not.toBeNull();
});

test("an inherited field renders its writer key with the inherited-from note", () => {
	const root = mountParamsAnswered({
		globalParameters: {
			"*": { top_p: 0.9, _inheritable: true },
			"gpt-4*": { temperature: 0.3 },
		},
	});
	const rows = Array.from(root.querySelectorAll("table.params tbody tr"));
	const texts = rows.map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim());
	expect(texts.some((text) => text.includes("Settings - *") && text.includes("inherited from *"))).toBe(true);
	expect(texts.some((text) => text.includes("Settings - gpt-4*") && !text.includes("inherited"))).toBe(true);
});

test("unknown underscore keys never surface; provider-owned keys render muted with the not-sent reason", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { _internal: true, stream: false } } });
	const rows = Array.from(root.querySelectorAll("table.params tbody tr")) as HTMLElement[];
	expect(rows.length).toBe(1);
	expect(rows.every((row) => row.classList.contains("param-not-sent"))).toBe(true);
	expect(root.textContent).not.toContain("_internal");
	expect(root.textContent).toContain("not sent: a provider-owned request field");
});

test("a forced row states that it overrides runtime options, and the runtime caveat excepts it", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { temperature: 0.2, _force: true } } });
	expect(root.textContent).toContain("forced: overrides runtime options and the picker");
	expect(root.textContent).toContain("they override every row above except forced rows.");
});

test("without forced rows the runtime caveat keeps its unconditional wording", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { temperature: 0.2 } } });
	expect(root.textContent).not.toContain("forced:");
	expect(root.textContent).toContain("they override every row above.");
});

test("_force diagnostics render like the capability side's: unforceable keys and malformed lists", () => {
	const root = mountParamsAnswered({
		globalParameters: { "gpt-4*": { temperature: 0.2, model: "other", _force: ["model", "typo_entry"] } },
	});
	expect(root.textContent).toContain("Configuration problems in the matched records:");
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

test("clean configuration renders no diagnostics block", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { temperature: 0.2, _force: ["temperature"] } } });
	expect(root.textContent).not.toContain("Configuration problems in the matched records:");
});

test("the max_tokens derivation states the configured branch with its attribution", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { max_tokens: 2222 } } });
	expect(textOf(root, ".params-max-tokens")).toBe("max_tokens 2222 set by Settings - gpt-4*");
	// A configured max_tokens is the derivation's story, never a table row -
	// and it is real configuration, so the empty-state line must not claim
	// nothing matched.
	expect(root.querySelector("table.params")).toBeNull();
	expect(root.querySelector(".params-empty")).toBeNull();
});

test("the max_tokens derivation states the declared and capped-default branches", () => {
	const declared = mountParamsAnswered({ modelOverrides: { maxOutputTokens: 32000, outputLimitDeclared: true } });
	expect(textOf(declared, ".params-max-tokens")).toContain("max_tokens 32000 the server's declared output limit");

	const capped = mountParamsAnswered({ modelOverrides: { maxOutputTokens: 32000, outputLimitDeclared: false } });
	expect(textOf(capped, ".params-max-tokens")).toContain("max_tokens 4096 min(4096, model max)");
});

test("a forced max_tokens reports the forced derivation with its attribution", () => {
	const root = mountParamsAnswered({ globalParameters: { "gpt-4*": { max_tokens: 2222, _force: ["max_tokens"] } } });
	expect(textOf(root, ".params-max-tokens")).toBe(
		"max_tokens 2222 forced by Settings - gpt-4*; overrides runtime options and the picker"
	);
});

test("the runtime caveat always renders; the picker caveat only on reasoning models", () => {
	const plain = mountParamsAnswered({});
	expect(plain.textContent).toContain("Runtime options");
	expect(plain.textContent).not.toContain("reasoning effort");

	cleanup();
	resetPosted();
	const reasoning = mountParamsAnswered({ modelOverrides: { reasoning: true } });
	expect(reasoning.textContent).toContain("Runtime options");
	expect(reasoning.textContent).toContain("stored by VS Code");
});

test("the zero-config empty state still shows max_tokens and the caveats", () => {
	const root = mountParamsAnswered({});
	expect(textOf(root, ".params-empty")).toContain("No configured parameters match this model");
	expect(root.querySelector(".params-max-tokens")).not.toBeNull();
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
	// The inspected identity includes scopeKey: two snapshots can render the
	// same raw ID under the same display label, and each Inspect action must
	// ask about exactly the row it sits on.
	const rows = [makeModel({ ...model, scopeKey: "s0" }), makeModel({ ...model, scopeKey: "s1" })];
	mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				servers: [makeDeclaredServer(), makeDeclaredServer({ label: "Prod", baseUrl: "http://other:4000" })],
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
	expect(textOf(dialog, ".params-identity")).toBe("gpt-4o on B");
});

test("the header keeps ONE orientation line - family and capability chips - and repeats no token counts", () => {
	// The old facts grid duplicated the capabilities table's provenance-aware
	// Max input/output rows verbatim; the header now orients only (family and
	// capability chips), and the token limits render exactly once, below, with
	// their sources. Pricing stays deliberately absent too - it renders exactly
	// once, in the provenance-aware Pricing section.
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
	const line = root.querySelector(".model-orientation");
	expect(line).not.toBeNull();
	expect(line?.textContent).toContain("Family");
	expect(line?.textContent).toContain("gpt");
	const chips = [...(line?.querySelectorAll(".cap-chip") ?? [])].map((chip) => chip.textContent);
	expect(chips).toEqual(["tools", "vision"]);
	// The facts grid is gone, and no token count renders anywhere in the header.
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
	const line = root.querySelector(".model-orientation");
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
	const table = root.querySelector("table.params");
	expect(table).not.toBeNull();
	// 7 field rows + 1 shadowed row.
	expect(table?.querySelectorAll("tbody tr").length).toBe(8);
	const text = table?.textContent ?? "";
	expect(text).toContain("Context length");
	expect(text).toContain((200000).toLocaleString());
	expect(text).toContain("Server entry - gpt-4");
	expect(text).toContain("overridden: Settings - gpt");
	expect(text).toContain("Server-reported");
	expect(text).toContain("Built-in default");
});

test("declared, directive-not-found, inherited fields, and diagnostics all render their notes", () => {
	const root = mountCapsAnswered(
		makeCapabilities({
			directive: { kind: "not-found", id: "openai/nope" },
			fields: {
				...makeCapabilities().fields,
				context_length: { value: 200000, level: "global", key: "gpt*", inheritedFrom: "gpt*", shadowed: [] },
			},
			diagnostics: [{ kind: "unrecognized-key", key: "supports_web_search", layer: "global", recordKey: "gpt-4" }],
		}),
		{ declared: true }
	);
	const text = root.textContent ?? "";
	expect(text).toContain("Declared model");
	expect(text).toContain('"openai/nope" was not found');
	expect(text).toContain("inherited from gpt*");
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
	return (cell.querySelector(".tip-wrap > span:not(.help-tip)") ?? cell).textContent;
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
	const names = [...root.querySelectorAll("table.params tbody tr:not(.param-shadowed) td.param-name")].map(nameText);
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
	const bands = [...root.querySelectorAll("tr.caps-section th")].map((cell) => cell.textContent);
	expect(bands).toEqual(["Other fields"]);
	const text = root.textContent ?? "";
	// Open values render as plain numbers, never token-formatted.
	expect(text).toContain("custom_rank");
	// An open boolean keeps the yes/no idiom.
	const webSearchRow = [...root.querySelectorAll("table.params tbody tr")].find((row) =>
		row.textContent?.includes("supports_web_search")
	);
	expect(webSearchRow?.textContent).toContain("yes");
	expect(webSearchRow?.textContent).toContain("Server entry - gpt-4");
});

test("a core-only response renders no in-table bands; the section headers carry the document structure", () => {
	const root = mountCapsAnswered(makeCapabilities());
	expect(root.querySelectorAll("tr.caps-section").length).toBe(0);
	const headers = [...root.querySelectorAll("h4.inspector-section")].map((h) =>
		(h.firstChild?.textContent ?? "").trim()
	);
	expect(headers).toEqual(["Parameters", "Capabilities"]);
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
	// The cost rows live under the Pricing section header - the one pricing
	// rendering in the whole panel (the old facts-grid pricing lines are gone).
	const pricingSection = root.querySelector("#inspector-section-pricing")?.closest("section") as HTMLElement;
	expect(pricingSection).not.toBeNull();
	const pricingRows = [...pricingSection.querySelectorAll("table.params tbody tr")].filter((row) =>
		row.querySelector(".param-value")
	);
	const values = pricingRows.map((row) => row.querySelector(".param-value")?.textContent ?? "");
	expect(values).toContain("$5.00");
	expect(values).toContain("$25.00");
	expect(values).toContain("$0.50");
	expect(values).toContain("$6.25");
	// The shadowed cost formats as $/M too, and nothing renders as 5e-7.
	expect(pricingSection.querySelector("tr.param-shadowed .param-value")?.textContent).toBe("$37.50");
	for (const value of values) {
		expect(value).not.toMatch(/\de[+-]?\d/);
	}
	// No dollar amount renders anywhere outside the Pricing section.
	const outside = (root.textContent ?? "").split("Pricing ($/M tokens)")[0] ?? "";
	expect(outside).not.toContain("$");
	// The friendly labels replace the raw wire keys, which stay one focusable
	// tip away (the label hides the very key a capabilities record needs).
	const names = pricingRows.map((row) => nameText(row.querySelector(".param-name")));
	expect(names).toContain("Input");
	expect(names).toContain("Cache read");
	expect(names).not.toContain("input_cost_per_token");
	const inputRow = pricingRows.find((row) => nameText(row.querySelector(".param-name")) === "Input");
	const nameTip = inputRow?.querySelector(".param-name .tip-wrap");
	expect(nameTip?.getAttribute("tabindex")).toBe("0");
	expect(nameTip?.querySelector('[role="tooltip"]')?.textContent).toBe("input_cost_per_token");
});

test("the supported-params list renders in the PARAMETERS section: count row plus the full sorted pill list", () => {
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
	const paramsSection = root.querySelector("#inspector-section-params")?.closest("section") as HTMLElement;
	expect(paramsSection).not.toBeNull();
	const row = [...paramsSection.querySelectorAll("table.params tbody tr")].find((candidate) =>
		candidate.textContent?.includes("27 parameters")
	);
	expect(row).not.toBeUndefined();
	expect(nameText(row?.querySelector(".param-name") ?? null)).toBe("Supported parameters");
	// Its own table still names its columns for assistive tech: the band
	// carries the visible label, the collapsed thead the semantics.
	expect(row?.closest("table")?.querySelector("thead.caps-head-hidden")).not.toBeNull();
	// The count renders plain (no clip-tip): the full list follows on its own
	// row spanning the table, one element per name so boundaries survive a
	// comma inside a name - the panel is the detail surface, nothing hides
	// behind a tip.
	expect(row?.querySelector('.param-value [role="tooltip"]')).toBeNull();
	const listItems = [...paramsSection.querySelectorAll(".caps-params-list li code")].map((item) => item.textContent);
	expect(listItems).toEqual([...long].sort());
	// The list row spans all three columns, and a shadowed list stays
	// count-only (its record holds the value; the full row shows the winner).
	const listCell = paramsSection.querySelector(".caps-params-row td");
	expect(listCell?.getAttribute("colspan")).toBe("3");
	const shadowedLine = [...paramsSection.querySelectorAll("tr.param-shadowed")].find((candidate) =>
		candidate.textContent?.includes("1 parameter")
	);
	expect(shadowedLine).not.toBeUndefined();
	expect(shadowedLine?.textContent).not.toContain("temperature");
	// The Capabilities section renders the list nowhere - one rendering only.
	const capsSection = root.querySelector("#inspector-section-caps")?.closest("section") as HTMLElement;
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
	// An empty list renders no list row at all - a bare pill strip under the
	// count would read as a rendering bug.
	expect(empty.querySelector(".caps-params-list")).toBeNull();
});

test("prototype-named open fields render from the bag, never from Object.prototype", () => {
	const core = makeCapabilities().fields;
	const fields = Object.fromEntries([
		...Object.entries(core),
		["__proto__", { value: 1, level: "server", shadowed: [] }],
		["toString", { value: "shadowed-name", level: "global", key: "*", shadowed: [] }],
	]) as EffectiveCapabilities["fields"];
	const root = mountCapsAnswered(makeCapabilities({ fields }));
	const names = [...root.querySelectorAll("table.params tbody tr td.param-name")].map((cell) => cell.textContent);
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
	const tipWrap = root.querySelector(".param-value .tip-wrap");
	expect(tipWrap).not.toBeNull();
	expect(tipWrap?.getAttribute("tabindex")).toBe("0");
	expect(tipWrap?.querySelector('[role="tooltip"]')?.textContent).toBe(JSON.stringify(long));
	// The short core values stay plain text outside the Tab order.
	expect(root.querySelectorAll(".param-value .tip-wrap").length).toBe(1);
});

test("the clip tip's threshold sits exactly at the 8ch box, counting wide glyphs double", () => {
	const tipCount = (value: string): number => {
		const root = mountCapsAnswered(
			makeCapabilities({
				fields: { ...makeCapabilities().fields, note: { value, level: "server", shadowed: [] } },
			})
		);
		const count = root.querySelectorAll(".param-value .tip-wrap").length;
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
	const advisories = root.querySelector(".params-advisories");
	expect(advisories).not.toBeNull();
	expect(advisories?.textContent).toContain("applied as an override as-is");
	expect(advisories?.querySelector("li")?.className).toBe("hint");
	// The record diagnostics live at the end of the Capabilities section (near
	// the records they judge), never dangling after Pricing.
	expect(advisories?.closest("section")?.querySelector("#inspector-section-caps")).not.toBeNull();
	// The real problem stays under the problems heading, not among the notes.
	const text = root.textContent ?? "";
	expect(text).toContain("Configuration problems in the matched records:");
	expect(advisories?.textContent).not.toContain("invalid value");
});

test("the declared badge follows the model's verdict: a discovered model shows no badge", () => {
	// The badge rides model.declared (what registration served), never the
	// record configuration; a discovered model must not claim "not discovered".
	const root = mountCapsAnswered(makeCapabilities());
	expect(root.textContent).not.toContain("Declared model");
});

test("the output-limit note follows outputLimitSource", () => {
	expect(mountCapsAnswered(makeCapabilities({ outputLimitSource: "user" })).textContent).toContain(
		"user-set; requests send it uncapped"
	);
	cleanup();
	resetPosted();
	expect(mountCapsAnswered(makeCapabilities({ outputLimitSource: "defaults" })).textContent).toContain(
		"cap max_tokens at 4096"
	);
});

test("an empty-capabilities response says the state moved on instead of inventing values", () => {
	const root = mountCapsAnswered(undefined);
	expect(root.textContent).toContain("The model list changed");
	expect(root.querySelector("table.params")).toBeNull();
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

		// The row carries ONE Inspect action opening the merged panel anchored
		// on its Parameters section - scrolled there AND focused there, so the
		// next Tab continues from the section instead of the panel's first
		// field.
		const inspectLink = document.querySelector("button[aria-label='Inspect gpt-4o on Prod']") as HTMLButtonElement;
		expect(inspectLink).not.toBeNull();
		fireClick(inspectLink);
		expect(document.querySelector("[role='dialog']")).not.toBeNull();
		expect(textOf(document.body, "#model-inspector-title")).toContain("Omni");
		expect(landings).toContain("inspector-section-params");
		expect((document.activeElement as HTMLElement | null)?.id).toBe("inspector-section-params");
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
		const container = mount(<ModelInspector {...props} stateSeq={0} />);
		expect(landings).toContain("inspector-section-caps");

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
			render(<ModelInspector {...props} stateSeq={1} />, container);
		});
		answer();
		expect(landings).toEqual([]);
	} finally {
		Element.prototype.scrollIntoView = original;
	}
});
