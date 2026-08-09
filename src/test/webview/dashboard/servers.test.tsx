/**
 * ServersSection behavior: toolbar command wiring, the two-step remove, the
 * add-form save round trip with requestId correlation, and the adopt intent's
 * exact payload (exhaustive key inspection: a credential-shaped field smuggled
 * into adoptServer must fail here).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import type { DashboardServer, WebviewToExtensionMessage } from "../../../extension/dashboard/protocol";
import { App } from "../../../webview/dashboard/app";
import { DOCS_LINK_CHECK_BASE_URL, DOCS_LINK_PROXY_NOT_RUNNING } from "../../../webview/dashboard/docsLinks";
import { helpEntryModelParameterPrefix } from "../../../webview/dashboard/helpText";
import { ServersSection } from "../../../webview/dashboard/servers";
import {
	makeDeclaredServer,
	makeExternalServer,
	makeForbiddenUsageServer,
	makeState,
	makeUsage,
	makeUsageServer,
	statePush,
} from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireBlur,
	fireCheck,
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

function mountSection(servers: readonly DashboardServer[]) {
	return mount(
		<ServersSection
			servers={servers}
			now={Date.now()}
			ack={undefined}
			failures={{}}
			inlineSecrets={undefined}
			onDismissFailure={noop}
			onClearInlineSecrets={noop}
		/>
	);
}

/** Open the form's full matcher editor overlay for one record through its table pencil. */
function openMatcherEditor(root: HTMLElement, prefix: string): HTMLElement {
	const pencil = [...root.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === `Open the full editor for "${prefix}"`
	);
	if (pencil === undefined) {
		throw new Error(`no pencil for matcher ${prefix}`);
	}
	fireClick(pencil as HTMLButtonElement);
	const overlay = root.querySelector<HTMLElement>(".matcher-editor");
	if (overlay === null) {
		throw new Error("no matcher editor overlay is open");
	}
	return overlay;
}

/** The field chip button whose visible key matches, in the form's record tables. */
function chipFor(root: HTMLElement, key: string): HTMLButtonElement {
	const chip = [...root.querySelectorAll("button.chip-field")].find(
		(candidate) => candidate.querySelector(".chip-key")?.textContent === key
	);
	if (chip === undefined) {
		throw new Error(`no chip for field ${key}`);
	}
	return chip as HTMLButtonElement;
}

test("the toolbar renders only once a server exists, and holds only the add entry point", () => {
	// First run: the guided card is the only affordance, no strip of dead
	// controls above it.
	const empty = mountSection([]);
	expect(empty.querySelector(".toolbar")).toBeNull();

	// Test connection and the diagnostics view live on the Diagnostics tab,
	// and the native editor is not a destination: Add server stands alone.
	const populated = mountSection([makeDeclaredServer()]);
	const buttons = [...populated.querySelectorAll(".toolbar button")].map((el) => el.textContent?.trim());
	expect(buttons).toEqual(["Add server"]);
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
		makeDeclaredServer({ label: "Prod", notices: ["entry-params-inactive"] }),
		makeDeclaredServer({ label: "Quiet", baseUrl: "http://quiet.test" }),
	]);

	const badge = [...root.querySelectorAll("span.badge.state-warn")].find(
		(el) => el.textContent?.trim() === "params inactive"
	);
	expect(badge).toBeDefined();
	// Native title attributes do not render in the webview host; the detail
	// rides the CSS hover tip next to the badge instead.
	const tip = badge?.closest(".tip-wrap")?.querySelector(".help-tip");
	expect(tip?.textContent).toContain("The banner below has the fix");

	const paragraph = root.querySelector("p.state-warn");
	expect(paragraph?.textContent).toContain("Prod");
	expect(paragraph?.textContent).not.toContain("Quiet");
	expect(paragraph?.textContent).toContain("per-server model parameters are not applied");
	// The remedy renders as numbered steps under the lead line, not prose.
	const banner = root.querySelector(".banner-warn");
	expect(banner?.textContent).toContain("run Sync Models Now");
	expect(banner?.querySelectorAll("ol.notice-steps li").length).toBe(2);
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

	// The entry already carries parameters, so the table summarizes them; the
	// row inputs live in the record's matcher editor overlay.
	expect(root.querySelector(".record-table .matcher-key")?.textContent).toBe("gpt-4");
	const overlay = openMatcherEditor(root, "gpt-4");
	const prefixInput = overlay.querySelector<HTMLInputElement>('input[placeholder^="Model ID or matcher"]');
	const keyInput = overlay.querySelector<HTMLInputElement>('input[placeholder^="Parameter"]');
	const valueInput = overlay.querySelector<HTMLInputElement>('input[placeholder^="JSON value"]');
	if (prefixInput === null || keyInput === null || valueInput === null) {
		throw new Error("the per-entry model parameters rows did not render");
	}
	expect(prefixInput.value).toBe("gpt-4");
	expect(keyInput.value).toBe("temperature");
	expect(valueInput.value).toBe("0.2");

	// The entry editor's matcher copy must not advertise URL keys: entry
	// keys match model IDs only (the entry is already scoped to its server),
	// while the global editor's help routes server records to entries
	// (pinned in recordEditors.test.tsx). One shared overlay, two registers.
	expect(prefixInput.placeholder).toBe("Model ID or matcher, e.g. gpt-4 or gpt-4*");
	const glyph = prefixInput.closest(".cell")?.querySelector("button.help");
	const tip = document.getElementById(glyph?.getAttribute("aria-describedby") ?? "");
	expect(tip?.textContent).toBe(helpEntryModelParameterPrefix());

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

