/**
 * The server form's webview behavior: the Authentication selector revealing exactly the picked form's fields, the
 * stored-secret legibility hints (a stored key on a shape that does not name it stays visible and removable), the
 * misconfigured row's pill and actions, the custom-header round trip, and the selector invalidating a test result.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { RpcRequest } from "../../../../dashboard/endpoints";
import type { DashboardServer } from "../../../../dashboard/viewModels";
import type { ServerEditRequest } from "../../../../webview/dashboard/serverEditPage";
import { ServerEditPage } from "../../../../webview/dashboard/serverEditPage";
import { ServersSection } from "../../../../webview/dashboard/servers";
import { declaredWithSecrets, makeDeclaredServer, makeMisconfiguredServer } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireCheck,
	fireClick,
	fireInput,
	inputByLabel,
	mount,
	postedCalls,
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

/** The edit destination on one entry; the auth selector's tests are about the form, not the shell. */
function mountEditPage(
	servers: readonly DashboardServer[],
	request: ServerEditRequest = { kind: "edit", label: servers[0]?.label ?? "" }
) {
	return mount(
		<ServerEditPage
			request={request}
			servers={servers}
			onDirtyChange={() => {}}
			onTargetGone={() => {}}
			onRequestClose={() => {}}
			onSaved={() => {}}
		/>
	);
}

function mountSection(servers: Parameters<typeof ServersSection>[0]["servers"]) {
	return mount(
		<ServersSection
			currencySymbol="$"
			servers={servers}
			now={Date.now()}
			onEditServer={() => {}}
			onAdoptServer={() => {}}
			onAddServer={() => {}}
		/>
	);
}

/** The Companions sub-head: a real heading with "optional" in its meta slot, the form sections' anatomy. */
function companionsHead(root: ParentNode): HTMLElement | null {
	const head = Array.from(root.querySelectorAll(".companions-head")).find(
		(candidate) =>
			candidate.querySelector(".section-title")?.textContent === "Companions" &&
			candidate.querySelector(".section-meta")?.textContent === "optional"
	);
	return head instanceof HTMLElement ? head : null;
}

/** The auth selector's radio whose visible label text matches exactly. */
function authRadio(root: ParentNode, text: string): HTMLInputElement {
	const label = Array.from(root.querySelectorAll(".auth-selector label")).find(
		(candidate) => (candidate.textContent ?? "").trim() === text
	);
	const input = label?.querySelector("input");
	if (!(input instanceof HTMLInputElement)) {
		throw new Error(`no auth form option "${text}"`);
	}
	return input;
}

test("the auth selector reveals exactly the picked form's fields", () => {
	const root = mountEditPage([makeDeclaredServer()], { kind: "add" });

	// A fresh form starts on None: no credential inputs anywhere.
	expect(authRadio(root, "None").checked).toBe(true);
	expect(root.querySelector("#server-apiKey")).toBeNull();
	expect(root.querySelector("#server-oauthTokenUrl")).toBeNull();
	expect(root.querySelector("#server-virtualKeyHeader")).toBeNull();

	// API key: the key input plus the virtual-key companion, in the same
	// scroll as the form that carries it - nothing to open.
	fireCheck(authRadio(root, "API key (bearer)"), true);
	expect(root.querySelector("#server-apiKey")).not.toBeNull();
	expect(root.querySelector("#server-oauthTokenUrl")).toBeNull();
	expect(companionsHead(root)).not.toBeNull();
	expect(root.querySelector("#server-virtualKeyHeader")).not.toBeNull();

	// Virtual key header: the pair alone.
	fireCheck(authRadio(root, "Virtual key in a custom header"), true);
	expect(root.querySelector("#server-virtualKeyHeader")).not.toBeNull();
	expect(root.querySelector("#server-virtualKeyValue")).not.toBeNull();
	expect(root.querySelector("#server-apiKey")).toBeNull();

	// OAuth: its four fields plus the companions area carrying the key and pair.
	fireCheck(authRadio(root, "OAuth"), true);
	expect(root.querySelector("#server-oauthTokenUrl")).not.toBeNull();
	expect(root.querySelector("#server-oauthClientId")).not.toBeNull();
	expect(root.querySelector("#server-oauthClientSecret")).not.toBeNull();
	expect(root.querySelector("#server-oauthScopes")).not.toBeNull();
	expect(companionsHead(root)).not.toBeNull();
	expect(root.querySelector("#server-apiKey")).not.toBeNull();
	expect(root.querySelector("#server-virtualKeyHeader")).not.toBeNull();
});

