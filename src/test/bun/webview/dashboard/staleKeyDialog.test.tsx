/**
 * The edit form's stale-key question: a Save that re-points the base URL while
 * keeping a secure-stored secret asks before posting anything, and each answer
 * maps onto the directives the host already honors - "Use same key" posts the
 * keep (the host re-stamps), "Clear key" posts the clear (the host deletes),
 * "Keep editing" posts nothing. Detection reads secret LOCATIONS only; no
 * stamp or secret value ever reaches this page.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { RequestPayload } from "../../../../dashboard/endpoints";
import type { DashboardServer } from "../../../../dashboard/viewModels";
import type { ServerEditRequest } from "../../../../webview/dashboard/serverEditPage";
import { ServerEditPage } from "../../../../webview/dashboard/serverEditPage";
import { declaredWithSecrets } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireClick,
	fireInput,
	inputByLabel,
	lastRequest,
	mount,
	postedCalls,
	resetPosted,
} from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

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

/** An edit page over an entry whose API key sits in secret storage, with its base URL re-pointed. */
function mountRepointedForm(): HTMLElement {
	const root = mountEditPage([declaredWithSecrets({ apiKey: "secure" })]);
	fireInput(inputByLabel(root, "Base URL"), "http://moved.test");
	return root;
}

function savedSecrets(): RequestPayload<"saveServerSetting">["secrets"] {
	return lastRequest("saveServerSetting").payload.secrets;
}

test("a save that re-points the URL over a stored key asks instead of posting", () => {
	const root = mountRepointedForm();
	fireClick(buttonByText(root, "Save"));

	expect(root.querySelector(".confirm-dialog")).not.toBeNull();
	expect(postedCalls().filter((call) => call.method === "saveServerSetting")).toEqual([]);
});

test("Use same key posts the keep directive the host re-stamps on", () => {
	const root = mountRepointedForm();
	fireClick(buttonByText(root, "Save"));
	fireClick(buttonByText(root, "Use same key"));

	expect(root.querySelector(".confirm-dialog")).toBeNull();
	expect(savedSecrets().apiKey).toEqual({ action: "keep" });
	expect(lastRequest("saveServerSetting").payload.server.baseUrl).toBe("http://moved.test");
});

test("Clear key posts the clear directive that deletes the stored value", () => {
	const root = mountRepointedForm();
	fireClick(buttonByText(root, "Save"));
	fireClick(buttonByText(root, "Clear key"));

	expect(root.querySelector(".confirm-dialog")).toBeNull();
	expect(savedSecrets().apiKey).toEqual({ action: "clear" });
});

test("Keep editing posts nothing and returns to the form", () => {
	const root = mountRepointedForm();
	fireClick(buttonByText(root, "Save"));
	fireClick(buttonByText(root, "Keep editing"));

	expect(root.querySelector(".confirm-dialog")).toBeNull();
	expect(postedCalls().filter((call) => call.method === "saveServerSetting")).toEqual([]);
	// The draft survives the cancelled save; a second Save asks again.
	fireClick(buttonByText(root, "Save"));
	expect(root.querySelector(".confirm-dialog")).not.toBeNull();
});

test("a moved OAuth token URL asks about the kept client secret; each answer maps onto its directive", () => {
	const server: DashboardServer = {
		...declaredWithSecrets({ oauthClientSecret: "secure" }),
		hasOAuth: true,
		config: {
			secrets: { kind: "proven", locations: { apiKey: "none", oauthClientSecret: "secure", virtualKeyValue: "none" } },
			oauthTokenUrl: "https://idp-a.test/token",
			oauthClientId: "client",
		},
	} as DashboardServer;
	const root = mountEditPage([server]);
	fireInput(inputByLabel(root, "OAuth token URL"), "https://idp-b.test/token");
	fireClick(buttonByText(root, "Save"));

	const dialog = root.querySelector(".confirm-dialog");
	expect(dialog).not.toBeNull();
	// The detail names the destination the secret was saved for: the token URL,
	// not the (unchanged) base URL.
	expect(dialog?.textContent ?? "").toContain("https://idp-a.test/token");
	fireClick(buttonByText(root, "Clear key"));
	expect(savedSecrets().oauthClientSecret).toEqual({ action: "clear" });
});

test("both URLs moved: the detail names both old destinations the answer applies to", () => {
	const server: DashboardServer = {
		...declaredWithSecrets({ apiKey: "secure", oauthClientSecret: "secure" }),
		hasOAuth: true,
		config: {
			secrets: {
				kind: "proven",
				locations: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "none" },
			},
			oauthTokenUrl: "https://idp-a.test/token",
			oauthClientId: "client",
		},
	} as DashboardServer;
	const root = mountEditPage([server]);
	fireInput(inputByLabel(root, "Base URL"), "http://moved.test");
	fireInput(inputByLabel(root, "OAuth token URL"), "https://idp-b.test/token");
	fireClick(buttonByText(root, "Save"));

	const dialog = root.querySelector(".confirm-dialog");
	expect(dialog).not.toBeNull();
	const text = dialog?.textContent ?? "";
	expect(text).toContain("http://localhost:4000");
	expect(text).toContain("https://idp-a.test/token");
});

test("a client secret stored before the entry had a token URL falls back to the destination-free phrasing", () => {
	const server: DashboardServer = {
		...declaredWithSecrets({ oauthClientSecret: "secure" }),
		config: {
			secrets: { kind: "proven", locations: { apiKey: "none", oauthClientSecret: "secure", virtualKeyValue: "none" } },
		},
	} as DashboardServer;
	const root = mountEditPage([server]);
	// The form opens on a non-OAuth shape (no token URL/client ID configured);
	// its own block message directs the user to switch to OAuth, so they do,
	// and fill the pair the exchange needs.
	const oauthRadio = Array.from(root.querySelectorAll(".auth-selector label"))
		.find((label) => (label.textContent ?? "").includes("OAuth"))
		?.querySelector("input");
	if (!(oauthRadio instanceof HTMLInputElement)) {
		throw new Error("no OAuth auth option");
	}
	fireClick(oauthRadio);
	fireInput(inputByLabel(root, "OAuth token URL"), "https://idp.test/token");
	fireInput(inputByLabel(root, "OAuth client ID"), "client");
	fireClick(buttonByText(root, "Save"));

	const dialog = root.querySelector(".confirm-dialog");
	expect(dialog).not.toBeNull();
	// The old entry declared no token URL, so there is no address to name -
	// never an empty "{0}" hole in the sentence.
	expect(dialog?.textContent ?? "").toContain("The stored key was saved for a different address.");
	fireClick(buttonByText(root, "Use same key"));
	expect(savedSecrets().oauthClientSecret).toEqual({ action: "keep" });
});

test("no question without a URL move or without a stored key", () => {
	// Unchanged URL: the save posts straight through.
	const unchanged = mountEditPage([declaredWithSecrets({ apiKey: "secure" })]);
	fireClick(buttonByText(unchanged, "Save"));
	expect(unchanged.querySelector(".confirm-dialog")).toBeNull();
	expect(savedSecrets().apiKey).toEqual({ action: "keep" });
	cleanup();
	resetPosted();

	// A moved URL with no stored credential: nothing to re-pair, no question.
	const keyless = mountEditPage([declaredWithSecrets({})]);
	fireInput(inputByLabel(keyless, "Base URL"), "http://moved.test");
	fireClick(buttonByText(keyless, "Save"));
	expect(keyless.querySelector(".confirm-dialog")).toBeNull();
	expect(lastRequest("saveServerSetting").payload.server.baseUrl).toBe("http://moved.test");
});