test("blur alone paints no problem on an empty field, and blurring content is what makes a touch stick", () => {
	// The touch guard: brushing focus past a pristine empty field (toward
	// Cancel, say) must not repaint the form mid-click - an inserted error
	// line would move the buttons under the pointer.
	const root = mountSection([]);
	fireClick(buttonByText(root, "Add your first server"));
	const label = inputByLabel(root, "Label");

	fireBlur(label);
	expect(root.textContent).not.toContain("Enter a label");
	expect(root.textContent).not.toContain("Cannot save");
	expect(label.getAttribute("aria-invalid")).toBe("false");

	// Typing, thinking better of it, and clearing before any blur returns the
	// field to pristine: blur on the emptied field still paints nothing.
	fireInput(label, "P");
	fireInput(label, "");
	fireBlur(label);
	expect(root.textContent).not.toContain("Enter a label");
	expect(root.textContent).not.toContain("Cannot save");

	// Content alone makes a field's problem visible, before any blur.
	const baseUrl = inputByLabel(root, "Base URL");
	fireInput(baseUrl, "not a url");
	expect(root.textContent).toContain("Must be a usable http(s) URL");
	expect(baseUrl.getAttribute("aria-invalid")).toBe("true");

	// Blurring the field while it holds content is what marks it touched:
	// clearing it afterwards swaps in the empty-field problem instead of
	// going quiet the way the never-blurred Label above did.
	fireBlur(baseUrl);
	fireInput(baseUrl, "");
	expect(root.textContent).toContain("Enter the server URL");
	expect(baseUrl.getAttribute("aria-invalid")).toBe("true");
});

test("Save on the empty form touches every field: both required-field problems surface at once", () => {
	// Required-but-empty fields stay quiet on blur, so Save is the moment
	// they all speak up: not just the first blocking field, every one.
	const root = mountSection([]);
	fireClick(buttonByText(root, "Add your first server"));

	fireClick(buttonByText(root, "Save"));
	expect(postedMessages).toEqual([]);
	expect(root.textContent).toContain("Enter a label");
	expect(root.textContent).toContain("Enter the server URL");
	// The summary names the first blocking field in form order.
	expect(root.textContent).toContain("Cannot save: fix Label");
	expect(inputByLabel(root, "Label").getAttribute("aria-invalid")).toBe("true");
	expect(inputByLabel(root, "Base URL").getAttribute("aria-invalid")).toBe("true");
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

	fireClick(buttonByText(root, "Add your first server"));
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
	// The entry-record fields ride every save, even empty: absent is
	// reserved for payloads that predate their editors (the save carries the
	// stored values forward for those instead of deleting them).
	expect(saved.server).toEqual({
		label: "Prod",
		baseUrl: "http://localhost:4000",
		modelCapabilities: {},
		expectedFailures: [],
		headers: {},
		declaredModels: [],
		budget: null,
	});

	// An ack for some other intent must not close it.
	pushToWebview({ type: "intentSucceeded", intentType: "saveServerSetting", requestId: "someone-elses" });
	expect(root.querySelector(".form-card")).not.toBeNull();
	pushToWebview({ type: "intentSucceeded", intentType: "saveServerSetting", requestId: saved.requestId });
	expect(root.querySelector(".form-card")).toBeNull();

	// Validation-kind failure: the draft is still the truth, the form reopens for retry.
	fireClick(buttonByText(root, "Add your first server"));
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

test("removing an external row is two-step and posts hideExternalServer with the row's handle", () => {
	const external = makeExternalServer({ label: "Copilot", baseUrl: "http://copilot.example:4000" });
	const root = mountSection([external]);

	// Arm, then cancel: nothing posted.
	fireClick(buttonByText(root, "Remove"));
	expect(root.textContent).toContain("Confirm remove?");
	fireClick(buttonByText(root, "Cancel"));
	expect(postedMessages).toEqual([]);

	fireClick(buttonByText(root, "Remove"));
	fireClick(buttonByText(root, "Confirm remove?"));
	expect(postedMessages.length).toBe(1);
	const posted = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "hideExternalServer" }>;
	// Exact key set: the intent names the group by its opaque handle and URL,
	// nothing more.
	expect(Object.keys(posted).sort()).toEqual(["baseUrl", "requestId", "sourceHandle", "type"]);
	expect(posted.type).toBe("hideExternalServer");
	expect(posted.baseUrl).toBe("http://copilot.example:4000");
	expect(posted.sourceHandle).toBe(external.adoptHandle);
	expect(typeof posted.requestId).toBe("string");
});

test("a non-hideable external row (legacy registry) offers Edit only, no Remove", () => {
	const root = mountSection([makeExternalServer({ hideable: false })]);
	const actions = [...root.querySelectorAll("td.actions button")].map((el) => el.textContent?.trim());
	expect(actions).toEqual(["Edit"]);
});

test("the hide ack raises the guidance notice naming the group, with the models-file action", () => {
	const external = makeExternalServer({ label: "Copilot" });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [external] })));

	resetPosted();
	fireClick(buttonByText(root, "Remove"));
	fireClick(buttonByText(root, "Confirm remove?"));
	const posted = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "hideExternalServer" }>;

	// A foreign ack does nothing; the intent's own ack raises the notice.
	pushToWebview({ type: "intentSucceeded", intentType: "hideExternalServer", requestId: "someone-elses" });
	expect(root.querySelector(".notice")).toBeNull();
	pushToWebview({ type: "intentSucceeded", intentType: "hideExternalServer", requestId: posted.requestId });
	const notice = root.querySelector(".notice");
	expect(notice).not.toBeNull();
	// The notice names the exact group and gives the file-based steps as a
	// numbered list: the models file is where real deletion lives.
	expect(notice?.textContent).toContain('"Copilot"');
	expect(notice?.textContent).toContain("models file");
	expect(notice?.textContent).toContain("Reload the window");
	expect(notice?.textContent).toContain("Sync models");
	expect(notice?.querySelectorAll("ol.notice-steps li").length).toBe(3);

	resetPosted();
	const openButton = [...(notice?.querySelectorAll("button") ?? [])].find(
		(el) => el.textContent?.trim() === "Open models file"
	);
	fireClick(openButton as HTMLElement);
	expect(postedMessages).toEqual([{ type: "executeCommand", command: "openGroupsFile" }]);

	fireClick(buttonByText(root, "Dismiss"));
	expect(root.querySelector(".notice")).toBeNull();
});

