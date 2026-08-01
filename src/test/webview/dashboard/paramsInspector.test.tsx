/**
 * The effective-parameters inspector's rendering pins. The resolution itself
 * is owned by the shared module (unit + equivalence property suites in the
 * extension host); these tests only pin what the webview shows: the row
 * action that opens it, the identity header, source naming, shadowed and
 * replaced-record rendering, the not-sent reasons, the max_tokens derivation
 * wording per branch, the honest caveats, and the empty state.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { RequestScope } from "../../../extension/dashboard/protocol";
import { App } from "../../../webview/dashboard/app";
import { ModelsSection } from "../../../webview/dashboard/models";
import { ParamsInspector } from "../../../webview/dashboard/paramsInspector";
import { makeDeclaredServer, makeModel, makeSettings, makeState, statePush } from "../fixtures";
import { cleanup, fireClick, mount, pushToWebview, resetPosted, textOf } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

const model = makeModel({ id: "gpt-4o", rawId: "gpt-4o", name: "Omni", serverLabel: "Prod", scopeKey: "s0" });
const bareScope: RequestScope = { baseUrlScope: "http://prod.test" };

function mountInspector(options: {
	scope?: RequestScope | undefined;
	globalParameters?: Record<string, Record<string, unknown>>;
	modelOverrides?: Parameters<typeof makeModel>[0];
	onClose?: () => void;
}) {
	return mount(
		<ParamsInspector
			model={makeModel({ ...model, ...options.modelOverrides })}
			scope={options.scope ?? bareScope}
			globalParameters={options.globalParameters ?? {}}
			onClose={options.onClose ?? (() => {})}
		/>
	);
}

test("the models table row carries a quiet Params action that opens the inspector dialog", () => {
	const root = mount(
		<ModelsSection
			models={[model]}
			serverCount={1}
			requestScopes={{ s0: bareScope }}
			modelParameters={{ "gpt-4": { temperature: 0.2 } }}
		/>
	);
	const action = root.querySelector("button[aria-label='Show effective parameters for Omni on Prod']");
	expect(action).not.toBeNull();
	expect((action?.textContent ?? "").trim()).toBe("Params");
	expect(document.querySelector("[role='dialog']")).toBeNull();

	fireClick(action as HTMLButtonElement);
	const dialog = document.querySelector("[role='dialog']") as HTMLElement;
	expect(dialog).not.toBeNull();
	expect(textOf(dialog, "#params-inspector-title")).toContain("Omni");

	// The X closes it again (SlideOver's close request maps straight to close;
	// a read-only view has nothing to confirm).
	fireClick(dialog.querySelector("button[aria-label='Close']") as HTMLButtonElement);
	expect(document.querySelector("[role='dialog']")).toBeNull();
});

test("the header states the raw ID, the server label, and the base URL scope", () => {
	const root = mountInspector({});
	expect(textOf(root, ".params-identity")).toBe("gpt-4o on Prod (http://prod.test)");
	expect(root.textContent).toContain("Always sent");
});

test("a global match renders as a sent row sourced to the settings layer and its winning key", () => {
	const root = mountInspector({ globalParameters: { "gpt-4": { temperature: 0.2 } } });
	const row = root.querySelector("table.params tbody tr") as HTMLElement;
	const cells = Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").trim());
	expect(cells).toEqual(["temperature", "0.2", "Settings - gpt-4"]);
	expect(row.classList.contains("param-not-sent")).toBe(false);
});

test("an entry override names the entry layer and shows the shadowed global value struck through", () => {
	const root = mountInspector({
		scope: {
			baseUrlScope: "http://prod.test",
			entryLabel: "Team A",
			entryParameters: { "gpt-4": { temperature: 0.1 } },
		},
		globalParameters: { "gpt-4": { temperature: 0.8, top_p: 0.9 } },
	});
	const rows = Array.from(root.querySelectorAll("table.params tbody tr"));
	const texts = rows.map((row) =>
		Array.from(row.querySelectorAll("td"))
			.map((cell) => (cell.textContent ?? "").trim())
			.join(" | ")
	);
	expect(texts).toEqual([
		'temperature | 0.1 | Server entry "Team A" - gpt-4',
		" | 0.8 | overridden: Settings - gpt-4",
		"top_p | 0.9 | Settings - gpt-4",
	]);
	const shadowed = root.querySelector("tr.param-shadowed") as HTMLElement;
	expect(shadowed.querySelector(".param-value")).not.toBeNull();
});

test("a scoped win renders the WHOLE replaced unscoped record as not applied, non-colliding keys included", () => {
	const root = mountInspector({
		globalParameters: {
			"gpt-4": { temperature: 0.8, seed: 7 },
			"http://prod.test/gpt-4": { temperature: 0.2 },
		},
	});
	// The scoped value is the one sent row.
	const sentTexts = Array.from(root.querySelectorAll("table.params tbody tr td")).map((cell) =>
		(cell.textContent ?? "").trim()
	);
	expect(sentTexts).toEqual(["temperature", "0.2", "Settings - http://prod.test/gpt-4"]);
	// The whole unscoped record shows as replaced - including seed, which the
	// winner never set: replacement is record-level, not a key merge.
	const replaced = root.querySelector(".params-replaced") as HTMLElement;
	expect(replaced.textContent).toContain("Not applied - Settings gpt-4");
	const items = Array.from(replaced.querySelectorAll("li")).map((item) => (item.textContent ?? "").trim());
	expect(items).toEqual(["temperature: 0.8", "seed: 7"]);
});

test("underscore and provider-owned keys render muted with their not-sent reasons", () => {
	const root = mountInspector({ globalParameters: { "gpt-4": { _internal: true, stream: false } } });
	const rows = Array.from(root.querySelectorAll("table.params tbody tr")) as HTMLElement[];
	expect(rows.every((row) => row.classList.contains("param-not-sent"))).toBe(true);
	expect(root.textContent).toContain("not sent: keys starting with _ are reserved");
	expect(root.textContent).toContain("not sent: a provider-owned request field");
});

test("the max_tokens derivation states the configured branch with its attribution", () => {
	const root = mountInspector({ globalParameters: { "gpt-4": { max_tokens: 2222 } } });
	expect(textOf(root, ".params-max-tokens")).toBe("max_tokens 2222 set by Settings - gpt-4");
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

test("the runtime caveat always renders; the picker caveat only on reasoning models", () => {
	const plain = mountInspector({});
	expect(plain.textContent).toContain("Runtime options");
	expect(plain.textContent).not.toContain("reasoning effort");

	cleanup();
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

test("two rows sharing an ID and display label still open their own snapshot's scope", () => {
	// The inspected-row identity includes scopeKey: two snapshots can render
	// the same raw ID under the same display label, and each Params action
	// must open the scope of exactly the row it sits on.
	const rows = [makeModel({ ...model, scopeKey: "s0" }), makeModel({ ...model, scopeKey: "s1" })];
	const root = mount(
		<ModelsSection
			models={rows}
			serverCount={2}
			requestScopes={{ s0: { baseUrlScope: "http://first.test" }, s1: { baseUrlScope: "http://second.test" } }}
			modelParameters={{}}
		/>
	);
	const actions = root.querySelectorAll("button[aria-label='Show effective parameters for Omni on Prod']");
	expect(actions.length).toBe(2);
	fireClick(actions[1] as HTMLButtonElement);
	const dialog = document.querySelector("[role='dialog']") as HTMLElement;
	expect(textOf(dialog, ".params-identity")).toBe("gpt-4o on Prod (http://second.test)");
});
