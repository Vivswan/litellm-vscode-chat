/**
 * The effective-parameters inspector's rendering pins. The inspector is
 * request/response-fed like its capability twin: it posts readModelParameters
 * on open and renders the projection the extension resolves. The resolution
 * itself is owned by the shared module (unit + equivalence property suites in
 * the extension host); these tests run projectEffectiveParameters over the
 * same inputs and feed the result back as protocol data, pinning only what
 * the webview shows: the row action that opens it, the identity header,
 * source naming, shadowed and inherited rendering, the not-sent reasons, the
 * max_tokens derivation wording per branch, the honest caveats, and the empty
 * state.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { projectEffectiveParameters } from "../../../shared/config/parameterResolution";
import { App } from "../../../webview/dashboard/app";
import { ParamsInspector } from "../../../webview/dashboard/paramsInspector";
import { makeDeclaredServer, makeModel, makeSettings, makeState, statePush } from "../fixtures";
import { cleanup, fireClick, mount, postedMessages, pushToWebview, resetPosted, textOf } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

const model = makeModel({ id: "gpt-4o", rawId: "gpt-4o", name: "Omni", serverLabel: "Prod", scopeKey: "s0" });

/**
 * Mount the inspector, capture its own posted requestId, then rerender the
 * same tree with the correlated response - exactly how App's response state
 * reaches an already-open inspector. The projection is computed by the SAME
 * shared function the extension answers with, over the inputs the options
 * describe.
 */
function mountInspector(options: {
	globalParameters?: Record<string, Record<string, unknown>>;
	entryParameters?: Record<string, Record<string, unknown>>;
	entryLabel?: string;
	modelOverrides?: Parameters<typeof makeModel>[0];
	onClose?: () => void;
}) {
	const inspected = makeModel({ ...model, ...options.modelOverrides });
	const onClose = options.onClose ?? (() => {});
	const container = mount(<ParamsInspector model={inspected} response={undefined} stateSeq={0} onClose={onClose} />);
	const request = postedMessages.at(-1) as { type: string; requestId: string; scopeKey: string; rawId: string };
	expect(request.type).toBe("readModelParameters");
	expect(request.scopeKey).toBe(inspected.scopeKey);
	expect(request.rawId).toBe(inspected.rawId);
	const projection = projectEffectiveParameters({
		rawModelId: inspected.rawId,
		globalParameters: options.globalParameters ?? {},
		entryParameters: options.entryParameters,
		maxOutputTokens: inspected.maxOutputTokens,
		outputLimitDeclared: inspected.outputLimitDeclared,
	});
	void act(() => {
		render(
			<ParamsInspector
				model={inspected}
				response={{
					type: "modelParameters",
					requestId: request.requestId,
					projection,
					...(options.entryLabel !== undefined ? { entryLabel: options.entryLabel } : {}),
				}}
				stateSeq={0}
				onClose={onClose}
			/>,
			container
		);
	});
	return container;
}

test("the models table row carries a quiet Parameters action that opens the inspector dialog", () => {
	mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()], models: [model] })));
	const action = document.querySelector("button[aria-label='Show effective parameters for Omni on Prod']");
	expect(action).not.toBeNull();
	expect((action?.textContent ?? "").trim()).toBe("Parameters");
	expect(document.querySelector("[role='dialog']")).toBeNull();

	fireClick(action as HTMLButtonElement);
	const dialog = document.querySelector("[role='dialog']") as HTMLElement;
	expect(dialog).not.toBeNull();
	expect(textOf(dialog, "#params-inspector-title")).toContain("Omni");
	// Opening posts the read for exactly the clicked row; the answer renders later.
	const request = postedMessages.at(-1) as { type: string; scopeKey: string; rawId: string };
	expect(request.type).toBe("readModelParameters");
	expect(request.scopeKey).toBe("s0");
	expect(request.rawId).toBe("gpt-4o");
	expect(dialog.textContent).toContain("Resolving parameters...");

	// The X closes it again (SlideOver's close request maps straight to close;
	// a read-only view has nothing to confirm).
	fireClick(dialog.querySelector("button[aria-label='Close']") as HTMLButtonElement);
	expect(document.querySelector("[role='dialog']")).toBeNull();
});