test("the hidden-groups line states the count, expands to rows, and Unhide posts the identity verbatim", () => {
	const root = mount(
		<ServersSection
			servers={[makeDeclaredServer()]}
			hidden={[
				{ label: "Old", baseUrl: "http://old.test" },
				{ label: "Gone", baseUrl: "http://gone.test" },
			]}
			now={Date.now()}
			ack={undefined}
			failures={{}}
			inlineSecrets={undefined}
			onDismissFailure={noop}
			onClearInlineSecrets={noop}
		/>
	);

	const line = root.querySelector(".hidden-groups");
	expect(line).not.toBeNull();
	expect(line?.textContent).toContain("2 hidden groups");
	// Collapsed by default: no Unhide until shown.
	expect(line?.textContent).not.toContain("Unhide");

	fireClick(buttonByText(root, "show"));
	expect(line?.textContent).toContain("Old");
	expect(line?.textContent).toContain("http://old.test");
	const unhide = [...root.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Unhide");
	fireClick(unhide as HTMLElement);
	expect(postedMessages.length).toBe(1);
	const posted = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "unhideServer" }>;
	expect(posted.type).toBe("unhideServer");
	// The identity is echoed verbatim from the first listed row.
	expect(posted.label).toBe("Old");
	expect(posted.baseUrl).toBe("http://old.test");
	expect(typeof posted.requestId).toBe("string");
});

test("without hidden groups no hidden-groups line renders; with them it renders even beside the empty start", () => {
	const none = mountSection([makeDeclaredServer()]);
	expect(none.querySelector(".hidden-groups")).toBeNull();

	// Every visible group hidden: the guided start renders, but the unhide
	// path must stay reachable.
	const onlyHidden = mount(
		<ServersSection
			servers={[]}
			hidden={[{ label: "Old", baseUrl: "http://old.test" }]}
			now={Date.now()}
			ack={undefined}
			failures={{}}
			inlineSecrets={undefined}
			onDismissFailure={noop}
			onClearInlineSecrets={noop}
		/>
	);
	expect(onlyHidden.querySelector(".empty-start")).not.toBeNull();
	expect(onlyHidden.querySelector(".hidden-groups")?.textContent).toContain("1 hidden group");
});

test("the external badge tip renders the provenance classification, or the honest default", () => {
	const root = mountSection([
		makeExternalServer({
			label: "Old",
			baseUrl: "http://a.test",
			provenance: { kind: "removed-entry-leftover", removedLabel: "Old" },
		}),
		makeExternalServer({
			label: "Renamed",
			baseUrl: "http://b.test",
			provenance: { kind: "rename-leftover", oldLabel: "Renamed", newLabel: "Fresh" },
		}),
		makeExternalServer({ label: "Native", baseUrl: "http://c.test" }),
	]);

	const tips = [...root.querySelectorAll("span.badge")]
		.filter((el) => el.textContent?.trim() === "external")
		.map((el) => el.closest(".tip-wrap")?.querySelector(".help-tip")?.textContent ?? "");
	expect(tips.length).toBe(3);
	const removedTip = tips.find((tip) => tip.includes('removed entry "Old"'));
	expect(removedTip).toContain("Leftover");
	const renamedTip = tips.find((tip) => tip.includes('renaming "Renamed" to "Fresh"'));
	expect(renamedTip).toContain("Leftover");
	const defaultTip = tips.find((tip) => tip.includes("predates"));
	expect(defaultTip).toContain("added outside this extension");
});

test("the model count is a scope link only when the section is given onShowModels", () => {
	// Direct mounts without the callback (and zero-count rows) keep the count
	// as plain text: a link that scopes to nothing helps nobody.
	const plain = mountSection([makeDeclaredServer({ label: "Prod", modelCount: 3 })]);
	expect(plain.querySelector("button[aria-label='Show models from Prod']")).toBeNull();

	const labels: string[] = [];
	const root = mount(
		<ServersSection
			servers={[makeDeclaredServer({ label: "Prod", modelCount: 3 }), makeDeclaredServer({ label: "Empty" })]}
			now={Date.now()}
			ack={undefined}
			failures={{}}
			inlineSecrets={undefined}
			onDismissFailure={noop}
			onClearInlineSecrets={noop}
			onShowModels={(label) => labels.push(label)}
		/>
	);
	expect(root.querySelector("button[aria-label='Show models from Empty']")).toBeNull();
	fireClick(root.querySelector("button[aria-label='Show models from Prod']") as HTMLElement);
	expect(labels).toEqual(["Prod"]);
});

