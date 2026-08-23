import { describe, expect, test } from "bun:test";
import {
	modelsMarkdown,
	type ProviderSnapshot,
	type SnapshotModel,
} from "../../../../../extension/features/participant/modelsMarkdown";

const BETA_MODELS: SnapshotModel[] = [
	{ id: "zephyr-large", capabilities: "tools, vision" },
	{ id: "alpaca-mini", capabilities: "tools" },
];

const SNAPSHOTS: ProviderSnapshot[] = [
	{ label: "beta", models: BETA_MODELS },
	{ label: "alpha", models: [{ id: "gpt-test", capabilities: "128k context" }] },
];

describe("extension/features/participant modelsMarkdown", () => {
	test("renders one section per server with one row per model", () => {
		const markdown = modelsMarkdown(SNAPSHOTS);
		expect(markdown).toContain("### alpha");
		expect(markdown).toContain("### beta");
		expect(markdown).toContain("| Model | Capabilities |");
		expect(markdown).toContain("| `gpt-test` | 128k context |");
		expect(markdown).toContain("| `zephyr-large` | tools, vision |");
	});

	test("output is deterministic: server and model order in the input never changes the document", () => {
		const shuffled: ProviderSnapshot[] = [
			{ label: "alpha", models: [{ id: "gpt-test", capabilities: "128k context" }] },
			{
				label: "beta",
				models: [
					{ id: "alpaca-mini", capabilities: "tools" },
					{ id: "zephyr-large", capabilities: "tools, vision" },
				],
			},
		];
		expect(modelsMarkdown(shuffled)).toBe(modelsMarkdown(SNAPSHOTS));
	});

	test("servers sort before their models render, so sections come out label-ordered", () => {
		const markdown = modelsMarkdown(SNAPSHOTS);
		expect(markdown.indexOf("### alpha")).toBeLessThan(markdown.indexOf("### beta"));
		expect(markdown.indexOf("alpaca-mini")).toBeLessThan(markdown.indexOf("zephyr-large"));
	});

	test("no servers is a plain sentence, not an empty grid", () => {
		const markdown = modelsMarkdown([]);
		expect(markdown).toContain("No LiteLLM servers are connected");
		expect(markdown).not.toContain("|");
	});

	test("a server with no models keeps its heading and says so", () => {
		const markdown = modelsMarkdown([{ label: "empty-server", models: [] }]);
		expect(markdown).toContain("### empty-server");
		expect(markdown).toContain("No models discovered.");
		expect(markdown).not.toContain("| Model |");
	});

	test("pipes, backslashes, and line breaks in labels, IDs, and summaries cannot break the row grid", () => {
		const markdown = modelsMarkdown([
			{
				label: "with|pipe",
				models: [{ id: "id|with|pipes", capabilities: "line one\nline two" }],
			},
		]);
		expect(markdown).toContain("### with\\|pipe");
		expect(markdown).toContain("| `id\\|with\\|pipes` | line one line two |");

		const armed = modelsMarkdown([{ label: "srv", models: [{ id: "a\\|b", capabilities: "one\rtwo" }] }]);
		// A backslash next to a pipe cannot live in a code span (the cell scanner
		// would pair them and split the row), so the ID falls back to plain text
		// with full escaping: renders as a\|b, row intact.
		expect(armed).toContain("| a\\\\\\|b | one two |");
		expect(armed).not.toContain("\r");
		expect(armed).not.toContain("`a");
	});

	test("an ID carrying backticks still renders as one balanced code span", () => {
		const markdown = modelsMarkdown([
			{
				label: "srv",
				models: [
					{ id: "odd`id", capabilities: "" },
					{ id: "`edges`", capabilities: "" },
				],
			},
		]);
		// The fence outruns the longest interior run, and edge backticks get padding.
		expect(markdown).toContain("| ``odd`id`` |  |");
		expect(markdown).toContain("| `` `edges` `` |  |");
	});

	test("blank and space-edged IDs stay total: no empty code span, no CommonMark-stripped space", () => {
		const markdown = modelsMarkdown([
			{
				label: "srv",
				models: [
					{ id: "", capabilities: "blank id" },
					{ id: " padded ", capabilities: "space edges" },
				],
			},
		]);
		expect(markdown).toContain("|  | blank id |");
		expect(markdown).not.toContain("``` |");
		// Space padding keeps CommonMark from eating the ID's own edge spaces.
		expect(markdown).toContain("| `  padded  ` | space edges |");
	});

	test("tied labels and tied model IDs still render one deterministic document", () => {
		const twin = (capabilities: string): ProviderSnapshot => ({
			label: "same-label",
			models: [
				{ id: "same-id", capabilities },
				{ id: "same-id", capabilities: "zz" },
			],
		});
		const forward = modelsMarkdown([twin("aa"), twin("bb")]);
		const backward = modelsMarkdown([twin("bb"), twin("aa")]);
		expect(forward).toBe(backward);
		expect(forward.indexOf("| `same-id` | aa |")).toBeLessThan(forward.indexOf("| `same-id` | bb |"));
	});
});