test("a response for another requestId is ignored; the loading note stays", () => {
	const root = mount(
		<ParamsInspector
			model={model}
			response={{
				type: "modelParameters",
				requestId: "someone-elses",
				projection: projectEffectiveParameters({
					rawModelId: model.rawId,
					globalParameters: { "gpt-4*": { temperature: 0.2 } },
					maxOutputTokens: model.maxOutputTokens,
					outputLimitDeclared: model.outputLimitDeclared,
				}),
			}}
			stateSeq={0}
			onClose={() => {}}
		/>
	);
	expect(root.textContent).toContain("Resolving parameters...");
	expect(root.querySelector("table.params")).toBeNull();
});

test("a stateSeq bump re-requests, so an open inspector follows configuration edits", () => {
	const container = mount(<ParamsInspector model={model} response={undefined} stateSeq={0} onClose={() => {}} />);
	expect(postedMessages.filter((message) => message.type === "readModelParameters")).toHaveLength(1);

	// The same tree re-rendered with a bumped stateSeq (a state push landed):
	// the inspector must ask again instead of trusting its pre-edit answer.
	void act(() => {
		render(<ParamsInspector model={model} response={undefined} stateSeq={1} onClose={() => {}} />, container);
	});
	const requests = postedMessages.filter((message) => message.type === "readModelParameters");
	expect(requests).toHaveLength(2);
	// A fresh requestId per request, so the first answer cannot satisfy the second ask.
	expect((requests[0] as { requestId: string }).requestId).not.toBe((requests[1] as { requestId: string }).requestId);
});

test("a projection-less response says the state moved on instead of inventing values", () => {
	const container = mount(<ParamsInspector model={model} response={undefined} stateSeq={0} onClose={() => {}} />);
	const request = postedMessages.at(-1) as { requestId: string };
	void act(() => {
		render(
			<ParamsInspector
				model={model}
				response={{ type: "modelParameters", requestId: request.requestId }}
				stateSeq={0}
				onClose={() => {}}
			/>,
			container
		);
	});
	expect(container.textContent).toContain("The model list changed");
	expect(container.querySelector("table.params")).toBeNull();
});

test("the header states the raw ID and the server label", () => {
	const root = mountInspector({});
	expect(textOf(root, ".params-identity")).toBe("gpt-4o on Prod");
	expect(root.textContent).toContain("Always sent");
});

test("a global match renders as a sent row sourced to the settings layer and its winning key", () => {
	const root = mountInspector({ globalParameters: { "gpt-4*": { temperature: 0.2 } } });
	const row = root.querySelector("table.params tbody tr") as HTMLElement;
	const cells = Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").trim());
	expect(cells).toEqual(["temperature", "0.2", "Settings - gpt-4*"]);
	expect(row.classList.contains("param-not-sent")).toBe(false);
});