test("Test connection gates on the base URL alone, posts the draft's exact keys, and its own ack renders the result", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	fireClick(buttonByText(root, "Add your first server"));

	// Unusable URL: the button is the only thing disabled; a savable label is
	// deliberately not required to probe.
	expect(buttonByText(root, "Test connection").disabled).toBe(true);
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");
	expect(buttonByText(root, "Test connection").disabled).toBe(false);

	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	expect(postedMessages.length).toBe(1);
	const posted = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "testServerDraft" }>;
	// Exact key set, like the adopt test: a smuggled extra field must fail here.
	expect(Object.keys(posted).sort()).toEqual(["requestId", "secrets", "server", "type"]);
	expect(posted.type).toBe("testServerDraft");
	expect(posted.server).toEqual({
		label: "",
		baseUrl: "http://localhost:4000",
		modelCapabilities: {},
		expectedFailures: [],
		headers: {},
		declaredModels: [],
		budget: null,
	});
	expect(posted.secrets).toEqual({
		apiKey: { action: "keep" },
		oauthClientSecret: { action: "keep" },
		virtualKeyValue: { action: "keep" },
	});
	expect(typeof posted.requestId).toBe("string");

	// In flight: the button goes busy, Save and Cancel stay live.
	expect(buttonByText(root, "Testing...").disabled).toBe(true);
	expect(buttonByText(root, "Save").disabled).toBe(false);
	expect(buttonByText(root, "Cancel").disabled).toBe(false);

	// A foreign ack changes nothing; the test's own ack renders the
	// extension-composed message verbatim, selectable in the footer.
	pushToWebview({
		type: "intentSucceeded",
		intentType: "testServerDraft",
		requestId: "someone-elses",
		message: "Connected - 9 models",
	});
	expect(root.textContent).toContain("Testing...");
	pushToWebview({
		type: "intentSucceeded",
		intentType: "testServerDraft",
		requestId: posted.requestId,
		message: "Connected - 3 models",
	});
	expect(root.querySelector(".test-result")?.textContent).toBe("Connected - 3 models");
	expect(root.textContent).not.toContain("Testing...");
	// A pass never carries a troubleshooting link.
	expect(root.querySelector(".test-hint")).toBeNull();
	// The form stayed open throughout: the probe never doubles as a save.
	expect(root.querySelector(".form-card")).not.toBeNull();
});

test("a failed test with a setup hint renders the troubleshooting link inside the alert", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	fireClick(buttonByText(root, "Add your first server"));
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");

	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const posted = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "testServerDraft" }>;
	pushToWebview({
		type: "intentFailed",
		intentType: "testServerDraft",
		message: "the server answered 404",
		kind: "validation",
		requestId: posted.requestId,
		classification: { kind: "http", status: 404, setupHint: "check-base-url" },
	});

	// The error message renders as before; the link rides inside the alert
	// element (one live-region announcement covers both) and targets the
	// troubleshooting-guide section matching the setup-hint id, with short
	// visible text and the fuller per-cause accessible label.
	const alert = root.querySelector(".test-result.error");
	expect(alert?.getAttribute("role")).toBe("alert");
	// Full text pinned: message, the copy-selection space, then the link
	// label - dropping the space would glue "404Troubleshoot" in copied text.
	expect(alert?.textContent).toBe("the server answered 404 Troubleshoot");
	const anchor = alert?.querySelector<HTMLAnchorElement>(".test-hint a.docs-link");
	expect(anchor?.getAttribute("href")).toBe(DOCS_LINK_CHECK_BASE_URL);
	expect(anchor?.getAttribute("aria-label")).toBe("Open the troubleshooting guide: the server answered 404");
	expect(anchor?.textContent).toContain("Troubleshoot");

	// A classification without a setup hint renders no link line either.
	resetPosted();
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4001");
	fireClick(buttonByText(root, "Test connection"));
	const second = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "testServerDraft" }>;
	pushToWebview({
		type: "intentFailed",
		intentType: "testServerDraft",
		message: "LiteLLM API error: 500",
		kind: "validation",
		requestId: second.requestId,
		classification: { kind: "http", status: 500 },
	});
	expect(root.querySelector(".test-result.error")?.textContent).toContain("LiteLLM API error: 500");
	expect(root.querySelector(".test-hint")).toBeNull();
});

test("classified refresh failures carry per-entry Troubleshoot links; unclassified entries stay plain", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Prod",
			state: "error",
			error: "unable to connect",
			classification: { kind: "connection", setupHint: "proxy-not-running" },
		}),
		makeDeclaredServer({ label: "Quiet", baseUrl: "http://quiet.test", state: "error", error: "boom" }),
		makeDeclaredServer({
			label: "Wrong",
			baseUrl: "http://wrong.test",
			state: "error",
			error: "answered 404",
			classification: { kind: "http", status: 404, setupHint: "check-base-url" },
		}),
	]);

	// The whole line pinned as text: each link rides its own entry (before the
	// separator to the next), the unclassified entry stays plain, and copied
	// text keeps a space between the error and the link label. A missing link
	// fails this line loudly - no vacuous index comparisons.
	const banner = root.querySelector(".banner-error p.error");
	expect(banner?.textContent).toBe(
		"Prod: unable to connect Troubleshoot; Quiet: boom; Wrong: answered 404 Troubleshoot"
	);

	// Two classified failures, two links, each targeting the
	// troubleshooting-guide section matching its own setup-hint id, with the
	// fuller per-cause accessible label - the same links the draft-test footer
	// renders.
	const anchors = [...(banner?.querySelectorAll<HTMLAnchorElement>(".banner-hint a.docs-link") ?? [])];
	expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual([
		DOCS_LINK_PROXY_NOT_RUNNING,
		DOCS_LINK_CHECK_BASE_URL,
	]);
	expect(anchors.map((anchor) => anchor.getAttribute("aria-label"))).toEqual([
		"Open the troubleshooting guide: unable to connect",
		"Open the troubleshooting guide: the server answered 404",
	]);
});

