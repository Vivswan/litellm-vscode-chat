/**
 * ServersSection behavior: toolbar command wiring, the two-step remove, the
 * add-form save round trip with requestId correlation, and the adopt intent's
 * exact payload (exhaustive key inspection: a credential-shaped field smuggled
 * into adoptServer must fail here).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { RpcRequest } from "../../../../dashboard/endpoints";
import type { DashboardServer } from "../../../../dashboard/viewModels";
import { App } from "../../../../webview/dashboard/app";
import { DOCS_LINK_CHECK_BASE_URL, DOCS_LINK_PROXY_NOT_RUNNING } from "../../../../webview/dashboard/docsLinks";
import { helpEntryModelParameterPrefix } from "../../../../webview/dashboard/helpText";
import type { ServerEditRequest } from "../../../../webview/dashboard/serverEditPage";
import { ServerEditPage } from "../../../../webview/dashboard/serverEditPage";
import { ServersSection } from "../../../../webview/dashboard/servers";
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
	fireFocus,
	fireInput,
	fireKeyDown,
	fireSelect,
	inputByLabel,
	lastRequest,
	mount,
	postedCalls,
	postedMessages,
	pushToWebview,
	render,
	resetPosted,
} from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

/**
 * The section alone, with the shell's callbacks stubbed: what the list does
 * with a row, not where the edit destination opens. Tests that need the
 * destination mount the real shell through mountShell below, so nothing here
 * re-implements App's navigation policy and then tests the re-implementation.
 */
function mountSection(servers: readonly DashboardServer[]) {
	return mount(
		<ServersSection
			servers={servers}
			now={Date.now()}
			onEditServer={() => {}}
			onAdoptServer={() => {}}
			onAddServer={() => {}}
		/>
	);
}

test("a server row keeps the four-part shape the narrow stylesheet folds", () => {
	// Every narrow rule keys off this structure: four direct children of
	// .server-row, with the second line's members inside .server-meta, which is
	// `display: contents` at full width and a flex line once the row folds. Move
	// a badge out of the meta wrapper, or rename a part, and the fold silently
	// stops working at every width - with this suite still green, because
	// happy-dom has no cascade and no layout to notice. Nothing else can catch
	// it short of a human looking at a render.
	const root = mountSection([makeDeclaredServer({ label: "Prod", modelCount: 2 })]);
	const row = root.querySelector(".server-row");
	expect(row).not.toBeNull();
	expect(Array.from(row?.children ?? []).map((child) => child.className.split(" ")[0])).toEqual([
		"server-name",
		"server-status",
		"server-meta",
		"server-actions",
	]);
	const meta = row?.querySelector(".server-meta");
	expect(meta?.querySelector(".server-url")).not.toBeNull();
	expect(meta?.querySelector(".server-count")).not.toBeNull();
	expect(meta?.querySelector(".server-usage")).not.toBeNull();
	expect(meta?.querySelector(".server-badges")).not.toBeNull();
});

test("a row's URL keeps its exact configured text, with only the https scheme marked for hiding", () => {
	// The narrow row stops PAINTING "https://" so the ellipsis cannot eat the
	// host, and the way it does that has to leave the row's text alone: what a
	// screen reader announces, what a copy of the line yields and what a
	// find-in-page matches must all still be the URL the setting holds. So the
	// scheme is a marked span rather than a removed substring - and http:// is
	// never marked, because plaintext to a proxy holding an API key is worth a
	// reader's attention at every width.
	const root = mountSection([
		makeDeclaredServer({ label: "Secure", baseUrl: "https://litellm.example.com" }),
		makeDeclaredServer({ label: "Plain", baseUrl: "http://localhost:4000" }),
		makeDeclaredServer({ label: "Half-typed", baseUrl: "https://" }),
		makeDeclaredServer({ label: "Shouty", baseUrl: "HTTPS://loud.example.com" }),
	]);
	const urls = Array.from(root.querySelectorAll(".server-url"));
	expect(urls.map((url) => (url.textContent ?? "").trim())).toEqual([
		"https://litellm.example.com",
		"http://localhost:4000",
		"https://",
		// The row prints the scheme the setting holds, not a normalized copy of
		// it: the match is case-insensitive so an uppercase scheme is hidden with
		// the rest, but hiding is all it does.
		"HTTPS://loud.example.com",
	]);
	expect(urls[0]?.querySelector(".url-scheme.quiet")?.textContent).toBe("https://");
	expect(urls[1]?.querySelector(".url-scheme")).toBe(null);
	// A scheme with nothing after it is the whole value, so it stays painted:
	// marked quiet it would render as an empty space at narrow, which is the
	// width at which being told the entry is half-typed matters most.
	expect(urls[2]?.querySelector(".url-scheme.quiet")).toBe(null);
	expect(urls[3]?.querySelector(".url-scheme.quiet")?.textContent).toBe("HTTPS://");
});

/**
 * The edit destination alone, on the entry a test is about. Most form tests
 * are about the form, not about the shell that hosts it: mounting the whole
 * dashboard for them makes every query ambiguous (the diagnostics panel has
 * its own "Test connection", the settings surface its own matcher editors)
 * and tests the shell's wiring by accident. The tests that ARE about the
 * shell - the pane swap, the navigation guard, focus on the way out - mount
 * it through mountShell below.
 */
function mountEditPage(
	servers: readonly DashboardServer[],
	request: ServerEditRequest = { kind: "edit", label: servers[0]?.label ?? "" },
	handlers: Partial<{
		onDirtyChange: (dirty: boolean) => void;
		onRequestClose: () => void;
		onSaved: () => void;
	}> = {}
): HTMLElement {
	return mount(
		<ServerEditPage
			request={request}
			servers={servers}
			onDirtyChange={handlers.onDirtyChange ?? (() => {})}
			onRequestClose={handlers.onRequestClose ?? (() => {})}
			onSaved={handlers.onSaved ?? (() => {})}
		/>
	);
}

/** The whole shell over one pushed fleet: the route every edit-destination test takes. */
function mountShell(servers: readonly DashboardServer[]): HTMLElement {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers })));
	// The shell's own ready handshake is not what any of these tests are
	// about; clearing it here keeps every posted-message assertion reading as
	// "what this interaction sent".
	resetPosted();
	return root;
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
	const root = mountShell([]);
	const start = root.querySelector(".empty-start");
	expect(start).not.toBeNull();
	expect(start?.querySelector("h3")?.textContent).toBe("Connect LiteLLM to Copilot Chat");
	// Three concrete steps, no bare table.
	expect(start?.querySelectorAll("ol li").length).toBe(3);
	expect(root.querySelector("table.servers")).toBeNull();

	fireClick(buttonByText(root, "Add your first server"));
	expect(root.querySelector(".form-card")).not.toBeNull();
});

test("a noticed entry states its inactive surfaces under its own row, not in a shared banner", () => {
	const root = mountSection([
		makeDeclaredServer({ label: "Prod", notices: ["entry-params-inactive"] }),
		makeDeclaredServer({ label: "Quiet", baseUrl: "http://quiet.test" }),
	]);

	// One line, under the row it belongs to. The badge and the merged banner
	// were two renderings of one fact sitting on the same screen; this is the
	// one that does not make the reader match a label back to a row.
	const lines = [...root.querySelectorAll(".row-diagnostic")];
	expect(lines.length).toBe(1);
	const line = lines[0] as HTMLElement;
	expect(line.textContent).toContain("Prod");
	expect(line.textContent).not.toContain("Quiet");
	expect(line.textContent).toContain("per-server model parameters");
	// Degraded, not advisory: the server answers, but it is running WITHOUT
	// settings the user wrote. Advisory would also have kept this row out of the
	// summary count, telling a reader whose parameters are being ignored that
	// nothing needs attention.
	expect(line.classList.contains("sev-degraded")).toBe(true);
	expect(root.querySelector(".server-summary")?.textContent).toContain("1 server needs attention");
	// The remedy the retired banner spelled out survives on the line.
	expect(line.textContent).toContain("chatLanguageModels.json");
	expect(line.textContent).toContain("under a new label");
	// Reveal, never rewrite: both actions open the place a human fixes it.
	const actions = [...line.querySelectorAll(".row-diagnostic-actions button, .row-diagnostic-actions a")].map((el) =>
		el.textContent?.trim()
	);
	expect(actions).toEqual(["Open models file", "Learn more"]);
});

