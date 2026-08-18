/**
 * The Diagnostics destination's Configuration section (which diagnostics it
 * shows, how it ranks them, what it refuses to repeat) and the Resolution view
 * (tree, flat provenance table, filter, the per-row jump to the inspectors).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConfigDiagnosticView, ResolvedModelsView } from "../../../../dashboard/viewModels";
import { DiagnosticsSection, pageConfigDiagnostics } from "../../../../webview/dashboard/diagnostics";
import { makeDeclaredServer } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireClick,
	fireInput,
	lastRequest,
	mount,
	postedCalls,
	postedRequests,
	resetPosted,
	respondTo,
} from "../harness";

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
	};
	// Mounting posts the readResolvedModels request; answering it through the
	// window delivers the view exactly like the extension would.
	const root = mount(<DiagnosticsSection currencySymbol="$" {...props} />);
	respondTo(lastRequest("readResolvedModels"), { view: options.view ?? makeView() });
	return { root };
}

describe("Configuration diagnostics", () => {
	function mountConfig(diagnostics: readonly ConfigDiagnosticView[]) {
		return mount(
			<DiagnosticsSection
				currencySymbol="$"
				servers={[]}
				modelCount={0}
				legacyServerCount={0}
				diagnostics={diagnostics}
				active={false}
				stateSeq={0}
				onInspect={() => undefined}
			/>
		);
	}

	/** What a sighted reader sees: the node's text minus the screen-reader-only parts. */
	function sightedText(element: Element | null | undefined): string {
		if (element === null || element === undefined) {
			return "";
		}
		const clone = element.cloneNode(true) as Element;
		for (const hidden of Array.from(clone.querySelectorAll(".visually-hidden"))) {
			hidden.remove();
		}
		return clone.textContent ?? "";
	}

	test("clean settings keep the section and say so in one clause", () => {
		const root = mountConfig([]);
		expect(root.querySelector(".config-diagnostics")).toBeNull();
		// The section itself stays: the destination's shape must not change
		// under the reader between a clean install and a broken one.
		expect(root.querySelector("#config-diagnostics-section")).not.toBeNull();
		// Pinned exactly, not by substring: the healthy state is a place prose
		// regrows, and a `toContain` would pass against a paragraph again.
		expect(root.querySelector("#config-diagnostics-section p.hint")?.textContent).toBe("Your settings read cleanly.");
		// Nothing to act on means no count beside the title.
		expect(root.textContent).not.toContain("needs attention");
	});

	test("two records failing on the same field stay tellable apart", () => {
		// The record key left five of the seven sentences when they were cut to
		// one clause; without it as a location chip these rows are byte-identical
		// and neither names the record the reader has to go find.
		const root = mountConfig([
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: { kind: "invalid-value", recordKey: "gpt-5*", key: "temperature" },
				severity: "warning",
			},
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: { kind: "invalid-value", recordKey: "claude-*", key: "temperature" },
				severity: "warning",
			},
		]);
		const rows = Array.from(root.querySelectorAll(".config-diagnostics li"));
		expect(rows).toHaveLength(2);
		const chips = rows.map((row) =>
			Array.from(row.querySelectorAll(".row-diagnostic-where .chip-prov")).map((chip) => chip.textContent)
		);
		expect(chips).toEqual([
			["models.parameters", "gpt-5*"],
			["models.parameters", "claude-*"],
		]);
		expect(rows[0]?.textContent).not.toBe(rows[1]?.textContent);
	});

	test("a sentence that already names its record does not repeat it as a chip", () => {
		const root = mountConfig([
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: { kind: "invalid-matcher", recordKey: "gpt*5", key: "gpt*5" },
				severity: "warning",
			},
		]);
		const chips = Array.from(root.querySelectorAll(".row-diagnostic-where .chip-prov")).map((chip) => chip.textContent);
		expect(chips).toEqual(["models.parameters"]);
	});

	test("renders one block per diagnostic, worst first, with the offending key", () => {
		const diagnostics: ConfigDiagnosticView[] = [
			{
				kind: "record",
				setting: "models.capabilities",
				diagnostic: { kind: "unrecognized-key", recordKey: "gpt-4", key: "supports_web_search" },
				severity: "advisory",
			},
			{ kind: "thresholds", dropped: 2, severity: "warning" },
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: { kind: "invalid-matcher", recordKey: "gpt*5", key: "gpt*5" },
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
		];
		const root = mountConfig(diagnostics);
		const items = Array.from(root.querySelectorAll(".config-diagnostics li"));
		expect(items).toHaveLength(5);
		// Ranked by what it costs, not by the order the host emitted them: the
		// two wholly inert pieces of configuration first, then the partly
		// ignored ones, then the field that applies as written.
		expect(items.map((li) => li.className)).toEqual([
			"row-diagnostic tier-error",
			"row-diagnostic tier-error",
			"row-diagnostic tier-warn",
			"row-diagnostic tier-warn",
			"row-diagnostic tier-advisory",
		]);
		const text = items.map((li) => li.textContent ?? "");
		expect(text[0]).toContain('"gpt*5"');
		expect(text[1]).toContain("https://gw/gpt-4");
		// Within a tier the host's emission order survives (a stable sort), so
		// the thresholds drop stays ahead of the parked headers.
		expect(text[2]).toContain("2");
		expect(text[3]).toContain("x-env, x-trace");
		// The remedy ("adopt the external group") moved behind Learn more: one
		// consequence clause is the whole visible budget for a diagnostic.
		expect(text[3]).not.toContain("adopt");
		expect(text[3]).toContain("Learn more");
		expect(text[4]).toContain('"supports_web_search"');
		// The count beside the title excludes the advisory (the configuration
		// applies as written), but carries the total too, because the rail badge
		// counts the whole list and "4" beside a list of 5 is a question.
		expect(root.querySelector(".section-meta")?.textContent).toBe("4 of 5 need attention");
	});

	test("consequence-first copy leads with what is lost and keeps the cause", () => {
		const root = mountConfig([
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: { kind: "invalid-matcher", recordKey: "gpt*5", key: "gpt*5" },
				severity: "warning",
			},
		]);
		const headline = sightedText(root.querySelector(".config-diagnostics .row-diagnostic-headline"));
		// One clause: the consequence, then the cause, then stop. The matcher
		// grammar the sentence used to recite lives behind this row's Learn more.
		expect(headline).toBe('Nothing in record "gpt*5" is applied: that is not a valid matcher key.');
		expect(headline).not.toContain("trailing-*");
		expect(root.querySelector(".row-diagnostic-actions a")?.textContent).toBe("Learn more");
	});

	test("the location rides neutral badges rather than a trailing parenthetical", () => {
		const root = mountConfig([
			{
				kind: "record",
				setting: "models.parameters",
				entryLabel: "prod",
				diagnostic: { kind: "invalid-value", recordKey: "gpt-4", key: "context_length" },
				severity: "warning",
			},
		]);
		const badges = Array.from(root.querySelectorAll(".row-diagnostic-where .chip-prov")).map((el) => el.textContent);
		// Setting, then entry, then the record - a path to the exact object,
		// all machine text, none of it folded into the sentence.
		expect(badges).toEqual(["models.parameters", "entry prod", "gpt-4"]);
		expect(root.querySelector(".row-diagnostic-headline")?.textContent).not.toContain("(models.parameters)");
	});

	test("the action reveals the setting and never rewrites it", () => {
		const root = mountConfig([
			{
				kind: "record",
				setting: "models.capabilities",
				diagnostic: { kind: "invalid-value", recordKey: "gpt-4", key: "context_length" },
				severity: "warning",
			},
		]);
		resetPosted();
		fireClick(buttonByText(root, "Show in settings.json"));
		expect(postedCalls()).toEqual([{ method: "revealSetting", payload: { setting: "models.capabilities" } }]);
	});

	test("an entry-layer record reveals the servers setting, where that record lives", () => {
		const root = mountConfig([
			{
				kind: "record",
				setting: "models.parameters",
				entryLabel: "prod",
				diagnostic: { kind: "invalid-value", recordKey: "gpt-4", key: "temperature" },
				severity: "warning",
			},
		]);
		resetPosted();
		fireClick(buttonByText(root, "Show in settings.json"));
		expect(postedCalls()).toEqual([{ method: "revealSetting", payload: { setting: "servers" } }]);
	});

	test("a rejected entry the Servers page drew a row for is not repeated here", () => {
		const diagnostics: ConfigDiagnosticView[] = [
			{
				kind: "entry",
				label: "prod",
				position: 1,
				problems: ['has an unknown auth key "apikey"'],
				misconfigured: true,
				rowOwned: true,
				severity: "warning",
			},
			{ kind: "hidden-groups", labels: ["prod-hidden", "staging-hidden"], severity: "warning" },
		];
		// The filter is shared with the rail's badge, so the count above the
		// destination can never disagree with the list inside it.
		expect(pageConfigDiagnostics(diagnostics)).toEqual([]);
		const root = mountConfig(diagnostics);
		expect(root.querySelector(".config-diagnostics")).toBeNull();
		expect(root.textContent).not.toContain("prod-hidden");
		expect(root.textContent).not.toContain("apikey");
	});

	test("a rejected entry with NO row of its own still reports here: nothing else states it", () => {
		// The host refuses a row to rejects without a drawable identity and leaves
		// them to this list, so keying the filter on `misconfigured` alone would
		// erase the user's broken entry from both surfaces at once.
		const diagnostics: ConfigDiagnosticView[] = [
			{
				kind: "entry",
				position: 1,
				problems: ["no usable label"],
				misconfigured: true,
				rowOwned: false,
				severity: "warning",
			},
		];
		expect(pageConfigDiagnostics(diagnostics)).toHaveLength(1);
		const root = mountConfig(diagnostics);
		const item = root.querySelector(".config-diagnostics li");
		// Switched off entirely, so it ranks with the wholly inert configuration.
		expect(item?.className).toBe("row-diagnostic tier-error");
		expect(item?.querySelector(".row-diagnostic-headline")?.textContent).toContain(
			"Server entry #1 is switched off until it is fixed."
		);
		expect(item?.querySelector(".row-diagnostic-detail")?.textContent).toBe("no usable label");
	});

	test("an ACCEPTED entry's ignored pieces still report here: no row says it", () => {
		const diagnostics: ConfigDiagnosticView[] = [
			{
				kind: "entry",
				label: "prod",
				position: 1,
				problems: ["dropped an unknown discovery key"],
				misconfigured: false,
				rowOwned: false,
				severity: "warning",
			},
		];
		expect(pageConfigDiagnostics(diagnostics)).toHaveLength(1);
		const root = mountConfig(diagnostics);
		const item = root.querySelector(".config-diagnostics li");
		expect(item?.className).toBe("row-diagnostic tier-warn");
		expect(item?.querySelector(".row-diagnostic-headline")?.textContent).toContain(
			'Server entry "prod" runs without part of its configuration.'
		);
		// The parser's structural report stays English by policy and rides its
		// own line rather than being spliced into the sentence.
		expect(item?.querySelector(".row-diagnostic-detail")?.textContent).toBe("dropped an unknown discovery key");
	});

	test("every tier says its rank in words for assistive technology", () => {
		const root = mountConfig([
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: { kind: "invalid-matcher", recordKey: "gpt*5", key: "gpt*5" },
				severity: "warning",
			},
			{ kind: "thresholds", dropped: 1, severity: "warning" },
			{
				kind: "record",
				setting: "models.capabilities",
				diagnostic: { kind: "unrecognized-key", recordKey: "gpt-4", key: "supports_web_search" },
				severity: "advisory",
			},
		]);
		// Severity rides hue, a wash, and the rule's weight on screen - none of
		// which a screen reader can report. Without the hidden word the three
		// tiers announce identically and the sort is invisible.
		const spoken = Array.from(root.querySelectorAll(".row-diagnostic-headline .visually-hidden")).map(
			(el) => el.textContent
		);
		expect(spoken).toEqual(["Not applied at all: ", "Partly ignored: ", "Note: "]);
	});

	test("the host's advisory stamp caps every kind, not just record lints", () => {
		const root = mountConfig([{ kind: "thresholds", dropped: 1, severity: "advisory" }]);
		// A diagnostic the rail badge leaves untinted must not render as an
		// actionable row underneath it.
		expect(root.querySelector(".config-diagnostics li")?.className).toBe("row-diagnostic tier-advisory");
	});

	test("repeated reveal buttons get accessible names that tell them apart", () => {
		const root = mountConfig([
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: { kind: "invalid-value", recordKey: "gpt-4", key: "temperature" },
				severity: "warning",
			},
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: { kind: "invalid-value", recordKey: "claude-*", key: "top_p" },
				severity: "warning",
			},
			// Two lints inside ONE record: the record key alone would name both
			// buttons identically, so the offending field has to ride along.
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: { kind: "invalid-value", recordKey: "gpt-4", key: "top_k" },
				severity: "warning",
			},
		]);
		const buttons = Array.from(root.querySelectorAll(".row-diagnostic-actions button"));
		const names = buttons.map((button) => button.getAttribute("aria-label"));
		expect(names).toHaveLength(3);
		expect(new Set(names).size).toBe(3);
		// The visible label stays inside the accessible name (Label in Name).
		for (const name of names) {
			expect(name).toContain("Show in settings.json");
		}
	});

	test("an accepted and a rejected entry sharing a label keep separate keys and button names", () => {
		// A reject can reuse a label an accepted entry already owns, and the two
		// diagnostics must not collapse onto one React key - that would drop a
		// problem from the page and move focus to the wrong block on a push.
		const root = mountConfig([
			{
				kind: "entry",
				label: "prod",
				position: 1,
				problems: ["dropped an unknown discovery key"],
				misconfigured: false,
				rowOwned: false,
				severity: "warning",
			},
			{
				kind: "entry",
				label: "prod",
				position: 2,
				problems: ["duplicate label"],
				misconfigured: true,
				rowOwned: false,
				severity: "warning",
			},
		]);
		const details = Array.from(root.querySelectorAll(".config-diagnostics .row-diagnostic-detail")).map(
			(el) => el.textContent
		);
		expect(details).toEqual(["duplicate label", "dropped an unknown discovery key"]);
		const names = Array.from(root.querySelectorAll(".row-diagnostic-actions button")).map((button) =>
			button.getAttribute("aria-label")
		);
		expect(new Set(names).size).toBe(2);
	});

	test("one leftover key in both record settings renders as two blocks, not one", () => {
		// collectLegacyHints emits an inert-url-scoped-key hint per setting with
		// the same oldKey, differing only in `detail`; a key without it collides
		// and React drops a block.
		const root = mountConfig([
			{
				kind: "legacy",
				hint: "inert-url-scoped-key",
				oldKey: "https://gw/gpt-4",
				detail: "models.parameters",
				severity: "warning",
			},
			{
				kind: "legacy",
				hint: "inert-url-scoped-key",
				oldKey: "https://gw/gpt-4",
				detail: "models.capabilities",
				severity: "warning",
			},
		]);
		expect(Array.from(root.querySelectorAll(".config-diagnostics li"))).toHaveLength(2);
		const badges = Array.from(root.querySelectorAll(".row-diagnostic-where .chip-prov")).map((el) => el.textContent);
		expect(badges).toEqual(["models.parameters", "models.capabilities"]);
	});

	test("an advisory keeps the applied-as-is wording and the quiet tier", () => {
		const root = mountConfig([
			{
				kind: "record",
				setting: "models.capabilities",
				diagnostic: { kind: "unrecognized-key", recordKey: "gpt-4", key: "supports_web_search" },
				severity: "advisory",
			},
		]);
		const item = root.querySelector(".config-diagnostics li");
		expect(item?.className).toBe("row-diagnostic tier-advisory");
		expect(item?.textContent).toContain('"supports_web_search"');
		expect(item?.textContent).toContain("applies as written");
	});
});