test("without a classification the error banner renders exactly as before: joined text, no elements", () => {
	const root = mountSection([
		makeDeclaredServer({ label: "Prod", state: "error", error: "boom" }),
		makeDeclaredServer({ label: "Beta", baseUrl: "http://beta.test", state: "error", error: "bang" }),
	]);
	// Pinned markup: the joined line stays pure text - no link, no wrapper
	// span appeared for unclassified failures.
	expect(root.querySelector(".banner-error p.error")?.innerHTML).toBe("Prod: boom; Beta: bang");
});

test("a hintless classification renders no troubleshooting link in the banner", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Prod",
			state: "error",
			error: "LiteLLM API error: 500",
			classification: { kind: "http", status: 500 },
		}),
	]);
	expect(root.querySelector(".banner-error p.error")?.innerHTML).toBe("Prod: LiteLLM API error: 500");
	expect(root.querySelector(".banner-hint")).toBeNull();
});

test("a failed test renders its message inline and the result clears on any credential-affecting edit", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	// The entry has no credentials, so the form derives to None; the API-key
	// form is picked up front so the credential-edit steps below have their
	// input (the pick itself would clear a standing result too).
	const apiKeyOption = [...root.querySelectorAll(".auth-selector label")].find(
		(el) => (el.textContent ?? "").trim() === "API key (bearer)"
	);
	fireCheck(apiKeyOption?.querySelector("input") as HTMLInputElement, true);

	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const posted = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "testServerDraft" }>;
	// Editing an entry: the intent addresses "keep" resolution at the original label.
	expect(posted.replaceLabel).toBe("Prod");

	pushToWebview({
		type: "intentFailed",
		intentType: "testServerDraft",
		message: "Network Error: unable to reach the server",
		kind: "validation",
		requestId: posted.requestId,
	});
	const result = root.querySelector(".test-result");
	expect(result?.textContent).toContain("Network Error: unable to reach the server");
	// Inline only: no section-level failure banner for the probe.
	expect(root.querySelector(".banner-error")).toBeNull();
	// A notice without a classification renders exactly the pre-link UI: no
	// troubleshooting link anywhere in the footer.
	expect(root.querySelector(".test-hint")).toBeNull();
	expect(root.querySelector(".form-card .toolbar a.docs-link")).toBeNull();

	// A label edit clears it too: the label selects which stored or orphan
	// secret a "keep" resolves, so a rename can change the effective
	// credentials the probe would use - a stale PASS on those is worse than none.
	fireInput(inputByLabel(root, "Label"), "Prod renamed");
	expect(root.querySelector(".test-result")).toBeNull();

	// A credential edit invalidates a fresh result the same way.
	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const second = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "testServerDraft" }>;
	pushToWebview({
		type: "intentSucceeded",
		intentType: "testServerDraft",
		requestId: second.requestId,
		message: "Connected - 2 models",
	});
	expect(root.querySelector(".test-result")).not.toBeNull();
	fireInput(inputByLabel(root, "API key"), "sk-new");
	expect(root.querySelector(".test-result")).toBeNull();

	// Same for the base URL, from a fresh PASS.
	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const third = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "testServerDraft" }>;
	expect(third.secrets.apiKey).toEqual({ action: "set", location: "secure", value: "sk-new" });
	pushToWebview({
		type: "intentSucceeded",
		intentType: "testServerDraft",
		requestId: third.requestId,
		message: "Connected - 2 models",
	});
	expect(root.querySelector(".test-result")).not.toBeNull();
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4001");
	expect(root.querySelector(".test-result")).toBeNull();
});

test("an in-flight test is abandoned by a connection edit: the stale outcome is ignored", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	fireClick(buttonByText(root, "Add your first server"));
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");

	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const posted = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "testServerDraft" }>;
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4001");
	// The edit returned the button to idle and dropped the pending requestId...
	expect(root.textContent).not.toContain("Testing...");
	// ...so the late outcome for the old draft paints nothing.
	pushToWebview({
		type: "intentSucceeded",
		intentType: "testServerDraft",
		requestId: posted.requestId,
		message: "Connected - 3 models",
	});
	expect(root.querySelector(".test-result")).toBeNull();
});

test("Test with a partial OAuth draft posts nothing and surfaces the pairing problem like Save would", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	fireClick(buttonByText(root, "Add your first server"));
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");
	const oauthOption = [...root.querySelectorAll(".auth-selector label")].find(
		(el) => (el.textContent ?? "").trim() === "OAuth"
	);
	fireCheck(oauthOption?.querySelector("input") as HTMLInputElement, true);
	fireInput(inputByLabel(root, "OAuth client ID"), "client-1");

	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	expect(postedMessages).toEqual([]);
	// Probing half an OAuth configuration would test a connection the saved
	// entry would never send, so the form blocks it with the pairing message.
	expect(root.textContent).toContain("OAuth needs the token URL and client ID");
});

test("a test in flight does not block Cancel; the form closes and the outcome lands nowhere", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	fireClick(buttonByText(root, "Add your first server"));
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");
	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const posted = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "testServerDraft" }>;

	// The typed URL made the form dirty, so Cancel raises the discard confirm
	// (unchanged semantics); Discard closes despite the probe in flight.
	fireClick(buttonByText(root, "Cancel"));
	fireClick(buttonByText(root, "Discard"));
	expect(root.querySelector(".form-card")).toBeNull();

	// The abandoned outcome must not throw or resurrect anything.
	pushToWebview({
		type: "intentFailed",
		intentType: "testServerDraft",
		message: "Network Error: unreachable",
		kind: "validation",
		requestId: posted.requestId,
	});
	expect(root.querySelector(".test-result")).toBeNull();
	expect(root.querySelector(".banner-error")).toBeNull();
});