test("without a notice a healthy row carries no diagnostic line at all", () => {
	const root = mountSection([makeDeclaredServer()]);
	expect(root.querySelector(".row-diagnostic")).toBeNull();
	// And no summary line: a permanent "0 problems" is furniture.
	expect(root.querySelector(".server-summary")).toBeNull();
});

test("the edit form round-trips per-entry model parameters into the save intent", () => {
	const root = mountEditPage([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelParameters: { "gpt-4": { temperature: 0.2 } },
			},
		}),
	]);

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
	// The matcher help rides the MATCHER section label since the overlay
	// redesign (labels above inputs), not the input's own cell.
	const glyph = prefixInput.closest(".editor-section")?.querySelector("button.help");
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
	const saved = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(saved.method).toBe("saveServerSetting");
	expect(saved.payload.replaceLabel).toBe("Prod");
	expect(saved.payload.server.modelParameters).toEqual({ "gpt-4": { temperature: 0.9 } });
});

test("blur alone paints no problem on an empty field, and blurring content is what makes a touch stick", () => {
	// The touch guard: brushing focus past a pristine empty field (toward
	// Cancel, say) must not repaint the form mid-click - an inserted error
	// line would move the buttons under the pointer.
	const root = mountEditPage([], { kind: "add" });
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
	const root = mountEditPage([], { kind: "add" });

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
	const first = postedMessages[0] as RpcRequest<"removeServerSetting">;
	expect(first.method).toBe("removeServerSetting");
	expect(first.payload.label).toBe("Prod");
	expect(typeof first.id).toBe("string");
	expect(first.id.length).toBeGreaterThan(0);

	// A second confirmation carries a fresh correlation ID.
	fireClick(buttonByText(root, "Remove"));
	fireClick(buttonByText(root, "Confirm remove?"));
	const second = postedMessages[1] as RpcRequest<"removeServerSetting">;
	expect(second.id).not.toBe(first.id);
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
	const saved = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(saved.method).toBe("saveServerSetting");
	// The entry-record fields ride every save, even empty: absent is
	// reserved for payloads that predate their editors (the save carries the
	// stored values forward for those instead of deleting them).
	expect(saved.payload.server).toEqual({
		label: "Prod",
		baseUrl: "http://localhost:4000",
		modelCapabilities: {},
		expectedFailures: [],
		headers: {},
		declaredModels: [],
		budget: null,
	});

	// An ack for some other intent must not close it.
	pushToWebview({ kind: "ack", id: "someone-elses", method: "saveServerSetting" });
	expect(root.querySelector(".form-card")).not.toBeNull();
	pushToWebview({ kind: "ack", id: saved.id, method: "saveServerSetting" });
	expect(root.querySelector(".form-card")).toBeNull();

	// Validation-kind failure: the draft is still the truth, the form reopens for retry.
	fireClick(buttonByText(root, "Add your first server"));
	fireInput(inputByLabel(root, "Label"), "Second");
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4001");
	resetPosted();
	fireClick(buttonByText(root, "Save"));
	const retry = postedMessages[0] as RpcRequest<"saveServerSetting">;
	pushToWebview({
		kind: "fail",
		id: retry.id,
		method: "saveServerSetting",
		message: "label: reserved name",
		failureKind: "validation",
	});
	expect(root.querySelector(".form-card")).not.toBeNull();
	expect(buttonByText(root, "Save").disabled).toBe(false);
	expect(root.textContent).toContain("Label: reserved name");

	// Operation-kind failure: the write committed, the stale draft closes.
	resetPosted();
	fireClick(buttonByText(root, "Save"));
	const committed = postedMessages[0] as RpcRequest<"saveServerSetting">;
	pushToWebview({
		kind: "fail",
		id: committed.id,
		method: "saveServerSetting",
		message: "saved, but the group sync failed; run Sync Models Now",
		failureKind: "operation",
	});
	expect(root.querySelector(".form-card")).toBeNull();
	expect(root.textContent).toContain("saved, but the group sync failed");
});

/** The API version mode select; the flat page has no fold around it to open. */
function apiVersionControl(root: HTMLElement): { select: HTMLSelectElement } {
	const select = root.querySelector<HTMLSelectElement>("#server-apiVersion-mode");
	if (select === null) {
		throw new Error("no API version control in the form");
	}
	return { select };
}

test("the API version control is visible from the start on Auto, and the save intent carries no key", () => {
	const root = mountEditPage([], { kind: "add" });

	const { select } = apiVersionControl(root);
	expect(select.value).toBe("auto");

	fireInput(inputByLabel(root, "Label"), "Prod");
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");
	resetPosted();
	fireClick(buttonByText(root, "Save"));
	const saved = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(saved.method).toBe("saveServerSetting");
	expect("apiVersion" in saved.payload.server).toBe(false);
});

test("No version saves the empty-string override", () => {
	const root = mountEditPage([], { kind: "add" });
	fireInput(inputByLabel(root, "Label"), "Prod");
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");

	const { select } = apiVersionControl(root);
	fireSelect(select, "none");

	resetPosted();
	fireClick(buttonByText(root, "Save"));
	const saved = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(saved.payload.server.apiVersion).toBe("");
});

test("Custom reveals the segment input; the trimmed text rides the save and the connection test", () => {
	const root = mountEditPage([], { kind: "add" });
	fireInput(inputByLabel(root, "Label"), "Prod");
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");

	const { select } = apiVersionControl(root);
	expect(root.querySelector("#server-apiVersion")).toBeNull();
	fireSelect(select, "custom");
	fireInput(inputByLabel(root, "Version segment"), " v2 ");

	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const probed = postedMessages[0] as RpcRequest<"testServerDraft">;
	expect(probed.method).toBe("testServerDraft");
	expect(probed.payload.server.apiVersion).toBe("v2");

	resetPosted();
	fireClick(buttonByText(root, "Save"));
	const saved = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(saved.payload.server.apiVersion).toBe("v2");
});

test("Custom with no text blocks Save with the version-segment problem, in view without opening anything", () => {
	const root = mountEditPage([], { kind: "add" });
	fireInput(inputByLabel(root, "Label"), "Prod");
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");
	const { select } = apiVersionControl(root);
	fireSelect(select, "custom");

	resetPosted();
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages).toEqual([]);
	expect(root.textContent).toContain("Cannot save: fix API version");
	// The problem renders in the row's own hint column, reachable with no
	// gesture at all: the page has nothing that can hide a field.
	expect(root.querySelector("#server-apiVersion-error")?.textContent).toBe("Enter the version segment, e.g. v2");
	expect(root.querySelectorAll("details").length).toBe(0);
});