test("an entry override names the entry layer and shows the shadowed global value struck through", () => {
	const root = mountInspector({
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
	const root = mountInspector({
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
	const root = mountInspector({ globalParameters: { "gpt-4*": { _internal: true, stream: false } } });
	const rows = Array.from(root.querySelectorAll("table.params tbody tr")) as HTMLElement[];
	expect(rows.length).toBe(1);
	expect(rows.every((row) => row.classList.contains("param-not-sent"))).toBe(true);
	expect(root.textContent).not.toContain("_internal");
	expect(root.textContent).toContain("not sent: a provider-owned request field");
});

test("a forced row states that it overrides runtime options, and the runtime caveat excepts it", () => {
	const root = mountInspector({ globalParameters: { "gpt-4*": { temperature: 0.2, _force: true } } });
	expect(root.textContent).toContain("forced: overrides runtime options and the picker");
	expect(root.textContent).toContain("they override every row above except forced rows.");
});

test("without forced rows the runtime caveat keeps its unconditional wording", () => {
	const root = mountInspector({ globalParameters: { "gpt-4*": { temperature: 0.2 } } });
	expect(root.textContent).not.toContain("forced:");
	expect(root.textContent).toContain("they override every row above.");
});

test("_force diagnostics render like the capability inspector's: unforceable keys and malformed lists", () => {
	const root = mountInspector({
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
	const root = mountInspector({
		globalParameters: { "gpt*4o": { temperature: 0.2 }, "gpt-4o": { top_p: 0.5 } },
	});
	expect(root.textContent).toContain('"gpt*4o" is not a valid matcher key and never matches');
});

test("clean configuration renders no diagnostics block", () => {
	const root = mountInspector({ globalParameters: { "gpt-4*": { temperature: 0.2, _force: ["temperature"] } } });
	expect(root.textContent).not.toContain("Configuration problems in the matched records:");
});

test("the max_tokens derivation states the configured branch with its attribution", () => {
	const root = mountInspector({ globalParameters: { "gpt-4*": { max_tokens: 2222 } } });
	expect(textOf(root, ".params-max-tokens")).toBe("max_tokens 2222 set by Settings - gpt-4*");
	// A configured max_tokens is the derivation's story, never a table row -
	// and it is real configuration, so the empty-state line must not claim
	// nothing matched.
	expect(root.querySelector("table.params")).toBeNull();
	expect(root.querySelector(".params-empty")).toBeNull();
});

test("the max_tokens derivation states the declared and capped-default branches", () => {
	const declared = mountInspector({ modelOverrides: { maxOutputTokens: 32000, outputLimitDeclared: true } });
	expect(textOf(declared, ".params-max-tokens")).toContain("max_tokens 32000 the server's declared output limit");

	const capped = mountInspector({ modelOverrides: { maxOutputTokens: 32000, outputLimitDeclared: false } });
	expect(textOf(capped, ".params-max-tokens")).toContain("max_tokens 4096 min(4096, model max)");
});

test("a forced max_tokens reports the forced derivation with its attribution", () => {
	const root = mountInspector({ globalParameters: { "gpt-4*": { max_tokens: 2222, _force: ["max_tokens"] } } });
	expect(textOf(root, ".params-max-tokens")).toBe(
		"max_tokens 2222 forced by Settings - gpt-4*; overrides runtime options and the picker"
	);
});

test("the runtime caveat always renders; the picker caveat only on reasoning models", () => {
	const plain = mountInspector({});
	expect(plain.textContent).toContain("Runtime options");
	expect(plain.textContent).not.toContain("reasoning effort");

	cleanup();
	resetPosted();
	const reasoning = mountInspector({ modelOverrides: { reasoning: true } });
	expect(reasoning.textContent).toContain("Runtime options");
	expect(reasoning.textContent).toContain("stored by VS Code");
});

test("the zero-config empty state still shows max_tokens and the caveats", () => {
	const root = mountInspector({});
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
	fireClick(
		document.querySelector("button[aria-label='Show effective parameters for Omni on Prod']") as HTMLButtonElement
	);
	expect(document.querySelector("[role='dialog']")).not.toBeNull();

	pushToWebview(statePush({ ...withModel, models: [] }));
	expect(document.querySelector("[role='dialog']")).toBeNull();
});

test("two rows sharing an ID and display label still ask about their own snapshot", () => {
	// The inspected identity includes scopeKey: two snapshots can render the
	// same raw ID under the same display label, and each Parameters action
	// must ask about exactly the row it sits on.
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
	const actions = document.querySelectorAll("button[aria-label='Show effective parameters for Omni on Prod']");
	expect(actions.length).toBe(2);
	fireClick(actions[1] as HTMLButtonElement);
	expect(document.querySelector("[role='dialog']")).not.toBeNull();
	const request = postedMessages.at(-1) as { type: string; scopeKey: string; rawId: string };
	expect(request.type).toBe("readModelParameters");
	expect(request.scopeKey).toBe("s1");
	expect(request.rawId).toBe("gpt-4o");
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
	fireClick(
		document.querySelector("button[aria-label='Show effective parameters for Omni on B']") as HTMLButtonElement
	);
	const dialog = document.querySelector("[role='dialog']") as HTMLElement;
	expect(dialog).not.toBeNull();
	expect(textOf(dialog, ".params-identity")).toBe("gpt-4o on B");
});

test("the facts grid restates the model's table facts, with conditional pricing tiers", () => {
	// The inspector is self-contained on purpose: limits, pricing tiers, and
	// capabilities render here even though the table shows them, so reading a
	// model never requires closing the panel.
	const root = mountInspector({
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
	const facts = root.querySelector(".model-facts");
	expect(facts?.textContent).toContain("Family");
	expect(facts?.textContent).toContain("gpt");
	expect(facts?.textContent).toContain("tools, vision");
	expect(facts?.textContent).toContain("128,000");
	expect(facts?.textContent).toContain("4,096 (default, not server-declared)");
	expect(facts?.textContent).toContain("$2.5 in / $10 out");
	expect(facts?.textContent).toContain("read $0.25");
	expect(facts?.textContent).toContain("Long context ($/M)");
	expect(facts?.textContent).toContain("$5 in");

	// Absent tiers render no row at all, not an empty one.
	const bare = mountInspector({ modelOverrides: { cacheReadCost: undefined, longContextInputCost: undefined } });
	const bareFacts = bare.querySelector(".model-facts");
	expect(bareFacts?.textContent).not.toContain("Cache ($/M)");
	expect(bareFacts?.textContent).not.toContain("Long context");
});