test("the edit form round-trips model capabilities and expected failures into the save intent", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: { "my-model": { context_length: 128000, supports_vision: true } },
				expectedFailures: ["modelListing"],
			},
		}),
	]);
	fireClick(buttonByText(root, "Edit"));

	// The entry already carries capabilities: the table summarizes them, the
	// overlay renders the typed controls (number field as a number input, the
	// support flag as a checkbox), and the expected-failure category is
	// ticked in the form itself.
	const overlay = openMatcherEditor(root, "my-model");
	const prefixInput = overlay.querySelector<HTMLInputElement>('input[placeholder^="Model ID or matcher"]');
	expect(prefixInput?.value).toBe("my-model");
	const numberInput = overlay.querySelector<HTMLInputElement>('input[placeholder^="Tokens"]');
	expect(numberInput?.value).toBe("128000");
	const visionBox = [...overlay.querySelectorAll("label.capability-flag")]
		.find((label) => label.textContent?.includes("supported"))
		?.querySelector("input");
	expect(visionBox?.checked).toBe(true);
	const listing = [...root.querySelectorAll(".expected-failures label")].find((label) =>
		label.textContent?.includes("/models")
	);
	expect(listing?.querySelector("input")?.checked).toBe(true);
	const info = [...root.querySelectorAll(".expected-failures label")].find((label) =>
		label.textContent?.includes("/model/info")
	);
	expect(info?.querySelector("input")?.checked).toBe(false);

	// An invalid token count blocks Save without posting anything.
	if (numberInput === null) {
		throw new Error("the capability rows did not render");
	}
	fireInput(numberInput, "");
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages).toEqual([]);
	expect(root.textContent).toContain("Cannot save: fix Model capabilities");

	// Fixed, plus ticking the second category: the save intent carries both.
	fireInput(numberInput, "200000");
	fireCheck(info?.querySelector("input") as HTMLInputElement, true);
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages.length).toBe(1);
	const saved = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "saveServerSetting" }>;
	expect(saved.server.modelCapabilities).toEqual({ "my-model": { context_length: 200000, supports_vision: true } });
	expect(saved.server.expectedFailures).toEqual(["modelListing", "modelInfo"]);
});

test("an unknown capability key hints without blocking the save", () => {
	const root = mountSection([makeDeclaredServer({ label: "Prod" })]);
	fireClick(buttonByText(root, "Edit"));
	fireClick(buttonByText(root, "Add capability matcher"));
	const overlay = root.querySelector<HTMLElement>(".matcher-editor");
	if (overlay === null) {
		throw new Error("Add capability matcher did not open the overlay");
	}
	fireClick(buttonByText(overlay, "Add capability"));
	const prefixInput = overlay.querySelector<HTMLInputElement>('input[placeholder^="Model ID or matcher"]');
	const keyInput = overlay.querySelector<HTMLInputElement>('input[placeholder^="Capability"]');
	if (prefixInput === null || keyInput === null) {
		throw new Error("the capability rows did not render");
	}
	fireInput(prefixInput, "gpt-4");
	fireInput(keyInput, "supports_pdf_input");
	// A boolean-shaped unknown key gets a JSON value input, not a checkbox.
	const valueInput = overlay.querySelector<HTMLInputElement>('input[placeholder="JSON value"]');
	if (valueInput === null) {
		throw new Error("the unknown-key value input did not render");
	}
	fireInput(valueInput, "true");
	expect(root.textContent).toContain('"supports_pdf_input" is not a known capability field');
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages.length).toBe(1);
});

test("switching a row's key onto a support flag seeds it true and renders the checkbox", () => {
	const root = mountSection([makeDeclaredServer({ label: "Prod" })]);
	fireClick(buttonByText(root, "Edit"));
	fireClick(buttonByText(root, "Add capability matcher"));
	const overlay = root.querySelector<HTMLElement>(".matcher-editor");
	if (overlay === null) {
		throw new Error("Add capability matcher did not open the overlay");
	}
	fireClick(buttonByText(overlay, "Add capability"));
	const keyInput = overlay.querySelector<HTMLInputElement>('input[placeholder^="Capability"]');
	if (keyInput === null) {
		throw new Error("the capability rows did not render");
	}
	fireInput(keyInput, "supports_vision");
	const flag = overlay.querySelector("label.capability-flag input") as HTMLInputElement;
	expect(flag?.checked).toBe(true);
});

test("fallback checkbox: marking a capability row through its chip popover saves the explicit _fallback list", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: { "gpt-4": { context_length: 128000 } },
			},
		}),
	]);
	fireClick(buttonByText(root, "Edit"));

	fireClick(chipFor(root, "context_length"));
	const box = root.querySelector<HTMLInputElement>(`.chip-popover input[aria-label='Fall back for "context_length"']`);
	if (box === null) {
		throw new Error("the fallback checkbox did not render");
	}
	expect(box.checked).toBe(false);
	expect(box.disabled).toBe(false);
	fireCheck(box, true);

	fireClick(buttonByText(root, "Save"));
	expect(postedMessages.length).toBe(1);
	const saved = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "saveServerSetting" }>;
	expect(saved.server.modelCapabilities).toEqual({
		"gpt-4": { context_length: 128000, _fallback: ["context_length"] },
	});
});