test("an entry's apiVersion prefills the matching mode", () => {
	const secrets = { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } as const;

	// "" prefills None.
	const noneRoot = mountShell([makeDeclaredServer({ label: "Bare", config: { secrets, apiVersion: "" } })]);
	fireClick(buttonByText(noneRoot, "Edit"));
	const none = apiVersionControl(noneRoot);
	expect(none.select.value).toBe("none");

	// Text prefills Custom with the input filled.
	const customRoot = mountShell([makeDeclaredServer({ label: "V2", config: { secrets, apiVersion: "v2" } })]);
	fireClick(buttonByText(customRoot, "Edit"));
	const custom = apiVersionControl(customRoot);
	expect(custom.select.value).toBe("custom");
	expect(inputByLabel(customRoot, "Version segment").value).toBe("v2");

	// Saving the prefilled entry round-trips the override unchanged.
	resetPosted();
	fireClick(buttonByText(customRoot, "Save"));
	const saved = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(saved.payload.server.apiVersion).toBe("v2");
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
	const posted = postedMessages[0] as RpcRequest<"adoptServer">;

	// Deep equality of the sorted key set: presence checks would pass if a
	// sixth, credential-bearing key were ever added to the intent.
	expect(Object.keys(posted).sort()).toEqual(["id", "kind", "method", "payload"]);
	expect(Object.keys(posted.payload).sort()).toEqual(["baseUrl", "label", "secrets", "sourceHandle"]);
	expect(posted.method).toBe("adoptServer");
	expect(posted.payload.label).toBe("Adopted Copilot");
	expect(posted.payload.baseUrl).toBe("http://copilot.example:4000");
	expect(posted.payload.sourceHandle).toBe(external.adoptHandle);
	expect(typeof posted.id).toBe("string");
	// The secrets record carries storage locations only, one per secret field.
	expect(posted.payload.secrets).toEqual({ apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" });
	expect(Object.keys(posted.payload.secrets).sort()).toEqual(["apiKey", "oauthClientSecret", "virtualKeyValue"]);
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
	const posted = postedMessages[0] as RpcRequest<"hideExternalServer">;
	// Exact key set: the intent names the group by its opaque handle and URL,
	// nothing more.
	expect(Object.keys(posted).sort()).toEqual(["id", "kind", "method", "payload"]);
	expect(Object.keys(posted.payload).sort()).toEqual(["baseUrl", "sourceHandle"]);
	expect(posted.method).toBe("hideExternalServer");
	expect(posted.payload.baseUrl).toBe("http://copilot.example:4000");
	expect(posted.payload.sourceHandle).toBe(external.adoptHandle);
	expect(typeof posted.id).toBe("string");
});

test("a non-hideable external row (legacy registry) offers Edit only, no Remove", () => {
	const root = mountShell([makeExternalServer({ hideable: false })]);
	const actions = [...root.querySelectorAll(".server-actions button")].map((el) => el.textContent?.trim());
	expect(actions).toEqual(["Edit"]);
});

test("the hide ack raises the guidance notice naming the group, with the models-file action", () => {
	const external = makeExternalServer({ label: "Copilot" });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [external] })));

	resetPosted();
	fireClick(buttonByText(root, "Remove"));
	fireClick(buttonByText(root, "Confirm remove?"));
	const posted = postedMessages[0] as RpcRequest<"hideExternalServer">;

	// A foreign ack does nothing; the intent's own ack raises the notice.
	pushToWebview({ kind: "ack", id: "someone-elses", method: "hideExternalServer" });
	expect(root.querySelector(".notice")).toBeNull();
	pushToWebview({ kind: "ack", id: posted.id, method: "hideExternalServer" });
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
	expect(postedCalls()).toEqual([{ method: "executeCommand", payload: { command: "openGroupsFile" } }]);

	fireClick(buttonByText(root, "Dismiss"));
	expect(root.querySelector(".notice")).toBeNull();
});

test("the hidden-groups line states the count, expands to rows, and Unhide posts the identity verbatim", () => {
	const root = mount(
		<ServersSection
			onEditServer={() => {}}
			onAdoptServer={() => {}}
			onAddServer={() => {}}
			servers={[makeDeclaredServer()]}
			hidden={[
				{ label: "Old", baseUrl: "http://old.test" },
				{ label: "Gone", baseUrl: "http://gone.test" },
			]}
			now={Date.now()}
		/>
	);

	const line = root.querySelector(".hidden-groups");
	expect(line).not.toBeNull();
	// One control saying the whole thing, rather than a count sentence with a
	// lowercase "show" fragment three words behind its own object.
	expect(line?.textContent).toContain("Show 2 hidden groups");
	// Collapsed by default: no Unhide until shown.
	expect(line?.textContent).not.toContain("Unhide");

	fireClick(buttonByText(root, "Show 2 hidden groups"));
	expect(buttonByText(root, "Hide")).not.toBeNull();
	expect(line?.textContent).toContain("Old");
	expect(line?.textContent).toContain("http://old.test");
	const unhide = [...root.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Unhide");
	fireClick(unhide as HTMLElement);
	expect(postedMessages.length).toBe(1);
	const posted = postedMessages[0] as RpcRequest<"unhideServer">;
	expect(posted.method).toBe("unhideServer");
	// The identity is echoed verbatim from the first listed row.
	expect(posted.payload.label).toBe("Old");
	expect(posted.payload.baseUrl).toBe("http://old.test");
	expect(typeof posted.id).toBe("string");
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
			onEditServer={() => {}}
			onAdoptServer={() => {}}
			onAddServer={() => {}}
		/>
	);
	expect(onlyHidden.querySelector(".empty-start")).not.toBeNull();
	expect(onlyHidden.querySelector(".hidden-groups")?.textContent).toContain("Show 1 hidden group");
});

test("the external badge tip renders the provenance classification, or the honest default", () => {
	const root = mountSection([
		makeExternalServer({
			label: "Old",
			baseUrl: "http://a.test",
			adoptHandle: "handle-old",
			provenance: { kind: "removed-entry-leftover", removedLabel: "Old" },
		}),
		makeExternalServer({
			label: "Renamed",
			baseUrl: "http://b.test",
			adoptHandle: "handle-renamed",
			provenance: { kind: "rename-leftover", oldLabel: "Renamed", newLabel: "Fresh" },
		}),
		makeExternalServer({ label: "Native", baseUrl: "http://c.test", adoptHandle: "handle-native" }),
	]);

	const tips = [...root.querySelectorAll("span[data-slot='badge']")]
		.filter((el) => el.textContent?.trim() === "external")
		.map((el) => el.closest(".tip-wrap")?.querySelector(".tip-bubble")?.textContent ?? "");
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
			onEditServer={() => {}}
			onAdoptServer={() => {}}
			onAddServer={() => {}}
			servers={[makeDeclaredServer({ label: "Prod", modelCount: 3 }), makeDeclaredServer({ label: "Empty" })]}
			now={Date.now()}
			onShowModels={(label) => labels.push(label)}
		/>
	);
	expect(root.querySelector("button[aria-label='Show models from Empty']")).toBeNull();
	fireClick(root.querySelector("button[aria-label='Show models from Prod']") as HTMLElement);
	expect(labels).toEqual(["Prod"]);
});

