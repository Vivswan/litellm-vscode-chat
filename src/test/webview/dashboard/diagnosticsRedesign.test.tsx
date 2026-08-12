/**
 * The Diagnostics tab's redesign surfaces: Configuration diagnostics rows and
 * the Resolved-models view (tree + flat provenance table + filter + the
 * per-row jump to the inspectors).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { ConfigDiagnosticView, ExtensionToWebviewMessage, ResolvedModelsView } from "../../../dashboard/protocol";
import { DiagnosticsSection } from "../../../webview/dashboard/diagnostics";
import { makeDeclaredServer } from "../fixtures";
import { buttonByText, cleanup, fireClick, fireInput, mount, postedMessages, resetPosted } from "../harness";

const NOW = 1_700_000_000_000;

beforeEach(resetPosted);
afterEach(cleanup);

function makeView(overrides: Partial<ResolvedModelsView> = {}): ResolvedModelsView {
	return {
		trees: [
			{
				kind: "parameters",
				layer: "global",
				roots: [
					{
						key: "*",
						fields: [{ name: "temperature", valueText: "0.7", inheritable: true, forced: false, fallback: false }],
						barrier: false,
						children: [
							{
								key: "gpt-5*",
								fields: [{ name: "temperature", valueText: "0.3", inheritable: true, forced: false, fallback: false }],
								barrier: true,
								inheritFrom: "false",
								children: [],
								models: [{ id: "gpt-5.6", resolvedText: "temperature 0.3" }],
							},
						],
						models: [],
					},
				],
				unmatchedModelIds: ["claude-4"],
				invalidKeys: ["gpt*5"],
			},
		],
		rows: [
			{
				serverLabel: "prod",
				rawId: "gpt-5.6",
				scopeKey: "s0",
				matchedKeys: ["*", "gpt-5*"],
				parameters: [{ name: "temperature", valueText: "0.3", layer: "global", key: "gpt-5*" }],
				capabilities: [{ name: "context_length", valueText: "128000", level: "server" }],
			},
			{
				serverLabel: "prod",
				rawId: "claude-4",
				scopeKey: "s0",
				matchedKeys: [],
				parameters: [],
				capabilities: [{ name: "context_length", valueText: "200000", level: "catalog", key: "anthropic/claude-4" }],
			},
		],
		recordCount: 2,
		...overrides,
	};
}

function mountDiagnostics(options: {
	diagnostics?: readonly ConfigDiagnosticView[];
	view?: ResolvedModelsView;
	onInspect?: (target: { scopeKey: string; rawId: string; serverLabel: string }, view: "params" | "caps") => void;
}) {
	const props = {
		servers: [makeDeclaredServer()],
		modelCount: 2,
		legacyServerCount: 0,
		diagnostics: options.diagnostics ?? [],
		active: true,
		stateSeq: 0,
		onInspect: options.onInspect ?? (() => undefined),
		now: NOW,
	};
	// First render posts the readResolvedModels request; re-rendering the SAME
	// tree with the echoed response (unchanged active/stateSeq, so no new
	// request fires) delivers it, exactly like the extension answering.
	const root = mount(<DiagnosticsSection {...props} resolvedResponse={undefined} />);
	const request = postedMessages.find((message) => message.type === "readResolvedModels");
	if (request === undefined || request.type !== "readResolvedModels") {
		throw new Error("no readResolvedModels request posted");
	}
	const response: ExtensionToWebviewMessage = {
		type: "resolvedModels",
		requestId: request.requestId,
		view: options.view ?? makeView(),
	};
	void act(() => {
		render(<DiagnosticsSection {...props} resolvedResponse={response} />, root);
	});
	return { root, response };
}

describe("Configuration diagnostics", () => {
	test("renders nothing when the settings are clean", () => {
		const root = mount(
			<DiagnosticsSection
				servers={[]}
				modelCount={0}
				legacyServerCount={0}
				diagnostics={[]}
				resolvedResponse={undefined}
				active={false}
				stateSeq={0}
				onInspect={() => undefined}
				now={NOW}
			/>
		);
		expect(root.querySelector(".config-diagnostics")).toBeNull();
	});

	test("renders one row per diagnostic with the offending key", () => {
		const diagnostics: ConfigDiagnosticView[] = [
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: { kind: "invalid-matcher", recordKey: "gpt*5", key: "gpt*5" },
				severity: "warning",
			},
			{
				kind: "entry",
				label: "prod",
				position: 1,
				problems: ['has an unknown auth key "apikey"'],
				misconfigured: true,
				severity: "warning",
			},
			{
				kind: "legacy",
				hint: "inert-url-scoped-key",
				oldKey: "https://gw/gpt-4",
				detail: "models.parameters",
				severity: "warning",
			},
			{
				kind: "legacy",
				hint: "parked-global-headers",
				oldKey: "headers",
				detail: "x-env, x-trace",
				severity: "warning",
			},
			{ kind: "thresholds", dropped: 2, severity: "warning" },
			{ kind: "hidden-groups", labels: ["prod-hidden"], severity: "warning" },
			{ kind: "hidden-groups", labels: ["prod-hidden", "staging-hidden"], severity: "warning" },
		];
		const root = mount(
			<DiagnosticsSection
				servers={[]}
				modelCount={0}
				legacyServerCount={0}
				diagnostics={diagnostics}
				resolvedResponse={undefined}
				active={false}
				stateSeq={0}
				onInspect={() => undefined}
				now={NOW}
			/>
		);
		const items = Array.from(root.querySelectorAll(".config-diagnostics li")).map((li) => li.textContent ?? "");
		expect(items).toHaveLength(7);
		expect(items[0]).toContain('"gpt*5"');
		expect(items[1]).toContain('"prod"');
		expect(items[1]).toContain("misconfigured");
		expect(items[2]).toContain("https://gw/gpt-4");
		expect(items[3]).toContain("x-env, x-trace");
		expect(items[3]).toContain("adopt");
		expect(items[4]).toContain("2");
		expect(items[5]).toContain('"prod-hidden"');
		expect(items[5]).toContain("hidden by an explicit removal");
		expect(items[6]).toContain("2 groups are hidden");
		expect(items[6]).toContain("prod-hidden, staging-hidden");
	});

	test("advisory rows render muted with the applied-as-is wording; warnings keep the warning tone", () => {
		const diagnostics: ConfigDiagnosticView[] = [
			{
				kind: "record",
				setting: "models.capabilities",
				diagnostic: { kind: "unrecognized-key", recordKey: "gpt-4", key: "supports_web_search" },
				severity: "advisory",
			},
			{
				kind: "record",
				setting: "models.capabilities",
				diagnostic: { kind: "invalid-value", recordKey: "gpt-4", key: "context_length" },
				severity: "warning",
			},
		];
		const root = mount(
			<DiagnosticsSection
				servers={[]}
				modelCount={0}
				legacyServerCount={0}
				diagnostics={diagnostics}
				resolvedResponse={undefined}
				active={false}
				stateSeq={0}
				onInspect={() => undefined}
				now={NOW}
			/>
		);
		const items = Array.from(root.querySelectorAll(".config-diagnostics li"));
		expect(items).toHaveLength(2);
		expect(items[0]?.className).toBe("hint");
		expect(items[0]?.textContent).toContain('"supports_web_search"');
		expect(items[0]?.textContent).toContain("applied as an override as-is");
		expect(items[1]?.className).toBe("state-warn");
		expect(items[1]?.textContent).toContain("invalid value");
	});
});

describe("Resolved models", () => {
	test("requests only while the tab is active", () => {
		mount(
			<DiagnosticsSection
				servers={[]}
				modelCount={0}
				legacyServerCount={0}
				diagnostics={[]}
				resolvedResponse={undefined}
				active={false}
				stateSeq={0}
				onInspect={() => undefined}
				now={NOW}
			/>
		);
		expect(postedMessages.filter((message) => message.type === "readResolvedModels")).toHaveLength(0);
	});

	test("draws the tree with fields, marks, barriers, leaves, and invalid keys", () => {
		const { root } = mountDiagnostics({});
		const tree = root.querySelector(".record-tree");
		expect(tree?.textContent).toContain("*");
		expect(tree?.textContent).toContain("temperature 0.7 (inheritable)");
		expect(tree?.textContent).toContain("inheritance stops here");
		expect(tree?.textContent).toContain("gpt-5.6");
		expect(tree?.textContent).toContain("1 model matches no record here");
		expect(tree?.textContent).toContain('"gpt*5" is not a valid matcher key');
	});

	test("the flat table filters by matcher key and jumps to the inspectors", () => {
		const jumps: [string, string, string, string][] = [];
		const { root } = mountDiagnostics({
			onInspect: (target, view) => {
				jumps.push([target.scopeKey, target.rawId, target.serverLabel, view]);
			},
		});
		expect(Array.from(root.querySelectorAll("table.resolved-models tbody tr"))).toHaveLength(2);
		const filter = root.querySelector<HTMLInputElement>(".filterbar input");
		if (filter === null) {
			throw new Error("no filter input");
		}
		// "show everything gpt-5* touched": the matcher key matches the row even
		// though the text is not part of the model ID.
		fireInput(filter, "gpt-5*");
		const rows = Array.from(root.querySelectorAll("table.resolved-models tbody tr"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.textContent).toContain("gpt-5.6");
		fireClick(buttonByText(rows[0] as HTMLElement, "Inspect"));
		expect(jumps).toEqual([["s0", "gpt-5.6", "prod", "params"]]);
	});

	test("the zero-record empty state still lists every model", () => {
		const { root } = mountDiagnostics({
			view: makeView({ trees: [], recordCount: 0 }),
		});
		expect(root.textContent).toContain("No matcher records configured");
		expect(Array.from(root.querySelectorAll("table.resolved-models tbody tr"))).toHaveLength(2);
	});

	test("a row's matcher keys render as quiet chips under its model ID", () => {
		const { root } = mountDiagnostics({});
		const first = root.querySelector("table.resolved-models tbody tr td.resolved-id");
		const chips = Array.from(first?.querySelectorAll(".resolved-matched .chip-matcher") ?? []).map(
			(chip) => chip.textContent
		);
		expect(chips).toEqual(["*", "gpt-5*"]);
	});

	test("cost cells collapse into one $/M pricing line with one badge when the source is uniform", () => {
		const { root } = mountDiagnostics({
			view: makeView({
				rows: [
					{
						serverLabel: "prod",
						rawId: "claude-4",
						scopeKey: "s0",
						matchedKeys: [],
						parameters: [],
						capabilities: [
							{ name: "context_length", valueText: "200000", level: "server" },
							{ name: "input_cost_per_token", valueText: "0.000005", level: "server" },
							{ name: "output_cost_per_token", valueText: "0.000025", level: "server" },
							{ name: "cache_read_input_token_cost", valueText: "5e-7", level: "server" },
						],
					},
				],
			}),
		});
		const cells = Array.from(root.querySelectorAll("table.resolved-models .resolved-cell"));
		const pricing = cells.find((cell) => cell.textContent?.includes("Pricing ($/M)"));
		expect(pricing).not.toBeUndefined();
		const text = pricing?.textContent ?? "";
		expect(text).toContain("Input $5.00");
		expect(text).toContain("Output $25.00");
		expect(text).toContain("Cache read $0.50");
		// Never scientific notation on the rendered line; the exact per-token
		// wire values stay one focusable tip away, keyed by their wire names.
		expect(text).not.toMatch(/\$\de[+-]?\d|\$\d*\.?\d+e/);
		const lineTip = pricing?.querySelector(".tip-wrap");
		expect(lineTip?.getAttribute("tabindex")).toBe("0");
		expect(lineTip?.querySelector('[role="tooltip"]')?.textContent).toContain("cache_read_input_token_cost 5e-7");
		// Uniform source: exactly one provenance chip on the whole line.
		expect(pricing?.querySelectorAll(".chip-prov").length).toBe(1);
		expect(pricing?.querySelector(".chip-prov")?.textContent).toBe("server-reported");
		// The non-cost field keeps its own cell, friendly-labeled, with the
		// wire key on a focusable tip of its own.
		const context = cells.find((cell) => cell.textContent?.includes("Context length"));
		expect(context?.textContent).toContain("200000");
		const contextTip = context?.querySelector(".tip-wrap");
		expect(contextTip?.getAttribute("tabindex")).toBe("0");
		expect(contextTip?.querySelector('[role="tooltip"]')?.textContent).toBe("context_length 200000");
	});

	test("mixed-source cost cells badge only the parts that differ from the dominant source", () => {
		const { root } = mountDiagnostics({
			view: makeView({
				rows: [
					{
						serverLabel: "prod",
						rawId: "gpt-5.6",
						scopeKey: "s0",
						matchedKeys: [],
						parameters: [],
						capabilities: [
							{ name: "input_cost_per_token", valueText: "0.000005", level: "server" },
							{ name: "output_cost_per_token", valueText: "0.000025", level: "server" },
							{ name: "cache_creation_input_token_cost", valueText: "0.00000625", level: "entry", key: "gpt-5.6" },
						],
					},
				],
			}),
		});
		const pricing = Array.from(root.querySelectorAll("table.resolved-models .resolved-cell")).find((cell) =>
			cell.textContent?.includes("Pricing ($/M)")
		);
		const parts = Array.from(pricing?.querySelectorAll(".resolved-price-part") ?? []);
		expect(parts).toHaveLength(3);
		// The dominant source's chip LEADS the line ("default: X, except where
		// noted"); dominant parts carry no chip and only the outlier badges
		// itself.
		expect(parts[0]?.querySelector(".chip-prov")).toBeNull();
		expect(parts[1]?.querySelector(".chip-prov")).toBeNull();
		expect(parts[2]?.querySelector(".chip-prov")?.textContent).toBe("entry gpt-5.6");
		const chips = Array.from(pricing?.querySelectorAll(".chip-prov") ?? []).map((chip) => chip.textContent);
		expect(chips).toEqual(["server-reported", "entry gpt-5.6"]);
	});

	test("a uniform non-server pricing line keeps its source's key on the single chip", () => {
		const { root } = mountDiagnostics({
			view: makeView({
				rows: [
					{
						serverLabel: "prod",
						rawId: "gpt-5.6",
						scopeKey: "s0",
						matchedKeys: [],
						parameters: [],
						capabilities: [
							{ name: "input_cost_per_token", valueText: "0.000005", level: "entry", key: "gpt-5.6" },
							{ name: "output_cost_per_token", valueText: "0.000025", level: "entry", key: "gpt-5.6" },
						],
					},
				],
			}),
		});
		const pricing = Array.from(root.querySelectorAll("table.resolved-models .resolved-cell")).find((cell) =>
			cell.textContent?.includes("Pricing ($/M)")
		);
		const chips = Array.from(pricing?.querySelectorAll(".chip-prov") ?? []).map((chip) => chip.textContent);
		expect(chips).toEqual(["entry gpt-5.6"]);
	});

	test("the params list renders as its count with the full list on the focusable tip", () => {
		const list = ["temperature", "top_p", "tools", "tool_choice", "stream"];
		const { root } = mountDiagnostics({
			view: makeView({
				rows: [
					{
						serverLabel: "prod",
						rawId: "gpt-5.6",
						scopeKey: "s0",
						matchedKeys: [],
						parameters: [],
						capabilities: [{ name: "supported_openai_params", valueText: JSON.stringify(list), level: "server" }],
					},
				],
			}),
		});
		const cell = Array.from(root.querySelectorAll("table.resolved-models .resolved-cell")).find((candidate) =>
			candidate.textContent?.includes("Supported parameters")
		);
		expect(cell?.textContent).toContain("5 parameters");
		// The tip is focusable and carries the wire key plus the exact wire
		// value: element boundaries survive.
		const tip = cell?.querySelector(".tip-wrap");
		expect(tip?.getAttribute("tabindex")).toBe("0");
		expect(tip?.querySelector('[role="tooltip"]')?.textContent).toBe(`supported_openai_params ${JSON.stringify(list)}`);
		expect(cell?.querySelector(".chip-prov")?.textContent).toBe("server-reported");
		// The visible cell shows only the count; the array lives in the tip.
		expect(cell?.querySelector(".tip-wrap > span:not(.help-tip)")?.textContent).toBe("5 parameters");
	});

	test("a cost cell whose value is not a number keeps the generic rendering instead of joining the pricing line", () => {
		const { root } = mountDiagnostics({
			view: makeView({
				rows: [
					{
						serverLabel: "prod",
						rawId: "gpt-5.6",
						scopeKey: "s0",
						matchedKeys: [],
						parameters: [],
						capabilities: [{ name: "input_cost_per_token", valueText: '"cheap"', level: "server" }],
					},
				],
			}),
		});
		expect(root.textContent).not.toContain("Pricing ($/M)");
		const cell = Array.from(root.querySelectorAll("table.resolved-models .resolved-cell")).find((candidate) =>
			candidate.textContent?.includes('"cheap"')
		);
		expect(cell).not.toBeUndefined();
		expect(cell?.querySelector(".chip-prov")?.textContent).toBe("server-reported");
	});
});