test("fallback checkbox: a support-flag row carries its own box beside the value checkbox in the overlay", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: { "gpt-4": { supports_vision: true } },
			},
		}),
	]);
	fireClick(buttonByText(root, "Edit"));
	const overlay = openMatcherEditor(root, "gpt-4");

	// The row renders the boolean value control (label.capability-flag); the
	// fallback mark is the separate .directive-flag box.
	const valueBox = overlay.querySelector<HTMLInputElement>("label.capability-flag input");
	expect(valueBox?.checked).toBe(true);
	const fallbackBox = overlay.querySelector<HTMLInputElement>(".directive-flag input");
	if (fallbackBox === null) {
		throw new Error("the fallback checkbox did not render");
	}
	expect(fallbackBox.getAttribute("aria-label")).toBe('Fall back for "supports_vision"');
	fireCheck(fallbackBox, true);

	fireClick(buttonByText(root, "Save"));
	const saved = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "saveServerSetting" }>;
	expect(saved.server.modelCapabilities).toEqual({
		"gpt-4": { supports_vision: true, _fallback: ["supports_vision"] },
	});
});

test("fallback checkbox: a hand-written _fallback true loads checked and saves unrewritten", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: { "gpt-4": { context_length: 128000, _fallback: true } },
			},
		}),
	]);
	fireClick(buttonByText(root, "Edit"));

	// The chip badge and the popover checkbox both read the literal true.
	fireClick(chipFor(root, "context_length"));
	const box = root.querySelector<HTMLInputElement>(`.chip-popover input[aria-label='Fall back for "context_length"']`);
	expect(box?.checked).toBe(true);

	// Saving without touching the mark keeps the user's literal true.
	fireClick(buttonByText(root, "Save"));
	const saved = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "saveServerSetting" }>;
	expect(saved.server.modelCapabilities).toEqual({ "gpt-4": { context_length: 128000, _fallback: true } });
});

test("an expected failure renders the warn pill, the declared-count badge, and the warn banner, never the red one", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Gateway",
			state: "error",
			error: "404 on /models",
			expected: true,
			declaredModelCount: 2,
			modelCount: 2,
		}),
	]);
	// Serving declared models reads Connected (one state, one name across
	// tabs), in the warn tone that says the connection is not what it seems.
	const pill = [...root.querySelectorAll("td .pill")].find((el) => el.textContent?.includes("Connected"));
	expect(pill).toBeDefined();
	expect(pill?.classList.contains("tone-warn")).toBe(true);
	const badge = [...root.querySelectorAll("span.badge")].find((el) => el.textContent?.includes("2 declared models"));
	expect(badge).toBeDefined();
	expect(root.querySelector(".banner-error")).toBeNull();
	const warn = root.querySelector(".banner-warn");
	expect(warn?.textContent).toContain("Gateway: 404 on /models (expected)");
});

test("an expected failure with nothing declared raises the capabilities-and-declare guidance banners", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Gateway",
			state: "error",
			error: "404 on /models",
			expected: true,
			notices: ["expected-failures-nothing-declared"],
		}),
	]);
	const banners = [...root.querySelectorAll(".banner-warn")].map((el) => el.textContent ?? "");
	expect(banners.some((text) => text.includes("nothing is declared"))).toBe(true);
	expect(banners.some((text) => text.includes("discovery.declared"))).toBe(true);
});

test("the capabilities-inactive notice renders its own badge and joins the one merged remedy banner", () => {
	const root = mountSection([
		makeDeclaredServer({ label: "Prod", notices: ["entry-params-inactive", "entry-capabilities-inactive"] }),
	]);
	const badges = [...root.querySelectorAll("span.badge.state-warn")].map((el) => el.textContent?.trim());
	expect(badges).toContain("params inactive");
	expect(badges).toContain("capabilities inactive");
	// One banner for every inactive entry-only surface: the surfaces list, then
	// the shared cause-and-fix sentence.
	const banners = [...root.querySelectorAll(".banner-warn")].map((el) => el.textContent ?? "");
	expect(banners.length).toBe(1);
	const banner = banners[0] ?? "";
	expect(banner).toContain("Prod: per-server model parameters");
	expect(banner).toContain("per-server model capabilities, declared models, and expected failures");
	expect(banner).toContain("are not applied");
});

test("editing a capability row or an expected-failure checkbox clears a standing test result", () => {
	const root = mountSection([makeDeclaredServer({ label: "Prod" })]);
	fireClick(buttonByText(root, "Edit"));
	fireClick(buttonByText(root, "Test connection"));
	const probe = postedMessages.at(-1) as Extract<WebviewToExtensionMessage, { type: "testServerDraft" }>;
	expect(probe.type).toBe("testServerDraft");
	// The in-flight state is visible; a capability edit abandons the probe,
	// because its outcome (declared count, expected downgrade) depends on it.
	expect(root.textContent).toContain("Testing...");
	fireClick(buttonByText(root, "Add capability matcher"));
	const prefixInput = root.querySelector<HTMLInputElement>('input[placeholder^="Model ID or matcher"]');
	if (prefixInput === null) {
		throw new Error("the capability rows did not render");
	}
	fireInput(prefixInput, "gpt");
	expect(root.textContent).not.toContain("Testing...");
});