test("Test connection gates on the base URL alone, posts the draft's exact keys, and its own ack renders the result", () => {
	const root = mountEditPage([], { kind: "add" });

	// Unusable URL: the button is the only thing disabled; a savable label is
	// deliberately not required to probe.
	expect(buttonByText(root, "Test connection").disabled).toBe(true);
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");
	expect(buttonByText(root, "Test connection").disabled).toBe(false);

	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	expect(postedMessages.length).toBe(1);
	const posted = postedMessages[0] as RpcRequest<"testServerDraft">;
	// Exact key set, like the adopt test: a smuggled extra field must fail here.
	expect(Object.keys(posted).sort()).toEqual(["id", "kind", "method", "payload"]);
	expect(Object.keys(posted.payload).sort()).toEqual(["secrets", "server"]);
	expect(posted.method).toBe("testServerDraft");
	expect(posted.payload.server).toEqual({
		label: "",
		baseUrl: "http://localhost:4000",
		modelCapabilities: {},
		expectedFailures: [],
		headers: {},
		declaredModels: [],
		budget: null,
	});
	expect(posted.payload.secrets).toEqual({
		apiKey: { action: "keep" },
		oauthClientSecret: { action: "keep" },
		virtualKeyValue: { action: "keep" },
	});
	expect(typeof posted.id).toBe("string");

	// In flight: the button goes busy, Save and Cancel stay live.
	expect(buttonByText(root, "Testing...").disabled).toBe(true);
	expect(buttonByText(root, "Save").disabled).toBe(false);
	expect(buttonByText(root, "Discard changes").disabled).toBe(false);

	// A foreign ack changes nothing; the test's own ack renders the
	// extension-composed message verbatim, selectable in the footer.
	pushToWebview({
		kind: "ack",
		id: "someone-elses",
		method: "testServerDraft",
		message: "Connected - 9 models",
	});
	expect(root.textContent).toContain("Testing...");
	pushToWebview({
		kind: "ack",
		id: posted.id,
		method: "testServerDraft",
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
	const root = mountEditPage([], { kind: "add" });
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");

	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const posted = postedMessages[0] as RpcRequest<"testServerDraft">;
	pushToWebview({
		kind: "fail",
		id: posted.id,
		method: "testServerDraft",
		message: "the server answered 404",
		failureKind: "validation",
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
	const second = postedMessages[0] as RpcRequest<"testServerDraft">;
	pushToWebview({
		kind: "fail",
		id: second.id,
		method: "testServerDraft",
		message: "LiteLLM API error: 500",
		failureKind: "validation",
		classification: { kind: "http", status: 500 },
	});
	expect(root.querySelector(".test-result.error")?.textContent).toContain("LiteLLM API error: 500");
	expect(root.querySelector(".test-hint")).toBeNull();
});

test("classified refresh failures carry a Troubleshoot link on their own row; unclassified rows stay plain", () => {
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
	// One line per failing row, each naming its own server: nothing is joined
	// with semicolons any more, so nothing has to be matched back to a row.
	const lines = [...root.querySelectorAll(".row-diagnostic")];
	expect(lines.length).toBe(3);
	expect(lines[0]?.textContent).toContain("Prod");
	expect(lines[0]?.textContent).toContain("unable to connect");
	expect(lines[1]?.textContent).toContain("Quiet");
	expect(lines[1]?.querySelector("a.docs-link")).toBeNull();
	expect(lines[2]?.textContent).toContain("answered 404");

	// Two classified failures, two links, each targeting the
	// troubleshooting-guide section matching its own setup-hint id, with the
	// fuller per-cause accessible label - the same links the draft-test footer
	// renders.
	const anchors = [...root.querySelectorAll<HTMLAnchorElement>(".row-diagnostic a.docs-link")];
	expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual([
		DOCS_LINK_PROXY_NOT_RUNNING,
		DOCS_LINK_CHECK_BASE_URL,
	]);
	expect(anchors.map((anchor) => anchor.getAttribute("aria-label"))).toEqual([
		"Open the troubleshooting guide: unable to connect",
		"Open the troubleshooting guide: the server answered 404",
	]);
	// The VISIBLE text is the short verb - the long sentence is the accessible
	// name. Spreading the link helper over the label put that sentence on screen
	// once already, so it is pinned here.
	expect(anchors.map((anchor) => anchor.textContent?.trim())).toEqual(["Troubleshoot", "Troubleshoot"]);
});

test("without a classification a row's failure line is plain text, with no link", () => {
	const root = mountSection([
		makeDeclaredServer({ label: "Prod", state: "error", error: "boom" }),
		makeDeclaredServer({ label: "Beta", baseUrl: "http://beta.test", state: "error", error: "bang" }),
	]);
	const lines = [...root.querySelectorAll(".row-diagnostic")];
	expect(lines.length).toBe(2);
	expect(lines[0]?.textContent).toContain("boom");
	expect(lines[1]?.textContent).toContain("bang");
	// No link, and no wrapper element, appears for an unclassified failure.
	expect(root.querySelector(".row-diagnostic a.docs-link")).toBeNull();
});

test("a hintless classification renders no troubleshooting link", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Prod",
			state: "error",
			error: "LiteLLM API error: 500",
			classification: { kind: "http", status: 500 },
		}),
	]);
	expect(root.querySelector(".row-diagnostic")?.textContent).toContain("LiteLLM API error: 500");
	expect(root.querySelector(".row-diagnostic a.docs-link")).toBeNull();
});

test("a failed test renders its message inline and the result clears on any credential-affecting edit", () => {
	const root = mountEditPage([makeDeclaredServer({ label: "Prod" })]);
	// The entry has no credentials, so the form derives to None; the API-key
	// form is picked up front so the credential-edit steps below have their
	// input (the pick itself would clear a standing result too).
	const apiKeyOption = [...root.querySelectorAll(".auth-selector label")].find(
		(el) => (el.textContent ?? "").trim() === "API key (bearer)"
	);
	fireCheck(apiKeyOption?.querySelector("input") as HTMLInputElement, true);

	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const posted = postedMessages[0] as RpcRequest<"testServerDraft">;
	// Editing an entry: the intent addresses "keep" resolution at the original label.
	expect(posted.payload.replaceLabel).toBe("Prod");

	pushToWebview({
		kind: "fail",
		id: posted.id,
		method: "testServerDraft",
		message: "Network Error: unable to reach the server",
		failureKind: "validation",
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
	const second = postedMessages[0] as RpcRequest<"testServerDraft">;
	pushToWebview({
		kind: "ack",
		id: second.id,
		method: "testServerDraft",
		message: "Connected - 2 models",
	});
	expect(root.querySelector(".test-result")).not.toBeNull();
	fireInput(inputByLabel(root, "API key"), "sk-new");
	expect(root.querySelector(".test-result")).toBeNull();

	// Same for the base URL, from a fresh PASS.
	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const third = postedMessages[0] as RpcRequest<"testServerDraft">;
	expect(third.payload.secrets.apiKey).toEqual({ action: "set", location: "secure", value: "sk-new" });
	pushToWebview({
		kind: "ack",
		id: third.id,
		method: "testServerDraft",
		message: "Connected - 2 models",
	});
	expect(root.querySelector(".test-result")).not.toBeNull();
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4001");
	expect(root.querySelector(".test-result")).toBeNull();
});

test("an in-flight test is abandoned by a connection edit: the stale outcome is ignored", () => {
	const root = mountEditPage([], { kind: "add" });
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");

	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const posted = postedMessages[0] as RpcRequest<"testServerDraft">;
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4001");
	// The edit returned the button to idle and dropped the pending requestId...
	expect(root.textContent).not.toContain("Testing...");
	// ...so the late outcome for the old draft paints nothing.
	pushToWebview({
		kind: "ack",
		id: posted.id,
		method: "testServerDraft",
		message: "Connected - 3 models",
	});
	expect(root.querySelector(".test-result")).toBeNull();
});

test("Test with a partial OAuth draft posts nothing and surfaces the pairing problem like Save would", () => {
	const root = mountEditPage([], { kind: "add" });
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

test("a test in flight does not block leaving; the request goes up and the outcome lands nowhere", () => {
	const closes: number[] = [];
	const root = mountEditPage([], { kind: "add" }, { onRequestClose: () => closes.push(1) });
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");
	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const posted = postedMessages[0] as RpcRequest<"testServerDraft">;

	// A probe in flight gates nothing: the page still reports the reader's
	// request to leave, and the shell decides what it means.
	fireClick(buttonByText(root, "Discard changes"));
	expect(closes).toHaveLength(1);

	// The abandoned outcome must not throw or resurrect anything.
	// What happens to the abandoned outcome once the shell takes the page away
	// is the shell's test (app.test.tsx); here the page's own contract ends at
	// reporting the request.
	expect(posted.method).toBe("testServerDraft");
});

test("the edit form round-trips model capabilities and expected failures into the save intent", () => {
	const root = mountEditPage([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: { "my-model": { context_length: 128000, supports_vision: true } },
				expectedFailures: ["modelListing"],
			},
		}),
	]);

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
	const saved = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(saved.payload.server.modelCapabilities).toEqual({
		"my-model": { context_length: 200000, supports_vision: true },
	});
	expect(saved.payload.server.expectedFailures).toEqual(["modelListing", "modelInfo"]);
});

test("an unknown capability key gets a JSON input and no hint without observed evidence; the save still posts", () => {
	// The server never reported a /model/info key set: no evidence, so the
	// live draft mirrors the host's advisory filter and stays silent.
	const root = mountEditPage([makeDeclaredServer({ label: "Prod" })]);
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
	fireInput(keyInput, "supports_web_search");
	// An unknown key stays free-form JSON, not a checkbox (the open vocabulary
	// carries any JSON value).
	const valueInput = overlay.querySelector<HTMLInputElement>('input[placeholder="JSON value"]');
	if (valueInput === null) {
		throw new Error("the unknown-key value input did not render");
	}
	fireInput(valueInput, "true");
	expect(root.textContent).not.toContain("is not a field this extension knows");
	// Open fields take the fallback mark too: the resolver's _fallback accepts
	// any field the record sets.
	const fallbackBox = [...overlay.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
		(input) => input.getAttribute("aria-label") === 'Fall back for "supports_web_search"'
	);
	expect(fallbackBox).not.toBeUndefined();
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages.length).toBe(1);
});

