/**
 * ServersSection behavior: toolbar command wiring, the two-step remove, the
 * add-form save round trip with requestId correlation, and the adopt intent's
 * exact payload (exhaustive key inspection: a credential-shaped field smuggled
 * into adoptServer must fail here).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DashboardServer, WebviewToExtensionMessage } from "../../../extension/dashboard/protocol";
import { App } from "../../../webview/dashboard/app";
import { HELP_ENTRY_MODEL_PARAMETER_PREFIX } from "../../../webview/dashboard/helpText";
import { ServersSection } from "../../../webview/dashboard/servers";
import { makeDeclaredServer, makeExternalServer, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireBlur,
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

test("the toolbar renders only once a server exists, and its buttons post their executeCommand ids", () => {
	// First run: the guided card is the only affordance, no strip of dead
	// controls above it.
	const empty = mountSection([]);
	expect(empty.querySelector(".toolbar")).toBeNull();

	// Test connection and the diagnostics view live on the Diagnostics tab;
	// the toolbar keeps only the server-editing entry points.
	const populated = mountSection([makeDeclaredServer()]);
	fireClick(buttonByText(populated, "Open native editor"));
	expect(postedMessages).toEqual([{ type: "executeCommand", command: "manageServers" }]);
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
	expect(saved.server).toEqual({ label: "Prod", baseUrl: "http://localhost:4000" });

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

test("the hide ack raises the guidance notice naming the group, with the native-editor action", () => {
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
	// The notice names the exact group and gives the steps: the native editor
	// is where real deletion lives.
	expect(notice?.textContent).toContain('"Copilot"');
	expect(notice?.textContent).toContain("Manage Language Models");
	expect(notice?.textContent).toContain("Sync models");

	resetPosted();
	const openButton = [...(notice?.querySelectorAll("button") ?? [])].find(
		(el) => el.textContent?.trim() === "Open native editor"
	);
	fireClick(openButton as HTMLElement);
	expect(postedMessages).toEqual([{ type: "executeCommand", command: "manageServers" }]);

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
	const removedTip = tips.find((tip) => tip.includes('"Old" was removed'));
	expect(removedTip).toContain("Left behind");
	const renamedTip = tips.find((tip) => tip.includes('renamed to "Fresh"'));
	expect(renamedTip).toContain("Left behind");
	const defaultTip = tips.find((tip) => tip.includes("predates"));
	expect(defaultTip).toContain("native Manage Language Models editor");
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
