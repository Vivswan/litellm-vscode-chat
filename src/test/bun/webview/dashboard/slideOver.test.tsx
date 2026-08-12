/**
 * The server form slide-over: dialog semantics, initial focus, the Tab focus
 * trap, Esc/scrim close requests, the dirty-form discard confirm, and the
 * adopt round trip (the section matches the ack, so the form closes freely
 * while an adopt is in flight). Rendered through App so the tests exercise
 * the real wiring in ServersSection, not a synthetic harness.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { App } from "../../../../webview/dashboard/app";
import { makeDeclaredServer, makeExternalServer, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireClick,
	fireInput,
	fireKeyDown,
	inputByLabel,
	lastRequest,
	mount,
	pushToWebview,
	resetPosted,
} from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

/** With no server configured the add form opens from the guided start's CTA. */
function openAddForm(root: HTMLElement): void {
	const opener = buttonByText(root, "Add your first server");
	opener.focus();
	fireClick(opener);
}

function dialog(root: ParentNode): HTMLElement {
	const found = root.querySelector(".slide-over");
	if (found === null) {
		throw new Error("no slide-over is open");
	}
	return found as HTMLElement;
}

function fireTab(element: HTMLElement, shiftKey: boolean): void {
	void act(() => {
		element.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
	});
}

test("the form opens as an aria dialog with focus on its first field", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);

	const panel = dialog(root);
	expect(panel.getAttribute("role")).toBe("dialog");
	expect(panel.getAttribute("aria-modal")).toBe("true");
	const title = document.getElementById(panel.getAttribute("aria-labelledby") ?? "");
	expect(title?.textContent).toBe("Add server");
	expect(root.querySelector(".scrim")).not.toBeNull();
	expect(document.activeElement).toBe(inputByLabel(panel, "Label"));
});

test("Tab wraps from the last control to the first and Shift+Tab wraps back", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);
	const panel = dialog(root);

	const focusables = Array.from(
		panel.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")
	).filter((el) => el.tabIndex >= 0);
	const first = focusables[0] as HTMLElement;
	const last = focusables[focusables.length - 1] as HTMLElement;

	last.focus();
	fireTab(last, false);
	expect(document.activeElement).toBe(first);

	fireTab(first, true);
	expect(document.activeElement).toBe(last);
});

test("Esc closes a clean form immediately and hands focus back to the opener", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);

	fireKeyDown(inputByLabel(dialog(root), "Label"), "Escape");
	expect(root.querySelector(".slide-over")).toBeNull();
	expect(root.querySelector(".scrim")).toBeNull();
	expect(document.activeElement).toBe(buttonByText(root, "Add your first server"));
});

test("Esc on a dirty form asks before discarding, and Esc never destroys: only the Discard button does", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);
	const label = inputByLabel(dialog(root), "Label");
	fireInput(label, "Prod");

	fireKeyDown(label, "Escape");
	expect(root.querySelector(".slide-over")).not.toBeNull();
	expect(root.querySelector(".discard-confirm")?.textContent).toContain("Discard unsaved changes?");

	// A second Esc reads as "keep editing" (a reflexive Esc-Esc must not
	// destroy a half-typed form); the bar hides, the draft survives.
	fireKeyDown(label, "Escape");
	expect(root.querySelector(".slide-over")).not.toBeNull();
	expect(root.querySelector(".discard-confirm")).toBeNull();
	expect(inputByLabel(dialog(root), "Label").value).toBe("Prod");

	fireClick(buttonByText(dialog(root), "Cancel"));
	fireClick(buttonByText(dialog(root), "Keep editing"));
	expect(root.querySelector(".discard-confirm")).toBeNull();
	expect(inputByLabel(dialog(root), "Label").value).toBe("Prod");

	// The explicit Discard button is the only path that destroys the draft.
	fireKeyDown(label, "Escape");
	fireClick(buttonByText(dialog(root), "Discard"));
	expect(root.querySelector(".slide-over")).toBeNull();
});

test("while the confirm bar shows, Esc, the X, and the scrim all mean keep editing; none falls through to discard", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);
	const label = inputByLabel(dialog(root), "Label");
	fireInput(label, "Prod");

	const stillEditing = () => {
		expect(root.querySelector(".slide-over")).not.toBeNull();
		expect(root.querySelector(".discard-confirm")).toBeNull();
		expect(inputByLabel(dialog(root), "Label").value).toBe("Prod");
	};

	fireKeyDown(label, "Escape");
	expect(root.querySelector(".discard-confirm")).not.toBeNull();
	fireClick(dialog(root).querySelector("button[aria-label='Close']") as HTMLElement);
	stillEditing();

	fireKeyDown(label, "Escape");
	expect(root.querySelector(".discard-confirm")).not.toBeNull();
	fireClick(root.querySelector(".scrim") as HTMLElement);
	stillEditing();

	fireKeyDown(label, "Escape");
	expect(root.querySelector(".discard-confirm")).not.toBeNull();
	fireKeyDown(label, "Escape");
	stillEditing();
});

