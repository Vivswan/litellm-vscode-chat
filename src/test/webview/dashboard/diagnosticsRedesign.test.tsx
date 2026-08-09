/**
 * The Diagnostics tab's redesign surfaces: Configuration diagnostics rows and
 * the Resolved-models view (tree + flat provenance table + filter + the
 * per-row jump to the inspectors).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import type {
	ConfigDiagnosticView,
	ExtensionToWebviewMessage,
	ResolvedModelsView,
} from "../../../extension/dashboard/protocol";
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
			},
			{
				kind: "entry",
				label: "prod",
				position: 1,
				problems: ['has an unknown auth key "apikey"'],
				misconfigured: true,
			},
			{ kind: "legacy", hint: "inert-url-scoped-key", oldKey: "https://gw/gpt-4", detail: "models.parameters" },
			{ kind: "legacy", hint: "parked-global-headers", oldKey: "headers", detail: "x-env, x-trace" },
			{ kind: "thresholds", dropped: 2 },
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
		expect(items).toHaveLength(5);
		expect(items[0]).toContain('"gpt*5"');
		expect(items[1]).toContain('"prod"');
		expect(items[1]).toContain("misconfigured");
		expect(items[2]).toContain("https://gw/gpt-4");
		expect(items[3]).toContain("x-env, x-trace");
		expect(items[3]).toContain("adopt");
		expect(items[4]).toContain("2");
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
		fireClick(buttonByText(rows[0] as HTMLElement, "Capabilities"));
		expect(jumps).toEqual([["s0", "gpt-5.6", "prod", "caps"]]);
	});

	test("the zero-record empty state still lists every model", () => {
		const { root } = mountDiagnostics({
			view: makeView({ trees: [], recordCount: 0 }),
		});
		expect(root.textContent).toContain("No matcher records configured");
		expect(Array.from(root.querySelectorAll("table.resolved-models tbody tr"))).toHaveLength(2);
	});
});
