/**
 * The inspector's configure-jump into the record editors: the Configure
 * button reuses the most specific matching global record or asks for a fresh
 * exact-ID draft, the per-row edit goes to the record that OWNS the value
 * (server entry included), and the editors' external-edit hook lands the
 * jump - focusing an existing record or creating the draft group.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { ScopedRecordSetting } from "../../../../dashboard/viewModels";
import type { ModelParametersResponse } from "../../../../webview/dashboard/modelInspector";
import { ModelInspector } from "../../../../webview/dashboard/modelInspector";
import type { ExternalRecordEdit } from "../../../../webview/dashboard/recordEditors";
import { ModelParametersEditor } from "../../../../webview/dashboard/recordEditors";
import { makeModel } from "../fixtures";
import { buttonByText, cleanup, lastRequest, mount, postedRequests, render, resetPosted, respondTo } from "../harness";

/** The response's projection payload, named through the message so no resolver module is imported here. */
type EffectiveParametersProjection = NonNullable<ModelParametersResponse["projection"]>;

function makeScopedRecord(
	value: Record<string, Record<string, unknown>>
): ScopedRecordSetting<Readonly<Record<string, unknown>>> {
	return { editScope: "global", value, otherScopes: [], effective: value };
}

beforeEach(resetPosted);
afterEach(cleanup);

function makeProjection(overrides: Partial<EffectiveParametersProjection> = {}): EffectiveParametersProjection {
	return {
		rows: [
			{
				name: "temperature",
				value: 0.3,
				sent: true,
				source: { layer: "global", key: "gpt-5*" },
				shadowed: [],
			},
			{
				name: "top_p",
				value: 0.9,
				sent: true,
				source: { layer: "entry", key: "*", entryLabel: "Prod" },
				shadowed: [],
			},
		],
		maxTokens: { source: "declared", value: 16384 },
		diagnostics: [],
		...overrides,
	};
}

/** Render the inspector, answer its readModelParameters post, and return the re-rendered root. */
function mountAnswered(
	response: ModelParametersResponse,
	callbacks: {
		onEditRecord?: (kind: "parameters" | "capabilities", key: string, create: boolean) => void;
		onEditEntry?: (label: string) => void;
	}
): HTMLElement {
	const model = makeModel({ rawId: "gpt-5.6", name: "GPT-5.6" });
	const props = {
		model,
		stateSeq: 0,
		onClose: () => {},
		onEditRecord: callbacks.onEditRecord,
		onEditEntry: callbacks.onEditEntry,
	};
	const root = mount(<ModelInspector {...props} />);
	respondTo(lastRequest("readModelParameters"), response);
	return root;
}

describe("the inspector's parameters configure-jump", () => {
	test("with a matching global record the button focuses it; per-row edits go to the owning layer", () => {
		const recordJumps: [string, string, boolean][] = [];
		const entryJumps: string[] = [];
		const root = mountAnswered(
			{ projection: makeProjection(), globalRecordKey: "gpt-5*" },
			{
				onEditRecord: (kind, key, create) => recordJumps.push([kind, key, create]),
				onEditEntry: (label) => entryJumps.push(label),
			}
		);

		const configure = buttonByText(root, "Configure parameters for this model");
		expect(configure.disabled).toBe(false);
		configure.click();
		expect(recordJumps).toEqual([["parameters", "gpt-5*", false]]);

		// The global-sourced row's edit goes to the record that owns the value;
		// the entry-sourced row's edit opens the server entry's form instead.
		const rowEdits = [...root.querySelectorAll<HTMLButtonElement>("button.row-edit")];
		expect(rowEdits.map((button) => button.getAttribute("aria-label"))).toEqual([
			'Edit record "gpt-5*" in settings',
			'Edit in server entry "Prod"',
		]);
		rowEdits[0]?.click();
		expect(recordJumps).toEqual([
			["parameters", "gpt-5*", false],
			["parameters", "gpt-5*", false],
		]);
		rowEdits[1]?.click();
		expect(entryJumps).toEqual(["Prod"]);
	});

	test("with no matching record the button asks for a fresh draft keyed by the exact model ID", () => {
		const recordJumps: [string, string, boolean][] = [];
		const root = mountAnswered(
			{ projection: makeProjection({ rows: [] }) },
			{ onEditRecord: (kind, key, create) => recordJumps.push([kind, key, create]) }
		);

		buttonByText(root, "Configure parameters for this model").click();
		expect(recordJumps).toEqual([["parameters", "gpt-5.6", true]]);
	});

	test("without the callback no configure buttons and no row affordances render", () => {
		const root = mountAnswered({ projection: makeProjection() }, {});
		expect([...root.querySelectorAll("button")].some((b) => b.textContent?.includes("Configure parameters"))).toBe(
			false
		);
		expect([...root.querySelectorAll("button")].some((b) => b.textContent?.includes("Configure capabilities"))).toBe(
			false
		);
		expect(root.querySelector("button.row-edit")).toBeNull();
	});
});