test("an unknown capability key hints when the server's observed keys lack it, and the hint says it still applies", () => {
	const root = mountEditPage([
		makeDeclaredServer({ label: "Prod", observedModelInfoKeys: ["litellm_provider", "mode"] }),
	]);
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
	fireInput(keyInput, "supports_web_search");
	const valueInput = overlay.querySelector<HTMLInputElement>('input[placeholder="JSON value"]');
	if (valueInput === null) {
		throw new Error("the unknown-key value input did not render");
	}
	fireInput(valueInput, "true");
	expect(root.textContent).toContain('"supports_web_search" is not a field this extension knows');
	expect(root.textContent).toContain("applied as an override as-is");
	// An observed key is real whatever the vocabulary says: switching the row
	// onto one the server reported clears the hint.
	fireInput(keyInput, "mode");
	expect(root.textContent).not.toContain("is not a field this extension knows");
	// The hint never blocks the save either way.
	fireInput(keyInput, "supports_web_search");
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages.length).toBe(1);
});

test("a consumed capability key gets its typed input: costs a decimal number field, caching flags a checkbox", () => {
	const root = mountEditPage([makeDeclaredServer({ label: "Prod" })]);
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
	// A consumed boolean (supports_prompt_caching) renders the support-flag
	// checkbox and seeds true, exactly like a core flag.
	fireInput(keyInput, "supports_prompt_caching");
	const flag = overlay.querySelector<HTMLInputElement>("label.capability-flag input");
	expect(flag?.checked).toBe(true);
	// A cost key renders a number input allowing zero and decimals. The "true"
	// the flag key seeded does not fit a cost, so the row first keeps the raw
	// input showing it; clearing it flips the row onto the typed control.
	fireInput(keyInput, "input_cost_per_token");
	const carried = overlay.querySelector<HTMLInputElement>("input.value");
	if (carried === null) {
		throw new Error("the carried-value input did not render");
	}
	expect(carried.value).toBe("true");
	fireInput(carried, "");
	const costInput = overlay.querySelector<HTMLInputElement>('input[placeholder^="USD per token"]');
	if (costInput === null) {
		throw new Error("the cost value input did not render");
	}
	expect(costInput.type).toBe("number");
	expect(costInput.min).toBe("0");
	fireInput(costInput, "0");
	expect(root.textContent).not.toContain("this value is ignored");
	// Consumed fields carry the fallback mark like any other set field.
	expect(
		[...overlay.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
			(input) => input.getAttribute("aria-label") === 'Fall back for "input_cost_per_token"'
		)
	).not.toBeUndefined();
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages.length).toBe(1);
	const saved = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(saved.payload.server.modelCapabilities).toEqual({ "gpt-4": { input_cost_per_token: 0 } });
});

test("a discovery pass finishing under the open form refreshes the unknown-key hint evidence", () => {
	const pageWith = (servers: readonly DashboardServer[]) => (
		<ServerEditPage
			request={{ kind: "edit", label: "Prod" }}
			servers={servers}
			onDirtyChange={() => {}}
			onRequestClose={() => {}}
			onSaved={() => {}}
		/>
	);
	const root = mountEditPage([makeDeclaredServer({ label: "Prod" })]);
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
	fireInput(keyInput, "supports_web_search");
	const valueInput = overlay.querySelector<HTMLInputElement>('input[placeholder="JSON value"]');
	if (valueInput === null) {
		throw new Error("the unknown-key value input did not render");
	}
	fireInput(valueInput, "true");
	expect(root.textContent).not.toContain("is not a field this extension knows");
	// The state push that lands the discovery result re-renders the page with
	// the server's observed keys; the OPEN form's hints must follow the live
	// evidence, not the open-time snapshot.
	void act(() => {
		render(
			pageWith([makeDeclaredServer({ label: "Prod", observedModelInfoKeys: ["litellm_provider", "mode"] })]),
			root
		);
	});
	expect(root.textContent).toContain('"supports_web_search" is not a field this extension knows');
});

test("a preserved invalid consumed value keeps the raw JSON input instead of a typed control that would blank it", () => {
	const root = mountEditPage([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: { "gpt-4": { input_cost_per_token: "free", supports_prompt_caching: 1 } },
			},
		}),
	]);
	const overlay = openMatcherEditor(root, "gpt-4");
	// A number input would display the stored "free" as blank and a checkbox
	// would read the stored 1 as unchecked; the rows keep free-form inputs
	// showing the text as it is, with the non-blocking hints beside them.
	const values = [...overlay.querySelectorAll<HTMLInputElement>("input.value")];
	expect(values.map((input) => input.type)).toEqual(["text", "text"]);
	expect(values.map((input) => input.value)).toEqual(['"free"', "1"]);
	expect(overlay.querySelector("label.capability-flag")).toBeNull();
	expect(root.textContent).toContain("this value is ignored");
	// Fixing the cost flips the row back onto the typed number input.
	const costInput = values[0];
	if (costInput === undefined) {
		throw new Error("the cost row did not render");
	}
	fireInput(costInput, "0.000002");
	expect(overlay.querySelector<HTMLInputElement>('input[placeholder^="USD per token"]')?.value).toBe("0.000002");
	// The typed control takes exactly what an HTML number input can display:
	// scientific notation stays typed, while hex, a trailing dot, and padded
	// whitespace (all blanked by the control) keep the raw text input.
	const costValue = () => {
		const input = [...overlay.querySelectorAll<HTMLInputElement>("input.value")][0];
		if (input === undefined) {
			throw new Error("the cost row's value input did not render");
		}
		return input;
	};
	fireInput(costValue(), "1e5");
	expect(costValue().type).toBe("number");
	for (const text of ["0x10", "1.", " 1 "]) {
		fireInput(costValue(), text);
		expect(costValue().type).toBe("text");
		expect(costValue().value).toBe(text);
	}
});

test("switching a row's key onto a support flag seeds it true and renders the checkbox", () => {
	const root = mountEditPage([makeDeclaredServer({ label: "Prod" })]);
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
	const root = mountEditPage([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: { "gpt-4": { context_length: 128000 } },
			},
		}),
	]);

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
	const saved = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(saved.payload.server.modelCapabilities).toEqual({
		"gpt-4": { context_length: 128000, _fallback: ["context_length"] },
	});
});

test("fallback checkbox: a support-flag row carries its own box beside the value checkbox in the overlay", () => {
	const root = mountEditPage([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: { "gpt-4": { supports_vision: true } },
			},
		}),
	]);
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
	const saved = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(saved.payload.server.modelCapabilities).toEqual({
		"gpt-4": { supports_vision: true, _fallback: ["supports_vision"] },
	});
});

test("fallback checkbox: a hand-written _fallback true loads checked and saves unrewritten", () => {
	const root = mountEditPage([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: { "gpt-4": { context_length: 128000, _fallback: true } },
			},
		}),
	]);

	// The chip badge and the popover checkbox both read the literal true.
	fireClick(chipFor(root, "context_length"));
	const box = root.querySelector<HTMLInputElement>(`.chip-popover input[aria-label='Fall back for "context_length"']`);
	expect(box?.checked).toBe(true);

	// Saving without touching the mark keeps the user's literal true.
	fireClick(buttonByText(root, "Save"));
	const saved = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(saved.payload.server.modelCapabilities).toEqual({ "gpt-4": { context_length: 128000, _fallback: true } });
});

test("an expected failure serving declared models reads Connected, and states the count on its own line", () => {
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
	// Serving declared models reads Connected: one state, one name across tabs.
	const pill = [...root.querySelectorAll(".server-row .pill")].find((el) => el.textContent?.includes("Connected"));
	expect(pill).toBeDefined();
	// The dot follows the row's WORST diagnostic, and this row's worst is
	// advisory - the entry declared this failure category and is serving through
	// it, so nothing is wrong. An amber dot over a grey advisory line was the
	// pill and the sentence beneath it disagreeing in public.
	expect(pill?.classList.contains("tone-ok")).toBe(true);
	// The declared count is stated by the row's own line rather than by a badge
	// beside it: the badge and the banner were the same fact twice.
	const line = root.querySelector(".row-diagnostic");
	expect(line?.textContent).toContain("2 declared models");
	expect(line?.textContent).toContain("Gateway");
	// The entry declared this failure category and is serving through it, so
	// nothing is wrong: quiet tier, and never the blocking one.
	expect(line?.classList.contains("sev-advisory")).toBe(true);
	expect(root.querySelector(".row-diagnostic.sev-blocking")).toBeNull();
	// It still says what the server said, for the reader who wants the cause.
	expect(line?.textContent).toContain("404 on /models");
});

