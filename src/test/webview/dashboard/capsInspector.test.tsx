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
	const container = mount(<CapsInspector model={model} response={undefined} stateSeq={0} onClose={() => {}} />);
	const request = postedMessages.at(-1) as { type: string; requestId: string; scopeKey: string; rawId: string };
	expect(request.type).toBe("readModelCapabilities");
	expect(request.scopeKey).toBe(model.scopeKey);
	expect(request.rawId).toBe(model.rawId);
	void act(() => {
		render(
			<CapsInspector
				model={model}
				response={{ type: "modelCapabilities", requestId: request.requestId, capabilities }}
				stateSeq={0}
				onClose={() => {}}
			/>,
			container
		);
	});
	return container;
}

test("opening posts one readModelCapabilities request and shows the loading note until it is answered", () => {
	const root = mount(<CapsInspector model={makeModel()} response={undefined} stateSeq={0} onClose={() => {}} />);
	expect(postedMessages.length).toBe(1);
	expect(postedMessages[0]?.type).toBe("readModelCapabilities");
	expect(root.textContent).toContain("Resolving capabilities...");
});

test("a stateSeq bump re-requests, so an open inspector follows configuration edits", () => {
	const model = makeModel();
	const container = mount(<CapsInspector model={model} response={undefined} stateSeq={0} onClose={() => {}} />);
	expect(postedMessages.filter((message) => message.type === "readModelCapabilities")).toHaveLength(1);

	// The same tree re-rendered with a bumped stateSeq (a state push landed):
	// the inspector must ask again instead of trusting its pre-edit answer.
	void act(() => {
		render(<CapsInspector model={model} response={undefined} stateSeq={1} onClose={() => {}} />, container);
	});
	const requests = postedMessages.filter((message) => message.type === "readModelCapabilities");
	expect(requests).toHaveLength(2);
	// A fresh requestId per request, so the first answer cannot satisfy the second ask.
	expect((requests[0] as { requestId: string }).requestId).not.toBe((requests[1] as { requestId: string }).requestId);
});

test("a response for another requestId is ignored; only the correlated one renders", () => {
	const root = mount(
		<CapsInspector
			model={makeModel()}
			response={{ type: "modelCapabilities", requestId: "someone-elses", capabilities: makeCapabilities() }}
			stateSeq={0}
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
	const root = answeredInPlace(
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

test("a seven-field response renders no section bands; extras open the labeled sections", () => {
	const root = answeredInPlace(makeCapabilities());
	expect(root.querySelectorAll("tr.caps-section").length).toBe(0);
	cleanup();
	resetPosted();
	const sectioned = answeredInPlace(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				input_cost_per_token: { value: 0.000005, level: "server", shadowed: [] },
				supported_openai_params: { value: ["temperature"], level: "server", shadowed: [] },
				supports_web_search: { value: true, level: "server", shadowed: [] },
			},
		})
	);
	const bands = [...sectioned.querySelectorAll("tr.caps-section th")].map((cell) => cell.textContent);
	expect(bands).toEqual(["Capabilities", "Pricing ($/M tokens)", "Supported parameters", "Other fields"]);
});

test("cost fields render as $/M under the pricing band, never in scientific notation", () => {
	const root = answeredInPlace(
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
	const pricingRows = [...root.querySelectorAll("table.params tbody tr")].filter((row) =>
		row.querySelector(".param-value")
	);
	const values = pricingRows.map((row) => row.querySelector(".param-value")?.textContent ?? "");
	expect(values).toContain("$5.00");
	expect(values).toContain("$25.00");
	expect(values).toContain("$0.50");
	expect(values).toContain("$6.25");
	// The shadowed cost formats as $/M too, and nothing renders as 5e-7.
	expect(root.querySelector("tr.param-shadowed .param-value")?.textContent).toBe("$37.50");
	for (const value of values) {
		expect(value).not.toMatch(/\de[+-]?\d/);
	}
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

test("the params list renders its count with the full list behind it; the empty list counts zero", () => {
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
	const root = answeredInPlace(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				supported_openai_params: { value: long, level: "server", shadowed: [] },
			},
		})
	);
	const row = [...root.querySelectorAll("table.params tbody tr")].find((candidate) =>
		candidate.textContent?.includes("27 parameters")
	);
	expect(row).not.toBeUndefined();
	expect(nameText(row?.querySelector(".param-name") ?? null)).toBe("Supported parameters");
	// The value clips, so the focusable tip carries the count plus the full
	// list - as exact JSON, so element boundaries survive a comma inside a
	// name.
	const tip = row?.querySelector('.param-value [role="tooltip"]')?.textContent ?? "";
	expect(tip).toContain("27 parameters");
	expect(tip).toContain(`: ${JSON.stringify(long)}`);
	cleanup();
	resetPosted();
	const empty = answeredInPlace(
		makeCapabilities({
			fields: {
				...makeCapabilities().fields,
				supported_openai_params: { value: [], level: "server", shadowed: [] },
			},
		})
	);
	expect(empty.textContent).toContain("0 parameters");
});

test("prototype-named open fields render from the bag, never from Object.prototype", () => {
	const core = makeCapabilities().fields;
	const fields = Object.fromEntries([
		...Object.entries(core),
		["__proto__", { value: 1, level: "server", shadowed: [] }],
		["toString", { value: "shadowed-name", level: "global", key: "*", shadowed: [] }],
	]) as EffectiveCapabilities["fields"];
	const root = answeredInPlace(makeCapabilities({ fields }));
	const names = [...root.querySelectorAll("table.params tbody tr td.param-name")].map((cell) => cell.textContent);
	expect(names).toContain("__proto__");
	expect(names).toContain("toString");
	const text = root.textContent ?? "";
	expect(text).toContain('"shadowed-name"');
	expect(({} as Record<string, unknown>).toString).toBe(Object.prototype.toString);
});

test("a value long enough to clip gets the focusable full-text tip; short values stay plain", () => {
	const long = ["temperature", "top_p", "max_tokens", "stream", "stop", "tools", "tool_choice"];
	const root = answeredInPlace(
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
		const root = answeredInPlace(
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
	const root = answeredInPlace(
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
	// The real problem stays under the problems heading, not among the notes.
	const text = root.textContent ?? "";
	expect(text).toContain("Configuration problems in the matched records:");
	expect(advisories?.textContent).not.toContain("invalid value");
});

test("the declared badge follows the model's verdict: a discovered model shows no badge", () => {
	// The badge rides model.declared (what registration served), never the
	// record configuration; a discovered model must not claim "not discovered".
	const root = answeredInPlace(makeCapabilities());
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