test("a problem opens its collapsed disclosure once; re-closing sticks even as other problems come and go", () => {
	const root = mountSection([makeDeclaredServer({ label: "Prod" })]);
	fireClick(buttonByText(root, "Edit"));
	const detailsBySummary = (text: string) =>
		[...root.querySelectorAll("details")].find((candidate) =>
			candidate.querySelector("summary")?.textContent?.includes(text)
		) as HTMLDetailsElement;
	const collapse = (details: HTMLDetailsElement) => {
		void act(() => {
			details.open = false;
			details.dispatchEvent(new Event("toggle"));
		});
	};

	// A header problem surfaces inside the collapsed headers disclosure: it
	// opens once so Save cannot refuse over an invisible error.
	fireClick(buttonByText(root, "Add header"));
	fireInput(root.querySelector("input[aria-label='Header name']") as HTMLInputElement, "bad name");
	expect(detailsBySummary("Custom headers").open).toBe(true);

	// The user closes it again; that sticks.
	collapse(detailsBySummary("Custom headers"));
	expect(detailsBySummary("Custom headers").open).toBe(false);

	// A NEW problem elsewhere opens only its own disclosure; the deliberately
	// closed one must not snap back open just because the problem set changed.
	// The matcher rows are built in the overlay the add action opens.
	fireClick(buttonByText(root, "Add model matcher"));
	const overlay = root.querySelector<HTMLElement>(".matcher-editor");
	if (overlay === null) {
		throw new Error("Add model matcher did not open the overlay");
	}
	fireInput(overlay.querySelector("input.key") as HTMLInputElement, "gpt-4");
	fireClick(buttonByText(overlay, "Add parameter"));
	fireInput([...overlay.querySelectorAll("input.key")].at(-1) as HTMLInputElement, "temperature");
	fireInput(overlay.querySelector("input.value") as HTMLInputElement, "not json");
	expect(detailsBySummary("Model parameters for this server").open).toBe(true);
	expect(detailsBySummary("Custom headers").open).toBe(false);
});

test("add matcher then cancel is a no-op: the pristine sweep leaves the form clean, no discard confirm", () => {
	const root = mountSection([makeDeclaredServer({ label: "Prod" })]);
	fireClick(buttonByText(root, "Edit"));

	fireClick(buttonByText(root, "Add model matcher"));
	const overlay = root.querySelector<HTMLElement>(".matcher-editor");
	if (overlay === null) {
		throw new Error("Add model matcher did not open the overlay");
	}
	fireClick(buttonByText(overlay, "Done"));
	// The pristine group is swept; nothing counts as a user edit, so Cancel
	// closes directly instead of raising the discard confirm over a no-op.
	expect(root.querySelector(".record-table")).toBeNull();
	fireClick(buttonByText(root, "Cancel"));
	expect(root.textContent).not.toContain("Discard unsaved changes?");
	expect(root.querySelector(".form-card")).toBeNull();
});

test("the usage column shows the spend percentage with the Usage tab's severity tone", () => {
	const server = makeDeclaredServer({ label: "Prod", baseUrl: "http://localhost:4000" });
	const root = mount(<App />);
	const usageFor = (spentFraction: number) =>
		makeUsage({
			servers: [makeUsageServer({ label: "Prod", baseUrl: "http://localhost:4000", spend: 21, spentFraction })],
		});

	pushToWebview(statePush(makeState({ servers: [server], usage: usageFor(0.42) })));
	const cell = () => root.querySelector("table.servers .usage-cell") as HTMLElement;
	expect(cell().textContent).toBe("42%");
	expect(cell().classList.contains("tone-ok")).toBe(true);

	// Reaching a threshold counts as crossing it, exactly as the Usage tab
	// colors its percentage (the fixture thresholds are 0.8 and 0.95).
	pushToWebview(statePush(makeState({ servers: [server], usage: usageFor(0.8) })));
	expect(cell().textContent).toBe("80%");
	expect(cell().classList.contains("tone-warn")).toBe(true);

	// Over budget shows the literal percentage in the error tone.
	pushToWebview(statePush(makeState({ servers: [server], usage: usageFor(1.12) })));
	expect(cell().textContent).toBe("112%");
	expect(cell().classList.contains("tone-error")).toBe(true);
});

test("spend without a budget renders as the plain amount, never a percentage", () => {
	const usage = makeUsage({
		servers: [
			makeUsageServer({
				label: "Prod",
				baseUrl: "http://localhost:4000",
				spend: 3.07,
				effectiveBudget: undefined,
				keyBudget: undefined,
				budgetSource: "none",
				spentFraction: undefined,
			}),
		],
	});
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()], usage })));
	const cell = root.querySelector("table.servers .usage-cell") as HTMLElement;
	expect(cell.textContent).toBe("$3.07");
	expect(cell.className).toBe("usage-cell");
});

test("a server without usage data gets an empty usage cell, not an unknown marker", () => {
	// The usage snapshot tracks a different entry (usage joins by the store's
	// label key), so this row has no numbers to show - and says nothing.
	const usage = makeUsage({
		servers: [makeUsageServer({ label: "Other", baseUrl: "http://other.example:4000" })],
	});
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()], usage })));
	const headers = [...root.querySelectorAll("table.servers thead th")].map((th) => th.textContent?.trim());
	expect(headers).toContain("Usage");
	const row = root.querySelector("table.servers tbody tr") as HTMLElement;
	const usageCell = row.querySelectorAll("td")[4] as HTMLElement;
	expect(usageCell.textContent).toBe("");
	expect(root.textContent).not.toContain("unknown");
});

test("a forbidden-usage card leaves its server row's usage cell empty", () => {
	// The reduced forbidden card carries no numbers, so the servers-table join
	// skips it: the row renders an empty cell and the Usage tab tells the story.
	const usage = makeUsage({
		servers: [makeForbiddenUsageServer({ label: "Prod", baseUrl: "http://localhost:4000" })],
	});
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })], usage })));
	const row = root.querySelector("table.servers tbody tr") as HTMLElement;
	const usageCell = row.querySelectorAll("td")[4] as HTMLElement;
	expect(usageCell.textContent).toBe("");
	expect(usageCell.querySelector(".usage-cell")).toBeNull();
});