test("an expected failure with nothing declared reads blocking and offers Declare models", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Gateway",
			state: "error",
			error: "404 on /models",
			expected: true,
			notices: ["expected-failures-nothing-declared"],
		}),
	]);
	// Serving nothing at all is the definition of blocking. The entry expecting
	// this failure category makes the CAUSE unsurprising; it does not put any
	// models in the picker, and the tier is a promise about whether someone has
	// to act rather than a volume knob.
	const line = root.querySelector(".row-diagnostic");
	expect(line?.classList.contains("sev-blocking")).toBe(true);
	expect(line?.textContent).toContain("nothing is declared");
	const actions = [...(line?.querySelectorAll(".row-diagnostic-actions button") ?? [])].map((el) =>
		el.textContent?.trim()
	);
	expect(actions).toContain("Declare models");
	expect(actions).toContain("Retry");
});

test("an unserved model-info probe raises the quiet declare hint; the two-step confirm posts declareExpectedFailure", () => {
	const root = mountSection([makeDeclaredServer({ label: "Ollama", modelCount: 3, modelInfoUnsupported: "timeout" })]);

	// The models serve and the configuration applies as written, so this is the
	// quiet tier - and stays out of the needs-attention count.
	const line = root.querySelector(".row-diagnostic");
	expect(line?.classList.contains("sev-advisory")).toBe(true);
	expect(line?.textContent).toContain("model-info probe never answers");
	expect(line?.textContent).toContain('"expectedFailures": ["modelInfo"]');
	expect(root.textContent).not.toContain("needs attention");

	// Arm, then cancel: nothing posted, the plain button returns.
	fireClick(buttonByText(root, "Declare expected failure"));
	expect(root.textContent).toContain("Confirm declaration?");
	fireClick(buttonByText(root, "Cancel"));
	expect(postedMessages).toEqual([]);
	expect(root.textContent).not.toContain("Confirm declaration?");

	// Arm and confirm: exactly one declareExpectedFailure naming the entry and
	// the modelInfo category - the closed vocabulary, nothing free-typed.
	fireClick(buttonByText(root, "Declare expected failure"));
	fireClick(buttonByText(root, "Confirm declaration?"));
	expect(postedMessages.length).toBe(1);
	const posted = postedMessages[0] as RpcRequest<"declareExpectedFailure">;
	expect(posted.method).toBe("declareExpectedFailure");
	expect(posted.payload).toEqual({ label: "Ollama", category: "modelInfo" });

	// In flight the pair stays and states that it is working; Cancel refuses
	// too, because the posted write cannot be cancelled - it only ever disarms.
	expect(root.textContent).toContain("Declaring...");
	expect(buttonByText(root, "Cancel").getAttribute("aria-disabled")).toBe("true");
});

test("the status-evidence hint names the missing endpoint rather than a wait", () => {
	const root = mountSection([makeDeclaredServer({ label: "Ollama", modelInfoUnsupported: "status" })]);
	const line = root.querySelector(".row-diagnostic");
	expect(line?.textContent).toContain("without LiteLLM's model-info endpoint");
	expect(line?.textContent).toContain('"expectedFailures": ["modelInfo"]');
});

test("no declare hint on a row whose entry fields are inactive: the declaration could not reach the group", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Ollama",
			modelInfoUnsupported: "timeout",
			notices: ["entry-capabilities-inactive"],
		}),
	]);
	expect(root.textContent).not.toContain("Declare expected failure");
	// The entry-inactive line still owns the row's fix.
	expect(root.querySelector(".row-diagnostic")?.textContent).toContain("ignores its");
});

test("a models-listing-unserved error offers the declare action writing modelListing", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Gateway",
			state: "error",
			error: "The models listing failed, but this server answers",
			classification: { kind: "http", status: 404, unsupportedEndpoint: "modelListing" },
		}),
	]);
	fireClick(buttonByText(root, "Declare expected failure"));
	fireClick(buttonByText(root, "Confirm declaration?"));
	expect(postedMessages.length).toBe(1);
	const posted = postedMessages[0] as RpcRequest<"declareExpectedFailure">;
	expect(posted.payload).toEqual({ label: "Gateway", category: "modelListing" });
});

test("a discovery error without the endpoint classification offers no declare action", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Gateway",
			state: "error",
			error: "boom",
			classification: { kind: "http", status: 500 },
		}),
	]);
	expect(root.textContent).not.toContain("Declare expected failure");
});

test("several inactive surfaces on one row share a single line naming them all", () => {
	const root = mountSection([
		makeDeclaredServer({ label: "Prod", notices: ["entry-params-inactive", "entry-capabilities-inactive"] }),
	]);
	// One line for every inactive surface on the row, not one per surface: the
	// cause and the fix are identical, so twins would only repeat themselves.
	const lines = [...root.querySelectorAll(".row-diagnostic")];
	expect(lines.length).toBe(1);
	const line = lines[0]?.textContent ?? "";
	expect(line).toContain("Prod");
	expect(line).toContain("per-server model parameters");
	expect(line).toContain("per-server model capabilities, declared models, and expected failures");
});

test("the api-version-inactive notice names its surface on the row it belongs to", () => {
	const root = mountSection([makeDeclaredServer({ label: "Prod", notices: ["entry-api-version-inactive"] })]);
	const lines = [...root.querySelectorAll(".row-diagnostic")];
	expect(lines.length).toBe(1);
	expect(lines[0]?.textContent).toContain("Prod");
	expect(lines[0]?.textContent).toContain("per-server API version overrides");
});

test("editing a capability row or an expected-failure checkbox clears a standing test result", () => {
	const root = mountEditPage([makeDeclaredServer({ label: "Prod" })]);
	fireClick(buttonByText(root, "Test connection"));
	const probe = postedMessages.at(-1) as RpcRequest<"testServerDraft">;
	expect(probe.method).toBe("testServerDraft");
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

test("the save bar names where the entry lands and counts what is unsaved", () => {
	const root = mountEditPage([makeDeclaredServer({ label: "Prod" })]);

	// A form that has not been touched has nothing to save and says nothing.
	const bar = root.querySelector(".form-card .toolbar") as HTMLElement;
	expect(bar.textContent).toContain("Saved to litellm-vscode-chat.servers");
	expect(bar.querySelector(".unsaved-count")).toBeNull();

	fireInput(inputByLabel(root, "Label"), "Prod 2");
	expect(root.querySelector(".unsaved-count")?.textContent).toBe("1 unsaved change");
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4001");
	expect(root.querySelector(".unsaved-count")?.textContent).toBe("2 unsaved changes");

	// Typing a field back to what it was retires its count: the bar reports
	// the difference from the entry, not the number of keystrokes.
	fireInput(inputByLabel(root, "Label"), "Prod");
	expect(root.querySelector(".unsaved-count")?.textContent).toBe("1 unsaved change");
});

test("the record rows and the expected-failure checkboxes keep a programmatic group", () => {
	const root = mountEditPage([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelParameters: { "gpt-4": { temperature: 0.2 } },
			},
		}),
	]);

	const list = root.querySelector("ul.record-table") as HTMLElement;
	expect(list.getAttribute("aria-label")).toBe("Model parameter matchers");
	expect(list.querySelectorAll("li.record-row").length).toBe(1);

	const failures = root.querySelector("fieldset.expected-failures") as HTMLElement;
	expect(failures.getAttribute("aria-label")).toBe("Expected failures");
});