describe("Resolved models", () => {
	test("the resolution view carries no standing paragraph around the tree", () => {
		// The tree and the table ARE the explanation; a paragraph above them was
		// read once and scrolled past forever. Pinned so it cannot regrow.
		const { root } = mountDiagnostics({});
		const section = root.querySelector("#resolution-section") as HTMLElement;
		expect(section.textContent).not.toContain("precomputed resolution");
		expect(section.textContent).not.toContain("never part of issue reports");
		// The concept still has a home: the header's help affordance.
		expect(section.querySelector(".section-head .tip-bubble")?.textContent).toContain("Which record set each value");
	});

	test("requests only while the tab is active", () => {
		mount(
			<DiagnosticsSection
				currencySymbol="$"
				servers={[]}
				modelCount={0}
				legacyServerCount={0}
				diagnostics={[]}
				active={false}
				stateSeq={0}
				onInspect={() => undefined}
			/>
		);
		expect(postedRequests("readResolvedModels")).toHaveLength(0);
	});

	test("draws the tree with fields, marks, barriers, leaves, and invalid keys", () => {
		const { root } = mountDiagnostics({});
		const tree = root.querySelector(".record-tree");
		expect(tree?.textContent).toContain("*");
		expect(tree?.textContent).toContain("temperature 0.7 (inheritable)");
		expect(tree?.textContent).toContain("inheritance stops here");
		expect(tree?.textContent).toContain("gpt-5.6");
		expect(tree?.textContent).toContain("1 model matches no record here");
		expect(tree?.textContent).toContain('"gpt*5" is listed under Configuration above.');
	});

	test("an invalid matcher key is told once: Configuration owns the verdict, the tree points", () => {
		// The tree names the key (a record the reader wrote must not silently
		// vanish from the figure) but defers the verdict to the ranked row above,
		// so the outcome is told exactly once.
		const { root } = mountDiagnostics({
			diagnostics: [
				{
					kind: "record",
					setting: "models.parameters",
					diagnostic: { kind: "invalid-matcher", recordKey: "gpt*5", key: "gpt*5" },
					severity: "warning",
				},
			],
		});
		expect((root.textContent ?? "").match(/is not a valid matcher key/g) ?? []).toHaveLength(1);
		expect(root.querySelector(".config-diagnostics")?.textContent).toContain("not a valid matcher key");
		const tree = root.querySelector(".record-tree");
		expect(tree?.textContent).not.toContain("not a valid matcher key");
		expect(tree?.textContent).toContain('"gpt*5" is listed under Configuration above.');
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

	test("an empty Parameters cell is the Absent idiom: a hidden dash with the reason for screen readers", () => {
		// The claude-4 row resolves no parameters. A bare "-" reads as nothing to
		// a screen reader, so the dash is decoration and the words carry the fact.
		const { root } = mountDiagnostics({});
		const rows = Array.from(root.querySelectorAll("table.resolved-models tbody tr"));
		const cell = rows.find((row) => row.textContent?.includes("claude-4"))?.querySelector(".resolved-cells");
		const absent = cell?.querySelector("span.hint");
		expect(absent?.querySelector('[aria-hidden="true"]')?.textContent).toBe("-");
		expect(absent?.querySelector(".sr-only")?.textContent).toBe("no parameters resolved");
	});

	test("an empty Capabilities cell says so the same way instead of rendering a silent gap", () => {
		const { root } = mountDiagnostics({
			view: makeView({
				rows: [
					{
						serverLabel: "prod",
						rawId: "bare-model",
						scopeKey: "s0",
						matchedKeys: [],
						parameters: [],
						capabilities: [],
					},
				],
			}),
		});
		const row = Array.from(root.querySelectorAll("table.resolved-models tbody tr")).find((candidate) =>
			candidate.textContent?.includes("bare-model")
		);
		const cells = Array.from(row?.querySelectorAll(".resolved-cells") ?? []);
		// Both the Parameters and the Capabilities cell speak their absence.
		expect(cells).toHaveLength(2);
		for (const cell of cells) {
			expect(cell.querySelector('span.hint [aria-hidden="true"]')?.textContent).toBe("-");
		}
		expect(cells[1]?.querySelector(".sr-only")?.textContent).toBe("no capabilities resolved");
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
		// The tip is focusable and carries the wire key plus the exact wire
		// value: element boundaries survive.
		const tip = cell?.querySelector(".tip-wrap");
		expect(tip?.getAttribute("tabindex")).toBe("0");
		expect(tip?.querySelector('[role="tooltip"]')?.textContent).toBe(`supported_openai_params ${JSON.stringify(list)}`);
		expect(cell?.querySelector(".chip-prov")?.textContent).toBe("server-reported");
		// The visible cell shows only the bare count - the label beside it
		// already says "parameters" - and the array lives in the tip.
		expect(cell?.querySelector(".tip-wrap > span:not(.tip-bubble)")?.textContent).toBe("5");
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
