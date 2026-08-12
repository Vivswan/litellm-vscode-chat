/**
 * The redesigned server form's webview behavior: the Authentication selector
 * revealing exactly the picked form's fields, the stored-secret legibility
 * hints (a stored key on a shape that does not name it stays visible and
 * removable), the misconfigured row's pill and actions, the custom-header
 * rows' save round trip, and the selector invalidating a standing
 * test-connection result.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { RpcRequest } from "../../../../dashboard/endpoints";
import { App } from "../../../../webview/dashboard/app";
import { ServersSection } from "../../../../webview/dashboard/servers";
import { declaredWithSecrets, makeDeclaredServer, makeMisconfiguredServer, makeState, statePush } from "../fixtures";
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

function mountSection(servers: Parameters<typeof ServersSection>[0]["servers"]) {
	return mount(<ServersSection servers={servers} now={Date.now()} />);
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
	const root = mountSection([makeDeclaredServer()]);
	fireClick(buttonByText(root, "Add server"));

	// A fresh form starts on None: no credential inputs anywhere.
	expect(authRadio(root, "None").checked).toBe(true);
	expect(root.querySelector("#server-apiKey")).toBeNull();
	expect(root.querySelector("#server-oauthTokenUrl")).toBeNull();
	expect(root.querySelector("#server-virtualKeyHeader")).toBeNull();

	// API key: the key input plus the virtual-key companion disclosure.
	fireCheck(authRadio(root, "API key (bearer)"), true);
	expect(root.querySelector("#server-apiKey")).not.toBeNull();
	expect(root.querySelector("#server-oauthTokenUrl")).toBeNull();
	expect(root.textContent).toContain("Also send a virtual key header (optional)");

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
	expect(root.textContent).toContain("Companions (optional)");
	expect(root.querySelector("#server-apiKey")).not.toBeNull();
	expect(root.querySelector("#server-virtualKeyHeader")).not.toBeNull();
});

test("editing a keyed entry derives the API-key form; switching to None keeps the stored key visible and removable", () => {
	const root = mountSection([declaredWithSecrets({ apiKey: "secure" })]);
	fireClick(buttonByText(root, "Edit"));
	expect(authRadio(root, "API key (bearer)").checked).toBe(true);
	expect(root.textContent).not.toContain("still activates the bearer");

	fireCheck(authRadio(root, "None"), true);
	// The shape rule: a stored key still activates the bearer, so the form
	// says so and keeps the Remove checkbox reachable.
	expect(root.textContent).toContain(
		"A stored API key still activates the bearer on this shape; use its Remove checkbox to stop sending it."
	);
	const remove = Array.from(root.querySelectorAll(".stored-auth input[type=checkbox]"));
	expect(remove.length).toBe(1);

	resetPosted();
	fireCheck(remove[0] as HTMLInputElement, true);
	fireClick(buttonByText(root, "Save"));
	const posted = postedMessages[0] as RpcRequest<"saveServerSetting">;
	expect(posted.method).toBe("saveServerSetting");
	expect(posted.payload.secrets.apiKey).toEqual({ action: "clear" });
});

test("a misconfigured row shows the Misconfigured pill, swaps Edit for Fix in settings.json, and keeps Remove", () => {
	const broken = makeMisconfiguredServer({ label: "Broken" });
	const root = mountSection([broken, makeDeclaredServer({ label: "Fine" })]);

	const pills = Array.from(root.querySelectorAll(".pill")).map((el) => (el.textContent ?? "").trim());
	expect(pills).toContain("Misconfigured");

	const firstRowActions = Array.from(
		root.querySelectorAll("tbody tr")[0]?.querySelectorAll("td.actions button") ?? []
	).map((el) => (el.textContent ?? "").trim());
	expect(firstRowActions).toEqual(["Fix in settings.json", "Remove"]);

	resetPosted();
	fireClick(buttonByText(root, "Fix in settings.json"));
	expect(postedCalls()).toEqual([{ method: "revealSetting", payload: { setting: "servers" } }]);

	// Its problems render in the misconfigured banner, not the generic error
	// banner (which this state has no member for), with the one-form hint.
	const banners = Array.from(root.querySelectorAll(".banner-error"));
	expect(banners.length).toBe(1);
	expect(banners[0]?.textContent).toContain("Broken: this entry is invalid and not used until fixed");
	expect(banners[0]?.textContent).toContain(broken.problems[0] ?? "");
	expect(banners[0]?.textContent).toContain("Keep exactly one auth form per entry");

	// The two-step remove posts removeServerSetting by label, like a declared row.
	resetPosted();
	fireClick(buttonByText(root, "Remove"));
	fireClick(buttonByText(root, "Confirm remove?"));
	const removed = postedMessages[0] as RpcRequest<"removeServerSetting">;
	expect(removed.method).toBe("removeServerSetting");
	expect(removed.payload.label).toBe("Broken");
});

test("the header rows round-trip through the save intent, edits and additions included", () => {
	const root = mountSection([
		makeDeclaredServer({
			label: "Prod",
			config: {
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
				headers: { "x-routing-env": "prod" },
			},
		}),
	]);
	fireClick(buttonByText(root, "Edit"));

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
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	fireClick(buttonByText(root, "Add your first server"));
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