test("every problem is in view without a gesture: the page holds no fold that could hide one", () => {
	const root = mountEditPage([makeDeclaredServer({ label: "Prod" })]);

	// The entry is one scroll: no disclosure anywhere, so no problem can
	// surface behind something the reader has to find and open first.
	expect(root.querySelectorAll(".form-card details").length).toBe(0);

	// A header problem renders under its own row the moment it exists.
	fireClick(buttonByText(root, "Add header"));
	fireInput(root.querySelector("input[aria-label='Header name']") as HTMLInputElement, "bad name");
	expect(root.textContent).toContain("Not a valid HTTP header name");

	// So does a matcher problem raised in the overlay, which lands on the row
	// the flat page shows in the Model parameters section.
	fireClick(buttonByText(root, "Add model matcher"));
	const overlay = root.querySelector<HTMLElement>(".matcher-editor");
	if (overlay === null) {
		throw new Error("Add model matcher did not open the overlay");
	}
	fireInput(overlay.querySelector("input.key") as HTMLInputElement, "gpt-4");
	fireClick(buttonByText(overlay, "Add parameter"));
	fireInput([...overlay.querySelectorAll("input.key")].at(-1) as HTMLInputElement, "temperature");
	fireInput(overlay.querySelector("input.value") as HTMLInputElement, "not json");
	fireClick(buttonByText(overlay, "Done"));
	expect(root.querySelector(".record-table .chip-field.invalid")).not.toBeNull();

	// Save refuses and names the first offender; both problems are on screen.
	resetPosted();
	fireClick(buttonByText(root, "Save"));
	expect(postedMessages).toEqual([]);
	expect(root.textContent).toContain("Cannot save: fix");
});

test("add matcher then cancel is a no-op: the pristine sweep leaves the form clean, nothing to ask about", () => {
	const dirty: boolean[] = [];
	const closes: number[] = [];
	const root = mountEditPage([makeDeclaredServer({ label: "Prod" })], undefined, {
		onDirtyChange: (value) => dirty.push(value),
		onRequestClose: () => closes.push(1),
	});

	fireClick(buttonByText(root, "Add model matcher"));
	const overlay = root.querySelector<HTMLElement>(".matcher-editor");
	if (overlay === null) {
		throw new Error("Add model matcher did not open the overlay");
	}
	fireClick(buttonByText(overlay, "Done"));
	// The pristine group is swept; nothing counts as a user edit, so Cancel
	// closes directly instead of raising the discard confirm over a no-op.
	expect(root.querySelector(".record-table")).toBeNull();
	// Nothing was reported dirty, so the shell has nothing to ask about: the
	// request to leave goes up unqualified.
	expect(dirty).toEqual([]);
	fireClick(buttonByText(root, "Discard changes"));
	expect(closes).toHaveLength(1);
});

test("the usage column shows the spend percentage with the Usage tab's severity tone", () => {
	const server = makeDeclaredServer({ label: "Prod", baseUrl: "http://localhost:4000" });
	const root = mount(<App />);
	const usageFor = (spentFraction: number) =>
		makeUsage({
			servers: [makeUsageServer({ label: "Prod", baseUrl: "http://localhost:4000", spend: 21, spentFraction })],
		});

	pushToWebview(statePush(makeState({ servers: [server], usage: usageFor(0.42) })));
	const cell = () => root.querySelector(".server-list .usage-cell") as HTMLElement;
	/** The figure without the hidden noun that names it for a screen reader. */
	const shown = () => (cell().lastChild?.textContent ?? "").trim();
	// The header row is gone, so the cell says what its number is - but only to
	// a screen reader. Sighted readers get the same noun from the hover tip.
	expect(cell().querySelector(".visually-hidden")?.textContent).toContain("Budget spent");
	expect(shown()).toBe("42%");
	expect(cell().classList.contains("tone-ok")).toBe(true);

	// Reaching a threshold counts as crossing it, exactly as the Usage tab
	// colors its percentage (the fixture thresholds are 0.8 and 0.95).
	pushToWebview(statePush(makeState({ servers: [server], usage: usageFor(0.8) })));
	expect(shown()).toBe("80%");
	expect(cell().classList.contains("tone-warn")).toBe(true);

	// Over budget shows the literal percentage in the error tone.
	pushToWebview(statePush(makeState({ servers: [server], usage: usageFor(1.12) })));
	expect(shown()).toBe("112%");
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
	const cell = root.querySelector(".server-list .usage-cell") as HTMLElement;
	expect(cell.querySelector(".visually-hidden")?.textContent).toContain("Spent");
	expect((cell.lastChild?.textContent ?? "").trim()).toBe("$3.07");
	// No severity tone: there is no budget for the amount to be a fraction of.
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
	// The cell exists and is empty, rather than being absent or carrying a
	// placeholder. There is no header row to label it any more: each cell on the
	// compact row says what it is, and an empty one says nothing at all.
	const usageCell = root.querySelector(".server-row .server-usage") as HTMLElement;
	expect(usageCell).not.toBeNull();
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
	const usageCell = root.querySelector(".server-row .server-usage") as HTMLElement;
	expect(usageCell.textContent).toBe("");
	expect(usageCell.querySelector(".usage-cell")).toBeNull();
});

/** The entry form's capability key input inside the open matcher editor overlay, with its listbox options. */
function capabilityKeyOptions(root: HTMLElement): string[] {
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
	fireFocus(keyInput);
	const listbox = document.getElementById(keyInput.getAttribute("aria-controls") ?? "");
	return Array.from(listbox?.querySelectorAll("[role='option']") ?? []).map((o) => o.textContent ?? "");
}

test("the entry form's capability key suggestions carry THAT server's observed vocabulary, never a sibling's", () => {
	// An entry-scoped record applies to one server only, so its autocomplete
	// draws on that server's own observed /model/info keys - not the
	// cross-server union the global editor uses.
	const root = mountEditPage([
		makeDeclaredServer({ label: "Prod", observedModelInfoKeys: ["prod_only_key", "mode"] }),
		makeDeclaredServer({
			label: "Other",
			baseUrl: "http://other.example:4000",
			observedModelInfoKeys: ["other_only_key"],
		}),
	]);
	const names = capabilityKeyOptions(root);
	expect(names).toContain("prod_only_key");
	expect(names).toContain("mode");
	expect(names).not.toContain("other_only_key");
	// The composed order holds here too: consumed first, observed sorted
	// after, directives last.
	expect(names[0]).toBe("context_length");
	expect(names.slice(-2)).toEqual(["_fallback", "_openrouter_model"]);
});

test("an entry without an observed key set (the add form) keeps the static capability suggestions", () => {
	const root = mountShell([makeDeclaredServer({ label: "Prod", observedModelInfoKeys: ["prod_only_key"] })]);
	// The ADD form targets no server yet, so no vocabulary is borrowed - not
	// even the one existing server's.
	fireClick(buttonByText(root, "Add server"));
	const names = capabilityKeyOptions(root);
	expect(names).toContain("context_length");
	expect(names).not.toContain("prod_only_key");
	expect(names.slice(-2)).toEqual(["_fallback", "_openrouter_model"]);
});

test("the entry table's compact [+] add popover draws on the same entry-scoped vocabulary as the overlay", () => {
	// The two entry surfaces for a capability key - the table's [+] chip and
	// the full editor's rows - must share one list.
	const root = mountEditPage([
		makeDeclaredServer({
			label: "Prod",
			observedModelInfoKeys: ["prod_only_key"],
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelCapabilities: { "gpt-4": { context_length: 128000 } },
			},
		}),
	]);
	const addChip = root.querySelector("button[aria-label='Add a field to \"gpt-4\"']") as HTMLButtonElement;
	expect(addChip).not.toBeNull();
	fireClick(addChip);
	const keyInput = root.querySelector(".chip-popover input.key") as HTMLInputElement;
	fireInput(keyInput, "prod");
	const listbox = document.getElementById(keyInput.getAttribute("aria-controls") ?? "");
	const names = Array.from(listbox?.querySelectorAll("[role='option']") ?? []).map((o) => o.textContent ?? "");
	expect(names).toEqual(["prod_only_key"]);
});