describe("the inspector's capabilities configure-jump", () => {
	/** Render the inspector, answer its readModelCapabilities post, and return the re-rendered root. */
	function mountCapsAnswered(
		response: Record<string, unknown>,
		callbacks: {
			onEditRecord?: (kind: "parameters" | "capabilities", key: string, create: boolean) => void;
			onEditEntry?: (label: string) => void;
		}
	): HTMLElement {
		const model = makeModel({ rawId: "gpt-5.6", name: "GPT-5.6", serverLabel: "Prod" });
		const props = {
			model,
			stateSeq: 0,
			onClose: () => {},
			onEditRecord: callbacks.onEditRecord,
			onEditEntry: callbacks.onEditEntry,
		};
		const root = mount(<ModelInspector {...props} />);
		respondTo(
			lastRequest("readModelCapabilities"),
			response as Parameters<typeof respondTo<"readModelCapabilities">>[1]
		);
		return root;
	}

	test("the Configure button and row edits route to the CAPABILITIES editor; entry rows to the entry form", () => {
		// The merged callback discriminates by kind: a wrong literal would open
		// the parameters editor for a capability row, so the caps half is
		// pinned separately from the params half above.
		const recordJumps: [string, string, boolean][] = [];
		const entryJumps: string[] = [];
		const root = mountCapsAnswered(
			{
				globalRecordKey: "gpt-5*",
				capabilities: {
					fields: {
						context_length: { value: 200000, level: "global", key: "gpt-5*", shadowed: [] },
						max_output_tokens: { value: 16384, level: "entry", key: "*", shadowed: [] },
					},
					outputLimitSource: "user",
					diagnostics: [],
				},
			},
			{
				onEditRecord: (kind, key, create) => recordJumps.push([kind, key, create]),
				onEditEntry: (label) => entryJumps.push(label),
			}
		);

		const configure = buttonByText(root, "Configure capabilities for this model");
		expect(configure.disabled).toBe(false);
		configure.click();
		expect(recordJumps).toEqual([["capabilities", "gpt-5*", false]]);

		// The global-sourced field's edit goes to the capabilities record that
		// owns the value; the entry-level field's edit opens the entry's form.
		// Each label names its LAYER: the redesign moved every visible layer word
		// into a badge, so for a screen reader this label is the only place the
		// layer is stated.
		const rowEdits = [...root.querySelectorAll<HTMLButtonElement>("button.row-edit")];
		expect(rowEdits.map((button) => button.getAttribute("aria-label"))).toEqual([
			'Edit record "gpt-5*" in settings',
			'Edit in server entry "Prod"',
		]);
		rowEdits[0]?.click();
		expect(recordJumps).toEqual([
			["capabilities", "gpt-5*", false],
			["capabilities", "gpt-5*", false],
		]);
		rowEdits[1]?.click();
		expect(entryJumps).toEqual(["Prod"]);
	});

	test("with no matching record the button asks for a fresh capabilities draft keyed by the exact model ID", () => {
		const recordJumps: [string, string, boolean][] = [];
		const root = mountCapsAnswered(
			{
				capabilities: { fields: {}, outputLimitSource: "defaults", diagnostics: [] },
			},
			{ onEditRecord: (kind, key, create) => recordJumps.push([kind, key, create]) }
		);
		buttonByText(root, "Configure capabilities for this model").click();
		expect(recordJumps).toEqual([["capabilities", "gpt-5.6", true]]);
	});
});

describe("the editors' external-edit landing", () => {
	/** Flush the slide-over's mount-focus effect. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

	function Harness({ external }: { external: ExternalRecordEdit | undefined }) {
		return (
			<ModelParametersEditor
				scoped={makeScopedRecord({ "gpt-5*": { temperature: 0.3 }, "*": { top_p: 0.9 } })}
				models={[]}
				external={external}
			/>
		);
	}

	/** The table rows' matcher keys in display order. */
	function matcherKeys(root: HTMLElement): string[] {
		return Array.from(root.querySelectorAll(".record-table .matcher-key")).map((cell) => cell.textContent ?? "");
	}

	test("an existing key opens that record's matcher editor overlay without minting a draft", async () => {
		const root = mount(<Harness external={undefined} />);
		void act(() => {
			render(<Harness external={{ seq: 1, key: "gpt-5*", create: false }} />, root);
		});
		await settle();

		// The overlay is open on the existing record; the slide-over's own
		// mount focus lands on its first input, the matcher key.
		const overlay = root.querySelector<HTMLElement>(".matcher-editor");
		if (overlay === null) {
			throw new Error("the jump did not open the matcher editor overlay");
		}
		const matcher = overlay.querySelector<HTMLInputElement>("input.key");
		expect(matcher?.value).toBe("gpt-5*");
		expect(document.activeElement).toBe(matcher ?? null);
		// Reused, not drafted: nothing changed, so Apply stays disabled.
		expect(buttonByText(root, "Apply").disabled).toBe(true);
	});

	test("create appends a draft group keyed by the exact ID and opens its overlay", async () => {
		const root = mount(<Harness external={undefined} />);
		void act(() => {
			render(<Harness external={{ seq: 1, key: "claude-4", create: true }} />, root);
		});
		await settle();

		const overlay = root.querySelector<HTMLElement>(".matcher-editor");
		if (overlay === null) {
			throw new Error("the jump did not open the matcher editor overlay");
		}
		expect(overlay.querySelector<HTMLInputElement>("input.key")?.value).toBe("claude-4");
		// The draft group joined the table (sorted view: the exact ID lands
		// after the glob) but is not applied - drafts only land on Apply.
		expect(matcherKeys(root)).toEqual(["*", "gpt-5*", "claude-4"]);
		expect(postedRequests("setModelParameters")).toHaveLength(0);
	});

	test("a request for a key that vanished (create off) is a no-op", async () => {
		const root = mount(<Harness external={undefined} />);
		void act(() => {
			render(<Harness external={{ seq: 1, key: "gone*", create: false }} />, root);
		});
		await settle();
		expect(root.querySelector(".matcher-editor")).toBeNull();
		expect(matcherKeys(root)).toEqual(["*", "gpt-5*"]);
	});
});
