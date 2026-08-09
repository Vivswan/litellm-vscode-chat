/**
 * The inspectors' inheritance chain figure (RecordChainFigure): the response's
 * per-map chains render as one compact record path each - broadest to winner,
 * keys clickable through the existing edit-jump wiring, barrier and
 * exclusive-list markers worded like the Diagnostics tree - and a single
 * match renders no figure at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { RecordChainView } from "../../../extension/dashboard/protocol";
import type { ModelCapabilitiesResponse } from "../../../webview/dashboard/capsInspector";
import { CapsInspector } from "../../../webview/dashboard/capsInspector";
import type { ModelParametersResponse } from "../../../webview/dashboard/paramsInspector";
import { ParamsInspector } from "../../../webview/dashboard/paramsInspector";
import { makeModel } from "../fixtures";
import { cleanup, fireClick, mount, postedMessages, resetPosted } from "../harness";

beforeEach(resetPosted);
afterEach(cleanup);

type Projection = NonNullable<ModelParametersResponse["projection"]>;

const EMPTY_PROJECTION: Projection = {
	rows: [],
	maxTokens: { source: "declared", value: 16384 },
	diagnostics: [],
};

/** Render the params inspector, answer its read with the given chains, and return the root. */
function mountParamsWithChains(
	chains: readonly RecordChainView[] | undefined,
	callbacks: {
		onEditRecord?: (key: string, create: boolean) => void;
		onEditEntry?: (label: string) => void;
	} = {}
): HTMLElement {
	const model = makeModel({ rawId: "gpt-5.6", name: "GPT-5.6" });
	const props = {
		model,
		stateSeq: 0,
		onClose: () => {},
		onEditRecord: callbacks.onEditRecord,
		onEditEntry: callbacks.onEditEntry,
	};
	const root = mount(<ParamsInspector {...props} response={undefined} />);
	const read = postedMessages.find((message) => message.type === "readModelParameters") as { requestId: string };
	const answered = {
		type: "modelParameters",
		requestId: read.requestId,
		projection: EMPTY_PROJECTION,
		entryLabel: "Prod",
		...(chains !== undefined ? { chains } : {}),
	} as ModelParametersResponse;
	void act(() => {
		render(<ParamsInspector {...props} response={answered} />, root);
	});
	return root;
}

describe("the params inspector's record path", () => {
	test("a two-plus-record chain renders broadest to winner with barrier and exclusive-list markers", () => {
		const root = mountParamsWithChains([
			{
				layer: "global",
				links: [
					{ key: "*", barrier: false },
					{ key: "gpt-5*", barrier: true, inheritFrom: "false" },
					{ key: "gpt-5.6", barrier: false, inheritFrom: "*, gpt-5*" },
				],
			},
		]);
		const chain = root.querySelector(".record-chain") as HTMLElement;
		expect(chain).not.toBeNull();
		const text = (chain.textContent ?? "").replace(/\s+/g, " ").trim();
		expect(text).toBe(
			"Record path (settings): * -> gpt-5* [inheritance stops here] -> gpt-5.6 [inherits from: *, gpt-5*]"
		);
		// The barrier marker wears the Diagnostics tree's warning tone.
		expect(chain.querySelector(".tree-barrier")?.textContent).toContain("inheritance stops here");
	});

	test("keys jump through the existing wiring: global keys to their record, entry keys to the entry form", () => {
		const recordJumps: [string, boolean][] = [];
		const entryJumps: string[] = [];
		const root = mountParamsWithChains(
			[
				{
					layer: "global",
					links: [
						{ key: "*", barrier: false },
						{ key: "gpt-5.6", barrier: false },
					],
				},
				{
					layer: "entry",
					links: [
						{ key: "*", barrier: false },
						{ key: "gpt-5*", barrier: false },
					],
				},
			],
			{ onEditRecord: (key, create) => recordJumps.push([key, create]), onEditEntry: (label) => entryJumps.push(label) }
		);
		const chains = Array.from(root.querySelectorAll(".record-chain"));
		expect(chains).toHaveLength(2);
		expect(chains[0]?.textContent).toContain("Record path (settings):");
		expect(chains[1]?.textContent).toContain('Record path (server entry "Prod"):');

		// An entry-layer key opens the entry's form (entry records live there).
		const entryKey = chains[1]?.querySelector("button.chain-key") as HTMLButtonElement;
		expect(entryKey.getAttribute("aria-label")).toBe('Edit in server entry "Prod"');
		fireClick(entryKey);
		expect(entryJumps).toEqual(["Prod"]);

		// A global key focuses its settings record, never minting a draft.
		const globalKeys = Array.from(chains[0]?.querySelectorAll("button.chain-key") ?? []);
		expect(globalKeys.map((b) => b.getAttribute("aria-label"))).toEqual([
			'Edit record "*" in settings',
			'Edit record "gpt-5.6" in settings',
		]);
		fireClick(globalKeys[1] as HTMLButtonElement);
		expect(recordJumps).toEqual([["gpt-5.6", false]]);
	});

	test("an entry chain without the entry-form jump renders plain keys, never the global fallback", () => {
		// The jump gates on the LAYER: with only onEditRecord wired, an entry
		// key must not route to the global editor its aria-label contradicts.
		const recordJumps: [string, boolean][] = [];
		const root = mountParamsWithChains(
			[
				{
					layer: "entry",
					links: [
						{ key: "*", barrier: false },
						{ key: "gpt-5*", barrier: false },
					],
				},
			],
			{ onEditRecord: (key, create) => recordJumps.push([key, create]) }
		);
		const chain = root.querySelector(".record-chain") as HTMLElement;
		expect(chain.querySelector("button.chain-key")).toBeNull();
		expect(Array.from(chain.querySelectorAll("code")).map((c) => c.textContent)).toEqual(["*", "gpt-5*"]);
		expect(recordJumps).toEqual([]);
	});

	test("a single-record chain and an absent chains field render no figure", () => {
		const single = mountParamsWithChains([{ layer: "global", links: [{ key: "gpt-5.6", barrier: false }] }]);
		expect(single.querySelector(".record-chain")).toBeNull();

		cleanup();
		resetPosted();
		const absent = mountParamsWithChains(undefined);
		expect(absent.querySelector(".record-chain")).toBeNull();
	});
});

test("the caps inspector renders the same figure from its own response", () => {
	const model = makeModel({ rawId: "gpt-5.6", name: "GPT-5.6" });
	const props = { model, stateSeq: 0, onClose: () => {} };
	const root = mount(<CapsInspector {...props} response={undefined} />);
	const read = postedMessages.find((message) => message.type === "readModelCapabilities") as { requestId: string };
	const answered = {
		type: "modelCapabilities",
		requestId: read.requestId,
		chains: [
			{
				layer: "global",
				links: [
					{ key: "*", barrier: false, inheritFrom: "true" },
					{ key: "gpt-5*", barrier: true, inheritFrom: "[]" },
				],
			},
		] satisfies RecordChainView[],
	} as ModelCapabilitiesResponse;
	void act(() => {
		render(<CapsInspector {...props} response={answered} />, root);
	});
	const chain = root.querySelector(".record-chain") as HTMLElement;
	const text = (chain.textContent ?? "").replace(/\s+/g, " ").trim();
	expect(text).toBe("Record path (settings): * [inherits from: true] -> gpt-5* [inheritance stops here]");
});
