/**
 * ServersSection behavior: toolbar command wiring, the two-step remove, the
 * add-form save round trip with requestId correlation, and the adopt intent's
 * exact payload (exhaustive key inspection: a credential-shaped field smuggled
 * into adoptServer must fail here).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { WebviewToExtensionMessage } from "../../../extension/dashboard/protocol";
import { App } from "../../../webview/dashboard/app";
import { HELP_ENTRY_MODEL_PARAMETER_PREFIX } from "../../../webview/dashboard/helpText";
import { ServersSection } from "../../../webview/dashboard/servers";
import { makeDeclaredServer, makeExternalServer, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireClick,
	fireInput,
	inputByLabel,
	mount,
	postedMessages,
	pushToWebview,
	resetPosted,
} from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

const noop = () => {};

function mountSection(servers: readonly ReturnType<typeof makeDeclaredServer>[]) {
	return mount(
		<ServersSection
			servers={servers}
			ack={undefined}
			failures={{}}
			inlineSecrets={undefined}
			onDismissFailure={noop}
			onClearInlineSecrets={noop}
		/>
	);
}

test("Test connection and Show diagnostics disable with zero servers and post their executeCommand ids", () => {
	const empty = mountSection([]);
	expect(buttonByText(empty, "Test connection").disabled).toBe(true);
	expect(buttonByText(empty, "Show diagnostics").disabled).toBe(true);

	const populated = mountSection([makeDeclaredServer()]);
	fireClick(buttonByText(populated, "Test connection"));
	fireClick(buttonByText(populated, "Show diagnostics"));
	fireClick(buttonByText(populated, "Open native editor"));
	expect(postedMessages).toEqual([
		{ type: "executeCommand", command: "testConnection" },
		{ type: "executeCommand", command: "showDiagnostics" },
		{ type: "executeCommand", command: "manageServers" },
	]);
});

test("with no servers the guided start renders and its call to action opens the add form", () => {
	const root = mountSection([]);
	const start = root.querySelector(".empty-start");
	expect(start).not.toBeNull();
	expect(start?.querySelector("h3")?.textContent).toBe("Connect LiteLLM to Copilot Chat");
	// Three concrete steps, no bare table.
	expect(start?.querySelectorAll("ol li").length).toBe(3);
	expect(root.querySelector("table.servers")).toBeNull();

	fireClick(buttonByText(root, "Add your first server"));
	expect(root.querySelector(".slide-over .form-card")).not.toBeNull();
});

test("a noticed entry renders the params-inactive badge and the remedy paragraph", () => {
	const root = mountSection([
		makeDeclaredServer({ label: "Prod", notice: "entry-params-inactive" }),
		makeDeclaredServer({ label: "Quiet", baseUrl: "http://quiet.test" }),
	]);

	const badge = [...root.querySelectorAll("span.badge.state-warn")].find(
		(el) => el.textContent?.trim() === "params inactive"
	);
	expect(badge).toBeDefined();
	// Native title attributes do not render in the webview host; the detail
	// rides the CSS hover tip next to the badge instead.
	const tip = badge?.closest(".tip-wrap")?.querySelector(".help-tip");
	expect(tip?.textContent).toContain("run Sync Models Now");

	const paragraph = root.querySelector("p.state-warn");
	expect(paragraph?.textContent).toContain("Prod");
	expect(paragraph?.textContent).not.toContain("Quiet");
	expect(paragraph?.textContent).toContain("per-server model parameters are not applied");
	expect(paragraph?.textContent).toContain("run Sync Models Now");
});

test("without a notice, no params-inactive badge or paragraph renders", () => {
	const root = mountSection([makeDeclaredServer()]);
	expect([...root.querySelectorAll("span.badge")].map((el) => el.textContent?.trim())).not.toContain("params inactive");
	expect(root.querySelector("p.state-warn")).toBeNull();
});

test("the edit form round-trips per-entry model parameters into the save intent", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelParameters: { "gpt-4": { temperature: 0.2 } },
			},
		}),
	]);
	fireClick(buttonByText(root, "Edit"));

	// The entry already carries parameters, so the disclosure opens prefilled.
	const prefixInput = root.querySelector<HTMLInputElement>('input[placeholder^="Model prefix"]');
	const keyInput = root.querySelector<HTMLInputElement>('input[placeholder^="Parameter"]');
	const valueInput = root.querySelector<HTMLInputElement>('input[placeholder^="JSON value"]');
	if (prefixInput === null || keyInput === null || valueInput === null) {
		throw new Error("the per-entry model parameters rows did not render");
	}
	expect(prefixInput.value).toBe("gpt-4");
	expect(keyInput.value).toBe("temperature");
	expect(valueInput.value).toBe("0.2");

	// The entry editor's prefix copy must not advertise URL scoping: entry
	// keys match model IDs only (the entry is already scoped to its server),
	// while the global editor keeps the URL-example placeholder and help
	// (pinned in recordEditors.test.tsx). One shared component, two registers.
	expect(prefixInput.placeholder).toBe("Model prefix, e.g. gpt-4");
	const glyph = prefixInput.closest(".cell")?.querySelector("button.help");
	const tip = document.getElementById(glyph?.getAttribute("aria-describedby") ?? "");
	expect(tip?.textContent).toBe(HELP_ENTRY_MODEL_PARAMETER_PREFIX);

	// An invalid JSON value blocks Save without posting anything.
	fireInput(valueInput, "not json");
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages).toEqual([]);
	expect(root.textContent).toContain("Cannot save: fix Model parameters");

	// Fixed, the save intent carries the edited record.
	fireInput(valueInput, "0.9");
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages.length).toBe(1);
	const saved = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "saveServerSetting" }>;
	expect(saved.type).toBe("saveServerSetting");
	expect(saved.replaceLabel).toBe("Prod");
	expect(saved.server.modelParameters).toEqual({ "gpt-4": { temperature: 0.9 } });
});

test("remove is two-step: Remove arms the row, Confirm posts removeServerSetting with a fresh requestId, Cancel disarms", () => {
	const root = mountSection([makeDeclaredServer({ label: "Prod" })]);

	// Arm, then cancel: nothing posted, the row returns to Edit/Remove.
	fireClick(buttonByText(root, "Remove"));
	expect(root.textContent).toContain("Confirm remove?");
	fireClick(buttonByText(root, "Cancel"));
	expect(postedMessages).toEqual([]);
	expect(root.textContent).not.toContain("Confirm remove?");

	// Arm and confirm: exactly one removeServerSetting for the label.
	fireClick(buttonByText(root, "Remove"));
	fireClick(buttonByText(root, "Confirm remove?"));
	expect(postedMessages.length).toBe(1);
	const first = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "removeServerSetting" }>;
	expect(first.type).toBe("removeServerSetting");
	expect(first.label).toBe("Prod");
	expect(typeof first.requestId).toBe("string");
	expect(first.requestId.length).toBeGreaterThan(0);

	// A second confirmation carries a fresh correlation ID.
	fireClick(buttonByText(root, "Remove"));
	fireClick(buttonByText(root, "Confirm remove?"));
	const second = postedMessages[1] as Extract<WebviewToExtensionMessage, { type: "removeServerSetting" }>;
	expect(second.requestId).not.toBe(first.requestId);
});

test("add-form save round trip: invalid posts nothing, the ack closes the form, failures follow their disposition", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));

	fireClick(buttonByText(root, "Add server"));
	expect(root.querySelector(".form-card")).not.toBeNull();

	// Invalid draft: Save posts nothing and names the first blocking problem.
	resetPosted();
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages).toEqual([]);
	expect(root.textContent).toContain("Cannot save: fix Label");

	// Valid draft: Save posts one saveServerSetting; its own ack closes the form.
	fireInput(inputByLabel(root, "Label"), "Prod");
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages.length).toBe(1);
	const saved = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "saveServerSetting" }>;
	expect(saved.type).toBe("saveServerSetting");
	expect(saved.server).toEqual({ label: "Prod", baseUrl: "http://localhost:4000" });

	// An ack for some other intent must not close it.
	pushToWebview({ type: "intentSucceeded", intentType: "saveServerSetting", requestId: "someone-elses" });
	expect(root.querySelector(".form-card")).not.toBeNull();
	pushToWebview({ type: "intentSucceeded", intentType: "saveServerSetting", requestId: saved.requestId });
	expect(root.querySelector(".form-card")).toBeNull();

	// Validation-kind failure: the draft is still the truth, the form reopens for retry.
	fireClick(buttonByText(root, "Add server"));
	fireInput(inputByLabel(root, "Label"), "Second");
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4001");
	resetPosted();
	fireClick(buttonByText(root, "Save"));
	const retry = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "saveServerSetting" }>;
	pushToWebview({
		type: "intentFailed",
		intentType: "saveServerSetting",
		message: "label: reserved name",
		kind: "validation",
		requestId: retry.requestId,
	});
	expect(root.querySelector(".form-card")).not.toBeNull();
	expect(buttonByText(root, "Save").disabled).toBe(false);
	expect(root.textContent).toContain("Label: reserved name");

	// Operation-kind failure: the write committed, the stale draft closes.
	resetPosted();
	fireClick(buttonByText(root, "Save"));
	const committed = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "saveServerSetting" }>;
	pushToWebview({
		type: "intentFailed",
		intentType: "saveServerSetting",
		message: "saved, but the group sync failed; run Sync Models Now",
		kind: "operation",
		requestId: committed.requestId,
	});
	expect(root.querySelector(".form-card")).toBeNull();
	expect(root.textContent).toContain("saved, but the group sync failed");
});

test("adopting an external row posts adoptServer carrying exactly the sanctioned keys", () => {
	const external = makeExternalServer({ label: "Copilot", baseUrl: "http://copilot.example:4000" });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [external] })));

	fireClick(buttonByText(root, "Edit"));
	expect(root.textContent).toContain("Adopt Copilot");

	fireInput(inputByLabel(root, "Label"), "Adopted Copilot");
	resetPosted();
	fireClick(buttonByText(root, "Adopt"));
	expect(postedMessages.length).toBe(1);
	const posted = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "adoptServer" }>;

	// Deep equality of the sorted key set: presence checks would pass if a
	// sixth, credential-bearing key were ever added to the intent.
	expect(Object.keys(posted).sort()).toEqual(["baseUrl", "label", "requestId", "secrets", "sourceHandle", "type"]);
	expect(posted.type).toBe("adoptServer");
	expect(posted.label).toBe("Adopted Copilot");
	expect(posted.baseUrl).toBe("http://copilot.example:4000");
	expect(posted.sourceHandle).toBe(external.adoptHandle);
	expect(typeof posted.requestId).toBe("string");
	// The secrets record carries storage locations only, one per secret field.
	expect(posted.secrets).toEqual({ apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" });
	expect(Object.keys(posted.secrets).sort()).toEqual(["apiKey", "oauthClientSecret", "virtualKeyValue"]);
});