test("editing a keyed entry derives the API-key form; switching to None keeps the stored key visible and removable", () => {
	const root = mountEditPage([declaredWithSecrets({ apiKey: "secure" })]);
	expect(authRadio(root, "API key (bearer)").checked).toBe(true);
	expect(root.textContent).not.toContain("A stored API key is still attached");

	fireCheck(authRadio(root, "None"), true);
	// The shape rule: a stored key still activates the bearer, so the form
	// says so and keeps the Remove checkbox reachable.
	expect(root.textContent).toContain("A stored API key is still attached and still sent as a bearer token.");
	const remove = Array.from(root.querySelectorAll(".secret-remove input[type=checkbox]"));
	expect(remove.length).toBe(1);

	resetPosted();
	fireCheck(remove[0] as HTMLInputElement, true);
	fireClick(buttonByText(root, "Save"));
	const posted = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(posted.method).toBe("saveServerSetting");
	expect(posted.payload.secrets.apiKey).toEqual({ action: "clear" });
});

test("a misconfigured row shows the Misconfigured pill, drops Edit, and leaves the fix to its blocking line", () => {
	const broken = makeMisconfiguredServer({ label: "Broken" });
	const root = mountSection([broken, makeDeclaredServer({ label: "Fine" })]);

	const pills = Array.from(root.querySelectorAll(".pill")).map((el) => (el.textContent ?? "").trim());
	expect(pills).toContain("Misconfigured");

	// Remove alone: the entry has no Edit (the form cannot round-trip what the user typed), and its fix - reveal the
	// setting - is the first action of the blocking line under the row, where the reason for it also lives.
	const firstRowActions = Array.from(
		root.querySelectorAll(".server-item")[0]?.querySelectorAll(".server-actions button") ?? []
	).map((el) => (el.textContent ?? "").trim());
	expect(firstRowActions).toEqual(["Remove"]);
	const fixActions = Array.from(root.querySelectorAll(".row-diagnostic button")).map((el) =>
		(el.textContent ?? "").trim()
	);
	expect(fixActions).toContain("Fix in settings.json");

	resetPosted();
	fireClick(buttonByText(root, "Fix in settings.json"));
	expect(postedCalls()).toEqual([{ method: "revealSetting", payload: { setting: "servers" } }]);

	// Its problems render under its own row and only its row. Blocking, because the entry is switched off - the
	// consequence leads, and the parser's report follows as the detail.
	const lines = Array.from(root.querySelectorAll(".row-diagnostic"));
	expect(lines.length).toBe(1);
	expect(lines[0]?.classList.contains("sev-blocking")).toBe(true);
	expect(lines[0]?.textContent).toContain("Broken is switched off");
	expect(lines[0]?.textContent).toContain(broken.problems[0] ?? "");
	// The row it belongs to, not the one below it.
	expect(root.querySelectorAll(".server-item")[0]?.querySelector(".row-diagnostic")).not.toBeNull();
	expect(root.querySelectorAll(".server-item")[1]?.querySelector(".row-diagnostic")).toBeNull();

	// The two-step remove posts removeServerSetting by label, like a declared row.
	resetPosted();
	fireClick(buttonByText(root, "Remove"));
	fireClick(buttonByText(root, "Confirm remove?"));
	const removed = postedMessages[0] as RpcRequest<"removeServerSetting">;
	expect(removed.method).toBe("removeServerSetting");
	expect(removed.payload.label).toBe("Broken");
});

test("the header rows round-trip through the save intent, edits and additions included", () => {
	const root = mountEditPage([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				headers: { "x-routing-env": "prod" },
			},
		}),
	]);

	// The entry already carries a header, so the disclosure opens prefilled.
	const names = () => Array.from(root.querySelectorAll('input[aria-label="Header name"]')) as HTMLInputElement[];
	const values = () => Array.from(root.querySelectorAll('input[aria-label="Header value"]')) as HTMLInputElement[];
	expect(names().map((input) => input.value)).toEqual(["x-routing-env"]);
	expect(values().map((input) => input.value)).toEqual(["prod"]);

	fireInput(values()[0] as HTMLInputElement, "staging");
	fireClick(buttonByText(root, "Add header"));
	fireInput(names()[1] as HTMLInputElement, "x-trace-source");
	fireInput(values()[1] as HTMLInputElement, "vscode");

	resetPosted();
	fireClick(buttonByText(root, "Save"));
	const posted = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(posted.method).toBe("saveServerSetting");
	expect(posted.payload.server.headers).toEqual({ "x-routing-env": "staging", "x-trace-source": "vscode" });
});

test("switching the auth form clears a standing test result", () => {
	const root = mountEditPage([], { kind: "add" });
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");

	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	const posted = postedMessages[0] as RpcRequest<"testServerDraft">;
	pushToWebview({
		kind: "ack",
		id: posted.id,
		method: "testServerDraft",
		message: "Connected - 3 models",
	});
	expect(root.querySelector(".test-result")).not.toBeNull();

	// The pick changes which credentials a probe would send, so the PASS is
	// stale the moment it lands.
	fireCheck(authRadio(root, "API key (bearer)"), true);
	expect(root.querySelector(".test-result")).toBeNull();
});
