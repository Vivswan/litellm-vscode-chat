/**
 * The server form slide-over: dialog semantics, initial focus, the Tab focus
 * trap, Esc/scrim close requests, the dirty-form discard confirm, and the
 * busy guard (an in-flight adopt must not be closable out from under its
 * ack). Rendered through App so the tests exercise the real wiring in
 * ServersSection, not a synthetic harness.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { App } from "../../../webview/dashboard/app";
import { makeDeclaredServer, makeExternalServer, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireClick,
	fireInput,
	fireKeyDown,
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

test("an in-flight adopt refuses close requests with a visible notice until its ack lands", () => {
	const external = makeExternalServer();
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [external] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(dialog(root), "Label"), "Adopted");
	resetPosted();
	fireClick(buttonByText(dialog(root), "Adopt"));
	const posted = postedMessages[0] as { requestId: string };

	// The refusal is not silent: the panel answers with a status bar.
	fireKeyDown(dialog(root), "Escape");
	expect(root.querySelector(".slide-over")).not.toBeNull();
	expect(root.querySelector(".discard-confirm")).toBeNull();
	expect(root.querySelector(".slide-notice")?.textContent).toContain("Still adopting");

	pushToWebview({ type: "intentSucceeded", intentType: "adoptServer", requestId: posted.requestId });
	expect(root.querySelector(".slide-over")).toBeNull();
	// The post-adoption notice survives the close.
	expect(root.textContent).toContain("its models appear twice");
});

test("focus falls back to the Servers tab when the opener unmounted with the form open", () => {
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
	expect(document.activeElement?.id).toBe("tab-servers");
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
