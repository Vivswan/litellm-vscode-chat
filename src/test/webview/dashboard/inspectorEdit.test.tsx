/**
 * The inspectors' configure-jump into the record editors: the Configure
 * button reuses the most specific matching global record or asks for a fresh
 * exact-ID draft, the per-row edit goes to the record that OWNS the value
 * (server entry included), and the editors' external-edit hook lands the
 * jump - focusing an existing record or creating the draft group.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { ScopedRecordSetting } from "../../../extension/dashboard/protocol";
import type { ModelParametersResponse } from "../../../webview/dashboard/paramsInspector";
import { ParamsInspector } from "../../../webview/dashboard/paramsInspector";
import type { ExternalRecordEdit } from "../../../webview/dashboard/recordEditors";
import { ModelParametersEditor } from "../../../webview/dashboard/recordEditors";
import { makeModel } from "../fixtures";
import { buttonByText, cleanup, mount, postedMessages, resetPosted } from "../harness";

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
				source: { layer: "entry", key: "*" },
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
	response: Omit<ModelParametersResponse, "type" | "requestId">,
	callbacks: {
		onEditRecord?: (key: string, create: boolean) => void;
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
	const root = mount(<ParamsInspector {...props} response={undefined} />);
	const read = postedMessages.find((message) => message.type === "readModelParameters") as
		| { requestId: string }
		| undefined;
	if (read === undefined) {
		throw new Error("the inspector posted no readModelParameters");
	}
	const answered = { type: "modelParameters", requestId: read.requestId, ...response } as ModelParametersResponse;
	void act(() => {
		render(<ParamsInspector {...props} response={answered} />, root);
	});
	return root;
}

describe("the params inspector's configure-jump", () => {
	test("with a matching global record the button focuses it; per-row edits go to the owning layer", () => {
		const recordJumps: [string, boolean][] = [];
		const entryJumps: string[] = [];
		const root = mountAnswered(
			{ projection: makeProjection(), entryLabel: "Prod", globalRecordKey: "gpt-5*" },
			{ onEditRecord: (key, create) => recordJumps.push([key, create]), onEditEntry: (label) => entryJumps.push(label) }
		);

		const configure = buttonByText(root, "Configure parameters for this model");
		expect(configure.disabled).toBe(false);
		configure.click();
		expect(recordJumps).toEqual([["gpt-5*", false]]);

		// The global-sourced row's edit goes to the record that owns the value;
		// the entry-sourced row's edit opens the server entry's form instead.
		const rowEdits = [...root.querySelectorAll<HTMLButtonElement>("button.row-edit")];
		expect(rowEdits.map((button) => button.getAttribute("aria-label"))).toEqual([
			'Edit record "gpt-5*" in settings',
			'Edit in server entry "Prod"',
		]);
		rowEdits[0]?.click();
		expect(recordJumps).toEqual([
			["gpt-5*", false],
			["gpt-5*", false],
		]);
		rowEdits[1]?.click();
		expect(entryJumps).toEqual(["Prod"]);
	});

	test("with no matching record the button asks for a fresh draft keyed by the exact model ID", () => {
		const recordJumps: [string, boolean][] = [];
		const root = mountAnswered(
			{ projection: makeProjection({ rows: [] }) },
			{ onEditRecord: (key, create) => recordJumps.push([key, create]) }
		);

		buttonByText(root, "Configure parameters for this model").click();
		expect(recordJumps).toEqual([["gpt-5.6", true]]);
	});

	test("without the callback no configure button and no row affordances render", () => {
		const root = mountAnswered({ projection: makeProjection(), entryLabel: "Prod" }, {});
		expect([...root.querySelectorAll("button")].some((b) => b.textContent?.includes("Configure parameters"))).toBe(
			false
		);
		expect(root.querySelector("button.row-edit")).toBeNull();
	});
});

describe("the editors' external-edit landing", () => {
	/** Flush the hook's focus timeout (setTimeout 0). */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

	function Harness({ external }: { external: ExternalRecordEdit | undefined }) {
		return (
			<ModelParametersEditor
				scoped={makeScopedRecord({ "gpt-5*": { temperature: 0.3 }, "*": { top_p: 0.9 } })}
				models={[]}
				failure={undefined}
				external={external}
			/>
		);
	}

	test("an existing key focuses that record's matcher input without minting a draft", async () => {
		const root = mount(<Harness external={undefined} />);
		void act(() => {
			render(<Harness external={{ seq: 1, key: "gpt-5*", create: false }} />, root);
		});
		await settle();

		const groups = [...root.querySelectorAll<HTMLElement>("div.group")];
		expect(groups).toHaveLength(2);
		const matcher = groups[0]?.querySelector<HTMLInputElement>("input.key");
		expect(document.activeElement).toBe(matcher ?? null);
		// Reused, not drafted: nothing changed, so Apply stays disabled.
		expect(buttonByText(root, "Apply").disabled).toBe(true);
	});

	test("create appends a draft group keyed by the exact ID and focuses its first field input", async () => {
		const root = mount(<Harness external={undefined} />);
		void act(() => {
			render(<Harness external={{ seq: 1, key: "claude-4", create: true }} />, root);
		});
		await settle();

		const groups = [...root.querySelectorAll<HTMLElement>("div.group")];
		expect(groups).toHaveLength(3);
		const created = groups[2];
		expect(created?.querySelector<HTMLInputElement>("input.key")?.value).toBe("claude-4");
		// Focus lands on the empty parameter-name input, ready to type; the
		// draft is not applied (drafts only land on Apply).
		expect(document.activeElement).toBe(created?.querySelector(".rows input.key") ?? null);
		expect(postedMessages.some((message) => message.type === "setModelParameters")).toBe(false);
	});

	test("a request for a key that vanished (create off) is a no-op", async () => {
		const root = mount(<Harness external={undefined} />);
		void act(() => {
			render(<Harness external={{ seq: 1, key: "gone*", create: false }} />, root);
		});
		await settle();
		expect([...root.querySelectorAll<HTMLElement>("div.group")]).toHaveLength(2);
	});
});