test("the Discard button closes the dirty form; the scrim and the X route through the same policy", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);
	fireInput(inputByLabel(dialog(root), "Label"), "Prod");

	fireClick(root.querySelector(".scrim") as HTMLElement);
	expect(root.querySelector(".discard-confirm")).not.toBeNull();
	fireClick(buttonByText(dialog(root), "Discard"));
	expect(root.querySelector(".slide-over")).toBeNull();

	// Clean form: the header X closes without a confirm step.
	openAddForm(root);
	const close = dialog(root).querySelector("button[aria-label='Close']") as HTMLElement;
	fireClick(close);
	expect(root.querySelector(".slide-over")).toBeNull();
});

test("the form's own Cancel button routes through the discard confirm when dirty", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);
	fireInput(inputByLabel(dialog(root), "Label"), "Half-typed");

	fireClick(buttonByText(dialog(root), "Cancel"));
	expect(root.querySelector(".slide-over")).not.toBeNull();
	fireClick(buttonByText(dialog(root), "Discard"));
	expect(root.querySelector(".slide-over")).toBeNull();
});

test("the adopt ack closes the still-open form and raises the post-adoption notice", () => {
	const external = makeExternalServer();
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [external] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(dialog(root), "Label"), "Adopted");
	resetPosted();
	fireClick(buttonByText(dialog(root), "Adopt"));
	const posted = lastRequest("adoptServer");

	// In flight: the inputs disable against a double submit, the form stays up.
	expect((buttonByText(dialog(root), "Adopting...") as HTMLButtonElement).disabled).toBe(true);
	expect(root.querySelector(".slide-over")).not.toBeNull();

	pushToWebview({ kind: "ack", id: posted.id, method: "adoptServer" });
	expect(root.querySelector(".slide-over")).toBeNull();
	// The post-adoption notice survives the close.
	expect(root.textContent).toContain("Models appear twice");
});

test("focus falls back to the combined tab when the opener unmounted with the form open", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	// Open from the guided start's CTA, which disappears once a server exists.
	const cta = buttonByText(root, "Add your first server");
	cta.focus();
	fireClick(cta);
	expect(root.querySelector(".slide-over")).not.toBeNull();

	// A background sync lands a server: the guided card (and the opener) unmounts.
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	expect(buttonByText(root, "Cancel")).toBeDefined();
	fireKeyDown(dialog(root), "Escape");
	expect(root.querySelector(".slide-over")).toBeNull();
	expect(document.activeElement?.id).toBe("tab-overview");
});

test("editing continues across a background state push while the slide-over is open", () => {
	const server = makeDeclaredServer({ label: "Prod" });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [server] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(dialog(root), "Base URL"), "http://localhost:9999");

	pushToWebview(statePush(makeState({ servers: [server] })));
	expect(root.querySelector(".slide-over")).not.toBeNull();
	expect(inputByLabel(dialog(root), "Base URL").value).toBe("http://localhost:9999");
});

test("a pending adopt never traps the user: the form closes freely and the ack still lands as the section notice", () => {
	const external = makeExternalServer();
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [external] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(dialog(root), "Label"), "Adopted");
	resetPosted();
	fireClick(buttonByText(dialog(root), "Adopt"));
	const posted = lastRequest("adoptServer");

	// Esc on the edited form asks the usual discard question; Discard closes it
	// with the intent still running extension-side.
	fireKeyDown(dialog(root), "Escape");
	expect(root.querySelector(".discard-confirm")).not.toBeNull();
	fireClick(buttonByText(dialog(root), "Discard"));
	expect(root.querySelector(".slide-over")).toBeNull();

	// The late ack still raises the post-adoption notice.
	pushToWebview({ kind: "ack", id: posted.id, method: "adoptServer" });
	expect(root.textContent).toContain("Models appear twice");
});

test("two adopts in flight resolve independently: the first ack still raises its notice, only the second closes its form", () => {
	const alpha = makeExternalServer({ label: "Alpha", adoptHandle: "handle-a", baseUrl: "http://a.example:4000" });
	const beta = makeExternalServer({ label: "Beta", adoptHandle: "handle-b", baseUrl: "http://b.example:4000" });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [alpha, beta] })));
	const editButtons = () =>
		[...root.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "Edit");

	// Adopt Alpha, then close the form with the intent still in flight.
	fireClick(editButtons()[0] as HTMLButtonElement);
	fireInput(inputByLabel(dialog(root), "Label"), "Adopted Alpha");
	resetPosted();
	fireClick(buttonByText(dialog(root), "Adopt"));
	const alphaRequestId = lastRequest("adoptServer").id;
	fireKeyDown(dialog(root), "Escape");
	fireClick(buttonByText(dialog(root), "Discard"));

	// Start a second adopt while the first still runs.
	fireClick(editButtons()[1] as HTMLButtonElement);
	fireInput(inputByLabel(dialog(root), "Label"), "Adopted Beta");
	resetPosted();
	fireClick(buttonByText(dialog(root), "Adopt"));
	const betaRequestId = lastRequest("adoptServer").id;

	// Alpha's ack raises its notice without touching Beta's open form.
	pushToWebview({ kind: "ack", id: alphaRequestId, method: "adoptServer" });
	expect(root.textContent).toContain("Models appear twice");
	expect(root.querySelector(".slide-over")).not.toBeNull();

	// Beta's own ack closes its form.
	pushToWebview({ kind: "ack", id: betaRequestId, method: "adoptServer" });
	expect(root.querySelector(".slide-over")).toBeNull();
});
