/**
 * The webview's secret invariants: pushes carry LOCATIONS only, the one value
 * path is the edit form's prefill. findSentinel sweeps attributes, input value
 * properties (a JS-assigned value never reaches outerHTML), the serialized
 * document HTML, and document textContent after every interaction.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { RpcRequest, RpcRequestType } from "../../../../dashboard/endpoints";
import { App } from "../../../../webview/dashboard/app";
import { declaredWithSecrets, makeState, poisonedStatePush, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	findSentinel,
	fireCheck,
	fireClick,
	fireInput,
	inputByLabel,
	mount,
	postedMessages,
	pushToWebview,
	resetPosted,
} from "../harness";

const SENTINEL = "sk-SENTINEL-4242-do-not-render";
const TYPED = "sk-TYPED-4242-do-not-render";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

/** The one legal residence of a secret value: its own field's value property. */
function expectOnlyInApiKeyInput(secret: string): void {
	expect(findSentinel(secret)).toEqual(['.value of <input id="server-apiKey">']);
}

/** No trace of any listed secret anywhere in the document. */
function expectNowhere(...secrets: string[]): void {
	for (const secret of secrets) {
		expect(findSentinel(secret)).toEqual([]);
	}
}

function lastPosted(): RpcRequestType {
	const message = postedMessages[postedMessages.length - 1];
	if (message === undefined) {
		throw new Error("nothing was posted");
	}
	return message;
}

function readInlineRequest(): RpcRequest<"readInlineSecrets"> {
	const message = postedMessages.find(
		(candidate): candidate is RpcRequest<"readInlineSecrets"> => candidate.method === "readInlineSecrets"
	);
	if (message === undefined) {
		throw new Error("no readInlineSecrets was posted");
	}
	return message;
}

/**
 * Every query here is about the edit destination, and the shell has surfaces
 * with controls of the same name (diagnostics has its own Test connection).
 */
function page(root: ParentNode): HTMLElement {
	return (root.querySelector(".server-edit-page") ?? root) as HTMLElement;
}

const apiKeyInput = (root: ParentNode) => inputByLabel(page(root), "API key");

/** Open the edit form on the first server row. */
function openEdit(root: HTMLElement): void {
	fireClick(buttonByText(page(root), "Edit"));
}

test("secure-side values never render, even against a poisoned state carrying forbidden value fields", () => {
	const root = mount(<App />);
	const server = declaredWithSecrets({ apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" });
	pushToWebview(statePush(makeState({ servers: [server] })));
	expectNowhere(SENTINEL);

	openEdit(root);
	expect(root.querySelector(".form-card")).not.toBeNull();
	expectNowhere(SENTINEL);

	// A state push that illegally smuggles secret values (protocol-forbidden
	// fields): no component may spread them into the DOM.
	pushToWebview(poisonedStatePush(SENTINEL));
	expectNowhere(SENTINEL);

	// The Settings tab stays mounted while hidden, so this sweep provably
	// covers its Import & Export group (buttons and help line) too.
	expect(
		Array.from(root.querySelectorAll(".settings-group-title")).some((title) => title.textContent === "Import & Export")
	).toBe(true);

	// Nor may any other message type surface them.
	pushToWebview({ kind: "ack", id: "x", method: "saveServerSetting", message: "ok" });
	expectNowhere(SENTINEL);
	pushToWebview({
		kind: "response",
		id: "not-our-request",
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	expectNowhere(SENTINEL);
});

test("the storage line says the one thing the reader cannot see, and stays quiet otherwise", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [declaredWithSecrets({ apiKey: "secure" })] })));
	fireClick(buttonByText(page(root), "Add server"));
	const apiKeyForm = [...root.querySelectorAll(".auth-selector label")].find(
		(label) => (label.textContent ?? "").trim() === "API key (bearer)"
	);
	fireCheck(apiKeyForm?.querySelector("input") as HTMLInputElement, true);

	// Nothing stored and nothing typed: no current value to keep, so the field
	// says nothing. Scoped to the hint SPAN because the id-carrying cell also
	// hosts the covering error overlay, whose voice would concatenate.
	const hintOf = () => document.getElementById("server-apiKey-error")?.firstElementChild?.textContent ?? "";
	expect(hintOf()).toBe("");

	// A typed value bound for secret storage is the ordinary case and says
	// nothing; the plain-text destination is a consequence, so it speaks up
	// in the warning tone at the moment the radio is picked.
	fireInput(apiKeyInput(root), TYPED);
	expect(hintOf()).toBe("");
	const settings = [...root.querySelectorAll<HTMLInputElement>("input[name='server-apiKey-where']")][1];
	fireCheck(settings as HTMLInputElement, true);
	expect(hintOf()).toBe("Saved as plain text in settings.json.");
	// The tone rides the hint SPAN inside the id-carrying cell (the cell also
	// hosts the covering error overlay, which has its own register).
	expect(document.getElementById("server-apiKey-error")?.firstElementChild?.className).toContain("state-warn");
	expectNowhere(SENTINEL);
});

