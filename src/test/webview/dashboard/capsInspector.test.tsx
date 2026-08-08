/**
 * CapsInspector rendering: the request/response feed (one
 * readModelCapabilities post per inspected model, uncorrelated responses
 * ignored), the provenance table with shadowed values, the directive and
 * declared notes, inherited-field notes, and the diagnostics list. The fixture
 * EffectiveCapabilities values are hand-built protocol data - the webview
 * never resolves anything itself, so the tests feed it exactly what the
 * extension would.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { EffectiveCapabilities } from "../../../extension/dashboard/protocol";
import { CapsInspector } from "../../../webview/dashboard/capsInspector";
import { makeModel } from "../fixtures";
import { cleanup, mount, postedMessages, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

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
		declare: false,
		diagnostics: [],
		...overrides,
	};
}

/**
 * Mount the inspector, capture its own posted requestId, then rerender the
 * same tree with the correlated response - exactly how App's response state
 * reaches an already-open inspector.
 */
function answeredInPlace(
	capabilities: EffectiveCapabilities | undefined,
	modelOverrides: Parameters<typeof makeModel>[0] = {}
): HTMLElement {
	const model = makeModel(modelOverrides);
	const container = mount(<CapsInspector model={model} response={undefined} onClose={() => {}} />);
	const request = postedMessages.at(-1) as { type: string; requestId: string; scopeKey: string; rawId: string };
	expect(request.type).toBe("readModelCapabilities");
	expect(request.scopeKey).toBe(model.scopeKey);
	expect(request.rawId).toBe(model.rawId);
	void act(() => {
		render(
			<CapsInspector
				model={model}
				response={{ type: "modelCapabilities", requestId: request.requestId, capabilities }}
				onClose={() => {}}
			/>,
			container
		);
	});
	return container;
}

test("opening posts one readModelCapabilities request and shows the loading note until it is answered", () => {
	const root = mount(<CapsInspector model={makeModel()} response={undefined} onClose={() => {}} />);
	expect(postedMessages.length).toBe(1);
	expect(postedMessages[0]?.type).toBe("readModelCapabilities");
	expect(root.textContent).toContain("Resolving capabilities...");
});

test("a response for another requestId is ignored; only the correlated one renders", () => {
	const root = mount(
		<CapsInspector
			model={makeModel()}
			response={{ type: "modelCapabilities", requestId: "someone-elses", capabilities: makeCapabilities() }}
			onClose={() => {}}
		/>
	);
	expect(root.textContent).toContain("Resolving capabilities...");
	expect(root.querySelector("table.params")).toBeNull();
});

test("the correlated response renders every field with its value and source level", () => {
	const root = answeredInPlace(
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
	const root = answeredInPlace(
		makeCapabilities({
			declare: true,
			directive: { kind: "not-found", id: "openai/nope" },
			fields: {
				...makeCapabilities().fields,
				context_length: { value: 200000, level: "global", key: "gpt*", inheritedFrom: "gpt*", shadowed: [] },
			},
			diagnostics: [{ kind: "unknown-key", key: "supports_pdf_input", layer: "global", recordKey: "gpt-4" }],
		}),
		{ declared: true }
	);
	const text = root.textContent ?? "";
	expect(text).toContain("Declared model");
	expect(text).toContain('"openai/nope" was not found');
	expect(text).toContain("inherited from gpt*");
	expect(text).toContain('"supports_pdf_input" is not a known capability field');
});

test("the declared badge follows the model's verdict, not the record's intent: an inert _declare shows no badge", () => {
	// capabilities.declare is config intent; a _declare shadowed by a
	// discovered ID leaves the model discovered, and the badge must not
	// claim "not discovered".
	const root = answeredInPlace(makeCapabilities({ declare: true }));
	expect(root.textContent).not.toContain("Declared model");
});

test("the output-limit note follows outputLimitSource", () => {
	expect(answeredInPlace(makeCapabilities({ outputLimitSource: "user" })).textContent).toContain(
		"user-set; requests send it uncapped"
	);
	cleanup();
	resetPosted();
	expect(answeredInPlace(makeCapabilities({ outputLimitSource: "defaults" })).textContent).toContain(
		"cap max_tokens at 4096"
	);
});

test("an empty-capabilities response says the state moved on instead of inventing values", () => {
	const root = answeredInPlace(undefined);
	expect(root.textContent).toContain("The model list changed");
	expect(root.querySelector("table.params")).toBeNull();
});
