/**
 * ServersSection behavior: toolbar command wiring, the two-step remove, the
 * add-form save round trip with requestId correlation, and the adopt intent's
 * exact payload (exhaustive key inspection: a credential-shaped field smuggled
 * into adoptServer must fail here).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { WebviewToExtensionMessage } from "../../../extension/dashboard/protocol";
import { App } from "../../../webview/dashboard/app";
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