test("a nested overlay hears Esc alone: it closes, the form beneath survives and keeps focus", () => {
	// The matcher overlay opens above the edit destination, and its Escape
	// must close it alone - the page underneath is a place, not a dialog, and
	// the shell's own leave guard must not hear the same key. Radix's layer
	// stack plus the overlay's stopPropagation is what makes that true, so it
	// is worth pinning rather than inferring from the panels rendering.
	const root = mountEditPage([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				modelParameters: { "gpt-4": { temperature: 0.2 } },
			},
		}),
	]);
	const overlay = openMatcherEditor(root, "gpt-4");
	// One dialog, over a page: the destination is not a panel, so the overlay
	// is the only slide-over on screen.
	expect(root.querySelectorAll(".slide-over")).toHaveLength(1);

	fireKeyDown(overlay.querySelector("input") as HTMLElement, "Escape");

	// Only the inner one goes; the page beneath is still open and still holds
	// focus. The page is a destination rather than a panel now, so the overlay
	// is the one dialog on screen and it leaves nothing behind.
	expect(root.querySelector(".matcher-editor")).toBeNull();
	expect(root.querySelectorAll(".slide-over")).toHaveLength(0);
	const form = root.querySelector(".server-form") as HTMLElement;
	expect(form.contains(document.activeElement)).toBe(true);
});

test("Retry says it is working, and only its own ack releases it - no push, of any age, does", () => {
	// A discovery pass can run for tens of seconds - the timeouts are per request
	// and they sum - so a button that looked identical before and after the click
	// invited the double-click-until-something-happens trap.
	//
	// The sync is an acked method now, so the round trip that started the work is
	// the one that reports it finished. That replaced an inference, and the
	// inference is what this test used to pin: no push means completion, because
	// a sync reconciles the provider groups first and that reconciliation pushes
	// immediately, before the network discovery it exists to trigger has begun.
	// The old workaround watched lastChecked instead, which let an unrelated
	// background refresh clear the reader's spinner. Neither push below releases
	// it now, whatever check time it carries.
	// Fixed instants, not offsets from now: two calls to a now-relative helper
	// differ by the milliseconds between them.
	const BEFORE = new Date(Date.now() - 10 * 60_000).toISOString();
	const AFTER = new Date(Date.now() - 60_000).toISOString();
	const failing = (lastChecked: string) =>
		makeDeclaredServer({ label: "Prod", state: "error", error: "refused", lastChecked });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [failing(BEFORE)] })));

	resetPosted();
	fireClick(buttonByText(root, "Retry"));
	// The acked wire method, not the fire-and-forget command post.
	expect(postedCalls()).toEqual([{ method: "syncModels", payload: null }]);
	const syncId = lastRequest("syncModels").id;

	const pending = buttonByText(root, "Checking...");
	// aria-disabled, not the disabled attribute: the control has to REFUSE the
	// click while staying in the tab order, because `disabled` drops focus to the
	// body and takes the announcement with it.
	expect(pending.getAttribute("aria-disabled")).toBe("true");
	expect(pending.disabled).toBe(false);
	expect(pending.getAttribute("aria-label")).toContain("Prod");
	// A second click while it is in flight posts nothing.
	resetPosted();
	fireClick(pending);
	expect(postedCalls()).toEqual([]);

	// The reconciliation push, carrying the same check time.
	pushToWebview(statePush(makeState({ servers: [failing(BEFORE)] })));
	expect(buttonByText(root, "Checking...").getAttribute("aria-disabled")).toBe("true");

	// A NEWER check time used to be the release signal, and must not be one now:
	// an unrelated background refresh moves it without this reader's sync having
	// finished, and clearing here would be the same lie in the other direction.
	pushToWebview(statePush(makeState({ servers: [failing(AFTER)] })));
	expect(buttonByText(root, "Checking...").getAttribute("aria-disabled")).toBe("true");

	// An ack for a DIFFERENT syncModels request does not release it either. The
	// rail's Sync button posts the same method, and useIntentOutcome hands over
	// the latest envelope for the method whoever posted it, so presence alone
	// would let the rail switch off a row's spinner mid-pass.
	pushToWebview({ kind: "ack", id: `${syncId}-other`, method: "syncModels" });
	expect(buttonByText(root, "Checking...").getAttribute("aria-disabled")).toBe("true");

	// Only the ack for this row's own request releases it.
	pushToWebview({ kind: "ack", id: syncId, method: "syncModels" });
	expect(buttonByText(root, "Retry").getAttribute("aria-disabled")).toBe("false");
});

test("a sync that fails still releases the Retry control", () => {
	// A failed sync is a finished one as far as the button is concerned. Leaving
	// it disabled would strand the row for the life of the panel, which is the
	// failure mode the old abandon timer existed to paper over.
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod", state: "error", error: "refused" })] }))
	);
	resetPosted();
	fireClick(buttonByText(root, "Retry"));
	expect(buttonByText(root, "Checking...").getAttribute("aria-disabled")).toBe("true");

	pushToWebview({
		kind: "fail",
		id: lastRequest("syncModels").id,
		method: "syncModels",
		message: "sync failed",
		failureKind: "operation",
	});
	expect(buttonByText(root, "Retry").getAttribute("aria-disabled")).toBe("false");
});

test("a fleet-wide sync disables every row's Retry, not just the one clicked", () => {
	// The command refreshes every provider group, so leaving the other rows live
	// would let one impatient reader queue several complete passes from different
	// rows - and executeCommand is serialized, so the second runs after the first
	// rather than being rejected.
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				servers: [
					makeDeclaredServer({ label: "Prod", state: "error", error: "a" }),
					makeDeclaredServer({ label: "Beta", baseUrl: "http://b", state: "error", error: "b" }),
				],
			})
		)
	);
	const retries = () => [...root.querySelectorAll("button")].filter((b) => /Retry|Checking/.test(b.textContent ?? ""));
	expect(retries().length).toBe(2);

	fireClick(retries()[0] as HTMLButtonElement);
	// Only the row that asked SAYS it is checking; both refuse a click.
	expect(retries().map((b) => b.textContent?.trim())).toEqual(["Checking...", "Retry"]);
	expect(retries().every((b) => b.getAttribute("aria-disabled") === "true")).toBe(true);
	resetPosted();
	fireClick(retries()[1] as HTMLButtonElement);
	expect(postedCalls()).toEqual([]);
});

test("pressing Retry keeps the reader's focus on the button", () => {
	// The label changes from "Retry" to "Checking...", and keying the control by
	// its text destroyed and rebuilt the node exactly when it held focus - so the
	// keyboard user who pressed it was thrown back to the top of the document,
	// and heard nothing, because the announcement rides the focused element.
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod", state: "error", error: "refused" })] }))
	);
	const button = buttonByText(root, "Retry");
	button.focus();
	expect(document.activeElement).toBe(button);
	fireClick(button);
	// Same node, new wording - not a replacement.
	expect(document.activeElement).toBe(button);
	expect(button.textContent?.trim()).toBe("Checking...");
});

test("the list carries one polite live region, so a sync's outcome is announced", () => {
	// The retired banners carried role="alert". Without a replacement a screen
	// reader user got nothing at all when a sync landed and the rows changed
	// underneath them - a regression hidden inside a redesign.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod", state: "error", error: "x" })] })));

	const regions = [...root.querySelectorAll("[aria-live]")].filter((el) => el.closest("#panel-overview") !== null);
	// One region for the page, not one per row: five rows announcing themselves
	// on every push is noise, not news.
	expect(regions.length).toBe(1);
	const region = regions[0] as HTMLElement;
	expect(region.getAttribute("role")).toBe("status");
	expect(region.getAttribute("aria-live")).toBe("polite");
	expect(region.textContent).toContain("1 server needs attention");

	// It states the good outcome too, or recovery would announce silence - but
	// only once something has actually been checked. A fleet nobody has looked at
	// gets no clean bill of health.
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Fresh", state: "unchecked" })] })));
	expect(region.textContent).toContain("No servers have been checked yet");
	pushToWebview(
		statePush(
			makeState({
				servers: [makeDeclaredServer({ label: "Prod", state: "ok", lastChecked: new Date().toISOString() })],
			})
		)
	);
	expect(region.textContent).toContain("All servers are healthy");
	// And the visible summary stays absent when there is nothing to report.
	expect(root.querySelector(".server-summary")).toBeNull();
});