test("a secure-stored field never triggers a prefill request and its untouched save posts keep", () => {
	const root = mount(<App />);
	const server = declaredWithSecrets({ apiKey: "secure" });
	pushToWebview(statePush(makeState({ servers: [server] })));

	resetPosted();
	openEdit(root);
	// No inline-stored field: the form must not ask for values at all.
	expect(postedMessages.filter((message) => message.method === "readInlineSecrets")).toEqual([]);
	const input = apiKeyInput(root);
	expect(input.value).toBe("");
	expect(input.type).toBe("password");
	expectNowhere(SENTINEL);

	// Save is not gated (no prefill pending) and an untouched field keeps.
	fireClick(buttonByText(page(root), "Save"));
	const saved = lastPosted() as RpcRequest<"saveServerSetting">;
	expect(saved.method).toBe("saveServerSetting");
	expect(saved.payload.secrets.apiKey).toEqual({ action: "keep" });
	expectNowhere(SENTINEL);
});

test("the sanctioned prefill path: masked value lands only in its own input, and Save is gated until it arrives", () => {
	const root = mount(<App />);
	const server = declaredWithSecrets({ apiKey: "settings" });
	pushToWebview(statePush(makeState({ servers: [server] })));

	resetPosted();
	openEdit(root);
	const request = readInlineRequest();
	// The prefill carries the displayed identity, not a bare label: the
	// extension answers empty when the entry no longer matches it.
	expect(request.payload.replace.label).toBe(server.label);
	expect(request.payload.replace.baseUrl).toBe(server.baseUrl);
	expect(request.payload.replace.secrets.apiKey).toBe("settings");
	expectNowhere(SENTINEL);

	// Save waits for the response: saving now would assemble "keep" and
	// silently drop a relocation the user just picked.
	expect(buttonByText(page(root), "Save").disabled).toBe(true);
	expect(root.textContent).toContain("Loading stored values...");

	pushToWebview({
		kind: "response",
		id: request.id,
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	const input = apiKeyInput(root);
	expect(input.value).toBe(SENTINEL);
	expect(input.type).toBe("password");
	expect(buttonByText(page(root), "Save").disabled).toBe(false);
	// The sentinel appears in exactly one place: that field's value property.
	expectOnlyInApiKeyInput(SENTINEL);
});

test("Show reveals, Hide re-masks, and the revealed state does not survive closing and reopening the form", () => {
	const root = mount(<App />);
	const server = declaredWithSecrets({ apiKey: "settings" });
	pushToWebview(statePush(makeState({ servers: [server] })));
	openEdit(root);
	pushToWebview({
		kind: "response",
		id: readInlineRequest().id,
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	expectOnlyInApiKeyInput(SENTINEL);

	// Each toggle re-renders the field; the value must stay in the input's
	// value property and nowhere else (revealing must not echo it into an
	// attribute or visible text).
	const input = apiKeyInput(root);
	expect(input.type).toBe("password");
	fireClick(buttonByText(page(root), "Show"));
	expect(apiKeyInput(root).type).toBe("text");
	expectOnlyInApiKeyInput(SENTINEL);
	fireClick(buttonByText(page(root), "Hide"));
	expect(apiKeyInput(root).type).toBe("password");
	expectOnlyInApiKeyInput(SENTINEL);

	// Reveal again, close, reopen: the next form starts masked (a revealed
	// input surviving into the next form is a shoulder-surf leak the value
	// scrub alone does not catch).
	fireClick(buttonByText(page(root), "Show"));
	expect(apiKeyInput(root).type).toBe("text");
	expectOnlyInApiKeyInput(SENTINEL);
	fireClick(buttonByText(page(root), "Discard changes"));
	expectNowhere(SENTINEL);
	resetPosted();
	openEdit(root);
	expectNowhere(SENTINEL);
	pushToWebview({
		kind: "response",
		id: readInlineRequest().id,
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	expect(apiKeyInput(root).type).toBe("password");
	expectOnlyInApiKeyInput(SENTINEL);
});

test("a stale inlineSecrets response never prefills the current form and its sentinel appears nowhere", () => {
	const root = mount(<App />);
	const server = declaredWithSecrets({ apiKey: "settings" });
	pushToWebview(statePush(makeState({ servers: [server] })));
	resetPosted();
	openEdit(root);
	readInlineRequest();

	pushToWebview({
		kind: "response",
		id: "a-previous-forms-request",
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	expect(apiKeyInput(root).value).toBe("");
	expectNowhere(SENTINEL);
	// The form is still waiting on its own response, so Save stays gated.
	expect(buttonByText(page(root), "Save").disabled).toBe(true);
	expectNowhere(SENTINEL);
});

test("closing the form scrubs the prefill and reopening posts a fresh readInlineSecrets", () => {
	const root = mount(<App />);
	const server = declaredWithSecrets({ apiKey: "settings" });
	pushToWebview(statePush(makeState({ servers: [server] })));
	resetPosted();
	openEdit(root);
	const first = readInlineRequest();
	pushToWebview({
		kind: "response",
		id: first.id,
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	expectOnlyInApiKeyInput(SENTINEL);

	fireClick(buttonByText(page(root), "Discard changes"));
	// Full sweep after close: no input value, attribute, or text retains it.
	expectNowhere(SENTINEL);

	// Reopening asks again instead of consuming the previous response.
	resetPosted();
	openEdit(root);
	const second = readInlineRequest();
	expect(second.id).not.toBe(first.id);
	expect(apiKeyInput(root).value).toBe("");
	expectNowhere(SENTINEL);
});

test("a typed secret leaves the page only as a directive: set, keep for untouched prefill, clear with no value key", () => {
	const root = mount(<App />);
	const server = declaredWithSecrets({ apiKey: "settings" });
	pushToWebview(statePush(makeState({ servers: [server] })));

	// Untouched prefill saves as keep: an unedited inline value never rewrites storage.
	openEdit(root);
	pushToWebview({
		kind: "response",
		id: readInlineRequest().id,
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	expectOnlyInApiKeyInput(SENTINEL);
	resetPosted();
	fireClick(buttonByText(page(root), "Save"));
	const kept = lastPosted() as RpcRequest<"saveServerSetting">;
	expect(kept.payload.secrets.apiKey).toEqual({ action: "keep" });
	// In flight, the value still sits only in its input; the ack-driven close scrubs it.
	expectOnlyInApiKeyInput(SENTINEL);
	pushToWebview({ kind: "ack", id: kept.id, method: "saveServerSetting" });
	expectNowhere(SENTINEL);

	// A typed value posts a set directive for the chosen location.
	openEdit(root);
	pushToWebview({
		kind: "response",
		id: readInlineRequest().id,
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	expectOnlyInApiKeyInput(SENTINEL);
	fireInput(apiKeyInput(root), TYPED);
	expectNowhere(SENTINEL);
	expectOnlyInApiKeyInput(TYPED);
	resetPosted();
	fireClick(buttonByText(page(root), "Save"));
	const set = lastPosted() as RpcRequest<"saveServerSetting">;
	expect(set.payload.secrets.apiKey).toEqual({ action: "set", location: "settings", value: TYPED });
	expectOnlyInApiKeyInput(TYPED);
	pushToWebview({ kind: "ack", id: set.id, method: "saveServerSetting" });
	expectNowhere(SENTINEL, TYPED);

	// Ticking remove posts clear, with no value key riding along.
	openEdit(root);
	pushToWebview({
		kind: "response",
		id: readInlineRequest().id,
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	expectOnlyInApiKeyInput(SENTINEL);
	// The remove control lives on its own line outside the storage
	// radiogroup: destructive, not a third storage choice.
	const removeToggle = Array.from(root.querySelectorAll(".secret-remove input[type='checkbox']"))[0];
	fireCheck(removeToggle as HTMLInputElement, true);
	// The disabled input keeps its draft text; ticking must not echo it elsewhere.
	expectOnlyInApiKeyInput(SENTINEL);
	resetPosted();
	fireClick(buttonByText(page(root), "Save"));
	const cleared = lastPosted() as RpcRequest<"saveServerSetting">;
	expect(cleared.payload.secrets.apiKey).toEqual({ action: "clear" });
	expect(Object.keys(cleared.payload.secrets.apiKey)).toEqual(["action"]);
	expectOnlyInApiKeyInput(SENTINEL);
	pushToWebview({ kind: "ack", id: cleared.id, method: "saveServerSetting" });
	expectNowhere(SENTINEL, TYPED);
});

test("a draft-connection test carries the typed secret only in its intent; both outcomes render value-free", () => {
	const root = mount(<App />);
	const server = declaredWithSecrets({ apiKey: "settings" });
	pushToWebview(statePush(makeState({ servers: [server] })));
	openEdit(root);
	pushToWebview({
		kind: "response",
		id: readInlineRequest().id,
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	expectOnlyInApiKeyInput(SENTINEL);

	// An untouched prefill tests as keep: the value goes nowhere, the
	// extension re-reads it from the setting itself.
	resetPosted();
	fireClick(buttonByText(page(root), "Test connection"));
	const kept = lastPosted() as RpcRequest<"testServerDraft">;
	expect(kept.method).toBe("testServerDraft");
	expect(kept.payload.secrets.apiKey).toEqual({ action: "keep" });
	expectOnlyInApiKeyInput(SENTINEL);

	// The success notice is extension-composed classification text; rendering
	// it must not surface any secret.
	pushToWebview({
		kind: "ack",
		id: kept.id,
		method: "testServerDraft",
		message: "Connected - 3 models",
	});
	expectOnlyInApiKeyInput(SENTINEL);

	// A typed value rides the intent as a set directive (webview -> extension
	// only) and a failure outcome renders without echoing it back.
	fireInput(apiKeyInput(root), TYPED);
	expectNowhere(SENTINEL);
	resetPosted();
	fireClick(buttonByText(page(root), "Test connection"));
	const set = lastPosted() as RpcRequest<"testServerDraft">;
	expect(set.payload.secrets.apiKey).toEqual({ action: "set", location: "settings", value: TYPED });
	expectOnlyInApiKeyInput(TYPED);
	pushToWebview({
		kind: "fail",
		id: set.id,
		method: "testServerDraft",
		message: "401 Unauthorized from the server",
		failureKind: "validation",
	});
	expect(root.querySelector(".test-result")?.textContent).toContain("401 Unauthorized");
	expectOnlyInApiKeyInput(TYPED);
});

test("relocating an untouched prefill to secure storage posts set with the prefilled value, not keep", () => {
	const root = mount(<App />);
	const server = declaredWithSecrets({ apiKey: "settings" });
	pushToWebview(statePush(makeState({ servers: [server] })));
	openEdit(root);
	pushToWebview({
		kind: "response",
		id: readInlineRequest().id,
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	expectOnlyInApiKeyInput(SENTINEL);

	// The user changes only the storage radio: inline -> secure. A regression
	// to keep would leave the plaintext secret in settings.json while the UI
	// reports it moved.
	const radios = root.querySelectorAll("input[name='server-apiKey-where']");
	const secureRadio = radios[0] as HTMLInputElement;
	expect(secureRadio.checked).toBe(false);
	fireCheck(secureRadio, true);
	expectOnlyInApiKeyInput(SENTINEL);

	resetPosted();
	fireClick(buttonByText(page(root), "Save"));
	const saved = lastPosted() as RpcRequest<"saveServerSetting">;
	expect(saved.method).toBe("saveServerSetting");
	expect(saved.payload.secrets.apiKey).toEqual({ action: "set", location: "secure", value: SENTINEL });
	expectOnlyInApiKeyInput(SENTINEL);
	pushToWebview({ kind: "ack", id: saved.id, method: "saveServerSetting" });
	expectNowhere(SENTINEL);
});

test("the uncontrolled secret input still round-trips typing, paste, and emptying through the draft state", () => {
	// The secret input is uncontrolled (React never holds the value, so it has
	// nothing to mirror into the attribute), while Save posts the DRAFT - so
	// every entry mode needs proof the draft tracks the node.
	const root = mount(<App />);
	const server = declaredWithSecrets({ apiKey: "settings" });
	pushToWebview(statePush(makeState({ servers: [server] })));
	openEdit(root);
	pushToWebview({
		kind: "response",
		id: readInlineRequest().id,
		method: "readInlineSecrets",
		payload: { values: { apiKey: SENTINEL } },
	});
	const input = apiKeyInput(root);
	const expectValue = (value: string) => {
		expect(input.value).toBe(value);
		expect(input.getAttribute("value")).toBeNull();
	};
	expectValue(SENTINEL);

	// Keystroke-shaped entry: incremental values through the draft loop, each
	// commit re-rendering the field the sync effect must leave untouched.
	fireInput(input, "sk-a");
	expectValue("sk-a");
	fireInput(input, "sk-ab");
	expectValue("sk-ab");
	expectNowhere(SENTINEL);

	// Paste-shaped entry: one whole-string replacement.
	fireInput(input, TYPED);
	expectValue(TYPED);
	expectOnlyInApiKeyInput(TYPED);

	// Emptying reaches the draft too (an emptied prefill keeps the stored value).
	fireInput(input, "");
	expectValue("");
	expectNowhere(SENTINEL, TYPED);

	// The draft state is what posts: re-enter a value and save it.
	fireInput(input, TYPED);
	resetPosted();
	fireClick(buttonByText(page(root), "Save"));
	const saved2 = lastPosted() as RpcRequest<"saveServerSetting">;
	expect(saved2.payload.secrets.apiKey).toEqual({ action: "set", location: "settings", value: TYPED });
	expectOnlyInApiKeyInput(TYPED);
	pushToWebview({ kind: "ack", id: saved2.id, method: "saveServerSetting" });
	expectNowhere(SENTINEL, TYPED);
});

test("the storage line is right in every state it renders in, not just the common ones", () => {
	// One sentence covering several states is how a shortened line goes wrong
	// for the states it did not mean: a value that has sat in settings.json for
	// months must not be told it is about to be written there.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [declaredWithSecrets({ apiKey: "settings" })] })));
	openEdit(root);
	// Scoped to the hint SPAN: the id-carrying cell also hosts the covering
	// error overlay, whose voice would concatenate with the hint's.
	const hintOf = () => document.getElementById("server-apiKey-error")?.firstElementChild?.textContent ?? "";
	const toneOf = () => document.getElementById("server-apiKey-error")?.firstElementChild?.className ?? "";

	// Stored inline, prefill not yet delivered: where it lives, and how to
	// keep it.
	expect(hintOf()).toBe("In settings. Leave empty to keep it.");
	pushToWebview({
		kind: "response",
		id: readInlineRequest().id,
		method: "readInlineSecrets",
		payload: { values: { apiKey: TYPED } },
	});

	// The prefill arrives unchanged: a fact about where it already is, stated
	// plainly - no warning tone, because nothing is about to happen.
	expect(hintOf()).toBe("In settings.json, in plain text.");
	expect(toneOf()).not.toContain("state-warn");

	// Typing over it makes it a value about to be written, which is a
	// consequence and says so.
	fireInput(apiKeyInput(root), `${TYPED}-edited`);
	expect(hintOf()).toBe("Saved as plain text in settings.json.");
	expect(toneOf()).toContain("state-warn");

	// Emptying keeps the stored value; removing takes it away.
	fireInput(apiKeyInput(root), "");
	expect(hintOf()).toBe("Emptied; the stored value is kept.");
	const remove = page(root).querySelector<HTMLInputElement>(".secret-remove input[type=checkbox]");
	fireCheck(remove as HTMLInputElement, true);
	expect(hintOf()).toBe("Removed on save.");
	expectNowhere(SENTINEL);
});

test("a stored secret whose form is not selected states the same two things the selected one does", () => {
	// The orphan row is the state the matrix above cannot reach: no input, so it
	// renders through a different component. One state, one sentence, whichever
	// component draws it.
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ servers: [declaredWithSecrets({ apiKey: "secure", oauthClientSecret: "secure" })] }))
	);
	openEdit(root);
	const hintOf = () => document.getElementById("server-oauthClientSecret-error")?.firstElementChild?.textContent ?? "";
	const removeLabel = () =>
		[...page(root).querySelectorAll<HTMLLabelElement>(".secret-remove")].find((label) =>
			(label.textContent ?? "").includes("OAuth client secret")
		);

	// The API-key form is selected, so the OAuth secret has no input of its
	// own - only where it lives and the gesture that takes it away.
	expect(hintOf()).toBe("In secret storage.");
	// The checkbox is the row's only control, so it carries the same
	// described-by wiring to the hint/error span the input-bearing rows have.
	expect(removeLabel()?.querySelector("input")?.getAttribute("aria-describedby")).toBe(
		"server-oauthClientSecret-error"
	);
	fireCheck(removeLabel()?.querySelector("input") as HTMLInputElement, true);
	expect(hintOf()).toBe("Removed on save.");
});
