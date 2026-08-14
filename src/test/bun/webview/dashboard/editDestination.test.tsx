/**
 * The server edit destination and the shell contracts around it: the pane
 * swaps to one entry's configuration with the rail still on screen, focus
 * travels there and comes back, Esc and a rail click are REQUESTS that a
 * dirty draft turns into a question, and the adopt round trip survives the
 * page that started it. Rendered through App, because every one of these is a
 * claim about the real wiring rather than about a component in isolation.
 *
 * It replaces the slide-over suite this file used to be: the form stopped
 * being a dialog over the page it came from, which is the whole point of the
 * change - a destination has no scrim to click, no X, and no focus trap, and
 * pinning that it has none is as much a part of the contract as the parts it
 * kept. The one dialog left is the discard question itself: a centered,
 * focus-trapped alertdialog over a scrim, raised only by a dirty-form
 * navigation, whose Esc is consumed by the dialog and heard by nothing below.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { App } from "../../../../webview/dashboard/app";
import { declaredWithSecrets, makeDeclaredServer, makeExternalServer, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireCheck,
	fireClick,
	fireInput,
	fireKeyDown,
	fireMouseEnter,
	inputByLabel,
	lastRequest,
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

/** With no server configured the add destination opens from the guided start's CTA. */
function openAddForm(root: HTMLElement): void {
	const opener = buttonByText(root, "Add your first server");
	opener.focus();
	fireClick(opener);
}

function page(root: ParentNode): HTMLElement {
	const found = root.querySelector(".server-edit-page");
	if (found === null) {
		throw new Error("the edit destination is not open");
	}
	return found as HTMLElement;
}

/** The discard question's modal, or null while no question stands. It renders beside the pane, never inside the page. */
function confirmDialog(): HTMLElement | null {
	return document.querySelector<HTMLElement>(".confirm-dialog");
}

function openConfirmDialog(): HTMLElement {
	const dialog = confirmDialog();
	if (dialog === null) {
		throw new Error("the discard question is not open");
	}
	return dialog;
}

test("the destination fills the pane with the rail still on screen, and takes focus on arrival", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);

	const surface = page(root);
	expect(surface.getAttribute("aria-labelledby")).toBe("server-form-title");
	expect(document.getElementById("server-form-title")?.textContent).toBe("Add server");
	// A place, not a dialog: nothing to click outside of, nothing to dismiss.
	expect(surface.getAttribute("role")).toBeNull();
	expect(root.querySelector(".scrim")).toBeNull();
	expect(root.querySelector("button[aria-label='Close']")).toBeNull();
	// The rail is still there and still operable - the reason this is a
	// destination rather than a panel over the page.
	expect(root.querySelector(".rail")).not.toBeNull();
	expect((buttonByText(root, "Sync models") as HTMLButtonElement).isConnected).toBe(true);
	// Focus travels with the navigation, or Tab would carry on from the row
	// the reader left behind on a pane that is no longer showing.
	expect(document.activeElement).toBe(inputByLabel(surface, "Label"));
});

test("Esc leaves a clean page immediately and hands focus back to the control that opened it", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);

	fireKeyDown(inputByLabel(page(root), "Label"), "Escape");
	expect(root.querySelector(".server-edit-page")).toBeNull();
	expect(document.activeElement).toBe(buttonByText(root, "Add your first server"));
});

test("Esc on a dirty page asks before discarding, and Esc never destroys: only the Discard button does", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);
	const label = inputByLabel(page(root), "Label");
	fireInput(label, "Prod");

	fireKeyDown(label, "Escape");
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(openConfirmDialog().textContent).toContain("Discard unsaved changes?");
	// The question is not part of the page's own save bar any more.
	expect(page(root).querySelector(".confirm-dialog")).toBeNull();
	expect(page(root).querySelector(".discard-confirm")).toBeNull();

	// A second Esc reads as "keep editing" (a reflexive Esc-Esc must not
	// destroy a half-typed draft). The modal holds focus, so the second press
	// lands on it; the dialog closes, the draft survives.
	fireKeyDown(document.activeElement as HTMLElement, "Escape");
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(confirmDialog()).toBeNull();
	expect(inputByLabel(page(root), "Label").value).toBe("Prod");

	fireClick(buttonByText(page(root), "Discard changes"));
	fireClick(buttonByText(openConfirmDialog(), "Keep editing"));
	expect(confirmDialog()).toBeNull();
	expect(inputByLabel(page(root), "Label").value).toBe("Prod");

	// The explicit Discard button is the only path that destroys the draft.
	fireKeyDown(label, "Escape");
	fireClick(buttonByText(openConfirmDialog(), "Discard"));
	expect(root.querySelector(".server-edit-page")).toBeNull();
});

test("while the question stands, another Esc means keep editing rather than falling through to discard", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);
	const label = inputByLabel(page(root), "Label");
	fireInput(label, "Prod");

	fireKeyDown(label, "Escape");
	expect(confirmDialog()).not.toBeNull();
	fireKeyDown(document.activeElement as HTMLElement, "Escape");
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(confirmDialog()).toBeNull();
	expect(inputByLabel(page(root), "Label").value).toBe("Prod");
});

test("a rail click is a navigation the guard sees first, and the answer decides where the reader lands", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");

	// Dirty: the click raises the question instead of navigating, and the
	// draft is still there behind it.
	fireClick(document.getElementById("tab-usage") as HTMLElement);
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(confirmDialog()).not.toBeNull();

	// Keeping goes nowhere: the reader stays on the page they were editing.
	fireClick(buttonByText(openConfirmDialog(), "Keep editing"));
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(document.getElementById("tab-usage")?.getAttribute("aria-selected")).toBe("false");

	// Discarding takes them where they asked to go, not back to the list.
	fireClick(document.getElementById("tab-usage") as HTMLElement);
	fireClick(buttonByText(openConfirmDialog(), "Discard"));
	expect(root.querySelector(".server-edit-page")).toBeNull();
	expect(document.getElementById("tab-usage")?.getAttribute("aria-selected")).toBe("true");
	expect(document.activeElement?.id).toBe("tab-usage");
});

test("a rail click on a clean page just navigates, with no question in sight", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));

	fireClick(document.getElementById("tab-diagnostics") as HTMLElement);
	expect(confirmDialog()).toBeNull();
	expect(root.querySelector(".server-edit-page")).toBeNull();
	expect(document.getElementById("tab-diagnostics")?.getAttribute("aria-selected")).toBe("true");
});

test("the page's own Discard changes routes through the same question when dirty", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	openAddForm(root);
	fireInput(inputByLabel(page(root), "Label"), "Half-typed");

	fireClick(buttonByText(page(root), "Discard changes"));
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	fireClick(buttonByText(openConfirmDialog(), "Discard"));
	expect(root.querySelector(".server-edit-page")).toBeNull();
});

test("the adopt ack leaves the page and raises the post-adoption notice on the list behind it", () => {
	const external = makeExternalServer();
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [external] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Label"), "Adopted");
	resetPosted();
	fireClick(buttonByText(page(root), "Adopt"));
	const posted = lastRequest("adoptServer");

	// In flight: the inputs disable against a double submit, the page stays.
	expect((buttonByText(page(root), "Adopting...") as HTMLButtonElement).disabled).toBe(true);
	expect(root.querySelector(".server-edit-page")).not.toBeNull();

	pushToWebview({ kind: "ack", id: posted.id, method: "adoptServer" });
	expect(root.querySelector(".server-edit-page")).toBeNull();
	// The notice belongs to the list the reader comes back to.
	expect(root.textContent).toContain("Models appear twice");
});

test("focus falls back to the section's rail item when the opener left with the page open", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	// Open from the guided start's CTA, which disappears once a server exists.
	const cta = buttonByText(root, "Add your first server");
	cta.focus();
	fireClick(cta);
	expect(root.querySelector(".server-edit-page")).not.toBeNull();

	// A background sync lands a server: the guided card (and the opener) unmounts.
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	fireKeyDown(page(root), "Escape");
	expect(root.querySelector(".server-edit-page")).toBeNull();
	expect(document.activeElement?.id).toBe("tab-overview");
});

test("editing continues across a background state push", () => {
	const server = makeDeclaredServer({ label: "Prod" });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [server] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");

	pushToWebview(statePush(makeState({ servers: [server] })));
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(inputByLabel(page(root), "Base URL").value).toBe("http://localhost:9999");
});

test("an entry deleted under an open page says so instead of editing something that is gone", () => {
	const server = makeDeclaredServer({ label: "Prod" });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [server] })));
	fireClick(buttonByText(root, "Edit"));

	pushToWebview(statePush(makeState({ servers: [] })));
	expect(page(root).textContent).toContain("This server is gone");
	fireClick(buttonByText(page(root), "Back to servers"));
	expect(root.querySelector(".server-edit-page")).toBeNull();
});

test("a pending adopt never traps the reader: leaving works and the late ack still lands as the notice", () => {
	const external = makeExternalServer();
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [external] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Label"), "Adopted");
	resetPosted();
	fireClick(buttonByText(page(root), "Adopt"));
	const posted = lastRequest("adoptServer");

	// Esc on the edited page asks the usual question; Discard leaves with the
	// intent still running extension-side.
	fireKeyDown(page(root), "Escape");
	expect(confirmDialog()).not.toBeNull();
	fireClick(buttonByText(openConfirmDialog(), "Discard"));
	expect(root.querySelector(".server-edit-page")).toBeNull();

	// The late ack still raises the post-adoption notice on the list.
	pushToWebview({ kind: "ack", id: posted.id, method: "adoptServer" });
	expect(root.textContent).toContain("Models appear twice");
});

test("a draft whose entry is deleted stops being a draft: every way out still works", () => {
	// The form died with the entry, so there is nothing left to save and
	// nothing to ask about. A dirty flag that outlived it would make the
	// shell answer "unsaved changes?" for a draft nobody can see, and every
	// exit - the trail, Esc, the rail - would raise a question that nothing
	// renders. That is a trapped reader, so it is pinned here.
	const server = makeDeclaredServer({ label: "Prod" });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [server] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");

	pushToWebview(statePush(makeState({ servers: [] })));
	expect(page(root).textContent).toContain("This server is gone");
	fireClick(buttonByText(page(root), "Back to servers"));
	expect(root.querySelector(".server-edit-page")).toBeNull();
	expect(confirmDialog()).toBeNull();
});

test("an entry deleted while the question stands takes the question with it", () => {
	// The modal outliving its draft would ask about edits nobody can keep, and
	// a navigation intent left behind would fire on some later exit the reader
	// never asked for.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");
	fireClick(document.getElementById("tab-usage") as HTMLElement);
	expect(confirmDialog()).not.toBeNull();

	pushToWebview(statePush(makeState({ servers: [] })));
	expect(confirmDialog()).toBeNull();
	expect(page(root).textContent).toContain("This server is gone");
	// The declined-by-deletion navigation does not fire on the way out either.
	fireClick(buttonByText(page(root), "Back to servers"));
	expect(document.getElementById("tab-overview")?.getAttribute("aria-selected")).toBe("true");
});

test("keeping the page answers the navigation too: the abandoned destination does not fire on the next exit", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");

	// Ask to go to Usage, then say no.
	fireClick(document.getElementById("tab-usage") as HTMLElement);
	fireClick(buttonByText(openConfirmDialog(), "Keep editing"));

	// Leaving through the page's own control now goes back where the reader
	// came from, not to the destination they declined.
	fireClick(buttonByText(page(root), "Discard changes"));
	fireClick(buttonByText(openConfirmDialog(), "Discard"));
	expect(root.querySelector(".server-edit-page")).toBeNull();
	expect(document.getElementById("tab-usage")?.getAttribute("aria-selected")).toBe("false");
	expect(document.getElementById("tab-overview")?.getAttribute("aria-selected")).toBe("true");
});

test("a question raised from the rail returns focus to the page on keep editing, not to the rail", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");

	// The click leaves focus on the rail item and raises the question there.
	const railItem = document.getElementById("tab-usage") as HTMLElement;
	// Focusing the rail blurs the field, which the form reacts to; act keeps
	// that update inside the test's own render pass.
	void act(() => railItem.focus());
	fireClick(railItem);
	// The modal takes focus wherever the raise came from, so Esc answers it
	// without hunting for the right listener.
	expect(document.activeElement).toBe(buttonByText(openConfirmDialog(), "Keep editing"));

	fireKeyDown(document.activeElement as HTMLElement, "Escape");
	expect(confirmDialog()).toBeNull();
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	// The reader said "stay", so focus lands in the page they stayed on -
	// handing it back to the rail would say the opposite.
	expect(document.activeElement?.id).toBe("server-edit-page");
});

test("the extension's deep link is a navigation like any other: a dirty page gets asked", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");

	pushToWebview({ kind: "focusSection", section: "diagnostics" });
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(confirmDialog()).not.toBeNull();

	fireClick(buttonByText(openConfirmDialog(), "Discard"));
	expect(root.querySelector(".server-edit-page")).toBeNull();
	expect(document.getElementById("tab-diagnostics")?.getAttribute("aria-selected")).toBe("true");
});

test("the trail back routes through the same guard as Esc and the rail", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));

	// Clean: it just leaves.
	fireClick(buttonByText(page(root), "Servers"));
	expect(root.querySelector(".server-edit-page")).toBeNull();

	// Dirty: it asks, like every other way out.
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");
	fireClick(buttonByText(page(root), "Servers"));
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(confirmDialog()).not.toBeNull();
});

test("two adopts resolve independently: an abandoned one still lands its notice while the next page is open", () => {
	// The page owns one adopt at a time and remounts per open (App keys it),
	// so a second adopt cannot inherit the first's request. That remount is
	// load-bearing, which is why this is pinned rather than reasoned about.
	const alpha = makeExternalServer({ label: "Alpha", adoptHandle: "handle-a", baseUrl: "http://a.example:4000" });
	const beta = makeExternalServer({ label: "Beta", adoptHandle: "handle-b", baseUrl: "http://b.example:4000" });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [alpha, beta] })));
	const editButtons = () =>
		[...root.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "Edit");

	fireClick(editButtons()[0] as HTMLButtonElement);
	fireInput(inputByLabel(page(root), "Label"), "Adopted Alpha");
	resetPosted();
	fireClick(buttonByText(page(root), "Adopt"));
	const alphaId = lastRequest("adoptServer").id;
	fireKeyDown(page(root), "Escape");
	fireClick(buttonByText(openConfirmDialog(), "Discard"));

	// A second adopt, from the other row, while the first is still running.
	fireClick(editButtons()[1] as HTMLButtonElement);
	fireInput(inputByLabel(page(root), "Label"), "Adopted Beta");
	resetPosted();
	fireClick(buttonByText(page(root), "Adopt"));
	const betaId = lastRequest("adoptServer").id;

	// Alpha's ack raises its notice without disturbing Beta's open page.
	pushToWebview({ kind: "ack", id: alphaId, method: "adoptServer" });
	expect(root.textContent).toContain("Models appear twice");
	expect(root.querySelector(".server-edit-page")).not.toBeNull();

	// Beta's own ack is the one that leaves.
	pushToWebview({ kind: "ack", id: betaId, method: "adoptServer" });
	expect(root.querySelector(".server-edit-page")).toBeNull();
});

test("a validation failure keeps the reader here and says why, where they are", () => {
	// The servers list has its own failure banner, and the list is BEHIND this
	// page: a message rendered only there is a message nobody sees while the
	// form that caused it is still open.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");
	resetPosted();
	fireClick(buttonByText(page(root), "Save"));
	const posted = lastRequest("saveServerSetting");

	pushToWebview({
		kind: "fail",
		id: posted.id,
		method: "saveServerSetting",
		message: "label: this label is reserved",
		failureKind: "validation",
	});
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(page(root).querySelector(".banner-error")?.textContent).toContain("this label is reserved");
	// The draft survives to be fixed.
	expect(inputByLabel(page(root), "Base URL").value).toBe("http://localhost:9999");
});

test("a rename's own push cannot strand a successful save on the gone card", () => {
	// Saving a rename makes the entry's old label stop resolving. The write
	// comes back as a state push, which can beat the ack: if the page took
	// that as "deleted" it would unmount the form, the ack would land on
	// nothing, and a save that worked would read as an entry that vanished.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Label"), "Renamed");
	resetPosted();
	fireClick(buttonByText(page(root), "Save"));
	const posted = lastRequest("saveServerSetting");

	// The push lands first, under the still-open page.
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Renamed" })] })));
	expect(page(root).textContent).not.toContain("This server is gone");

	// The ack then leaves, as it would have without the race.
	pushToWebview({ kind: "ack", id: posted.id, method: "saveServerSetting" });
	expect(root.querySelector(".server-edit-page")).toBeNull();
});

test("the destination is the Servers panel's own content, so the rail keeps telling the truth", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));

	const panel = document.getElementById("panel-overview") as HTMLElement;
	expect(panel.contains(page(root))).toBe(true);
	expect(panel.hidden).toBe(false);
	expect(document.getElementById("tab-overview")?.getAttribute("aria-selected")).toBe("true");
});

test("a second navigation changes where the reader is going, it does not answer the question", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");

	fireClick(document.getElementById("tab-usage") as HTMLElement);
	expect(confirmDialog()).not.toBeNull();
	// A different destination arriving while the question stands (the rail is
	// behind the scrim, but a deep link still gets through) is a new intent,
	// not a toggle: leaving the question up is the only reading that does not
	// look like the app ignoring the request.
	pushToWebview({ kind: "focusSection", section: "diagnostics" });
	expect(confirmDialog()).not.toBeNull();
	fireClick(buttonByText(openConfirmDialog(), "Discard"));
	expect(document.getElementById("tab-diagnostics")?.getAttribute("aria-selected")).toBe("true");
});

test("focus follows the page when the form under it goes away, so the keyboard keeps working", () => {
	// The gone card replaces the form, taking the focused field with it. If
	// focus fell to the body it would be outside the shell that hears Esc, and
	// the reader's keyboard would stop working on a page still in front of them.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");

	pushToWebview(statePush(makeState({ servers: [] })));
	expect(page(root).contains(document.activeElement)).toBe(true);
	fireKeyDown(document.activeElement as HTMLElement, "Escape");
	expect(root.querySelector(".server-edit-page")).toBeNull();
});

test("a retry starts clean: the failure banner belongs to the round trip, not to the form", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");
	resetPosted();
	fireClick(buttonByText(page(root), "Save"));
	pushToWebview({
		kind: "fail",
		id: lastRequest("saveServerSetting").id,
		method: "saveServerSetting",
		message: "label: this label is reserved",
		failureKind: "validation",
	});
	expect(page(root).querySelector(".banner-error")).not.toBeNull();

	resetPosted();
	fireClick(buttonByText(page(root), "Save"));
	expect(page(root).querySelector(".banner-error")).toBeNull();
});

test("a commit freezes the entry it is committing, so its own push cannot re-arm Save", () => {
	// Saving a secret from secure into settings makes the pushed entry a
	// different shape - inline secrets prefill. If the page read that push
	// while its own save was still in flight, the form would restart its
	// prefill, leave the saving phase, and offer Save again before the first
	// ack: one click, two writes.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [declaredWithSecrets({ apiKey: "secure" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "API key"), "sk-typed-value");
	const settingsRadio = [...page(root).querySelectorAll<HTMLInputElement>("input[name='server-apiKey-where']")][1];
	fireCheck(settingsRadio as HTMLInputElement, true);
	resetPosted();
	fireClick(buttonByText(page(root), "Save"));
	const posted = lastRequest("saveServerSetting");

	// The write lands as a push before the ack.
	pushToWebview(statePush(makeState({ servers: [declaredWithSecrets({ apiKey: "settings" })] })));
	expect((buttonByText(page(root), "Saving...") as HTMLButtonElement).disabled).toBe(true);
	expect(
		postedMessages.filter((message) => (message as { method?: string }).method === "saveServerSetting")
	).toHaveLength(1);

	pushToWebview({ kind: "ack", id: posted.id, method: "saveServerSetting" });
	expect(root.querySelector(".server-edit-page")).toBeNull();
});

test("a deep link that arrives in the same tick as the first state still lands on its destination", () => {
	// panel.ts open() does reveal(), pushState(), flushPendingFocus() back to
	// back, so whether React commits between the push and the focus request is
	// the browser's business rather than a contract - and the render harness
	// dispatches a fixture's messages in one synchronous loop, which is why
	// every deep-linked fixture was shooting the Servers page instead of the
	// one it asked for. Delivering both inside one act reproduces that
	// ordering exactly.
	const root = mount(<App />);
	void act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: statePush(makeState()) }));
		window.dispatchEvent(new MessageEvent("message", { data: { kind: "focusSection", section: "diagnostics" } }));
	});

	expect(document.getElementById("tab-diagnostics")?.getAttribute("aria-selected")).toBe("true");
	expect((document.getElementById("panel-diagnostics") as HTMLElement).hidden).toBe(false);
	expect(root.querySelector(".server-edit-page")).toBeNull();
});

test("a deep link still asks a dirty page before taking the reader off it", () => {
	// The hardening must not cost the guard: recording the intent and applying
	// it on the next commit still routes through the same question a rail
	// click raises.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");

	pushToWebview({ kind: "focusSection", section: "usage" });
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(confirmDialog()).not.toBeNull();
	fireClick(buttonByText(openConfirmDialog(), "Discard"));
	expect(document.getElementById("tab-usage")?.getAttribute("aria-selected")).toBe("true");
});

test("a deep link that beats the first state push is remembered, not dropped", () => {
	// The order a real webview is most likely to take, and the one the old ref
	// read could not survive at all: the request arrives while the dashboard
	// is still the loading skeleton, so there is no guard to route it through
	// yet and nothing to apply it to.
	const root = mount(<App />);
	pushToWebview({ kind: "focusSection", section: "usage" });
	expect(root.querySelector(".rail")).not.toBeNull();

	pushToWebview(statePush(makeState()));
	expect(document.getElementById("tab-usage")?.getAttribute("aria-selected")).toBe("true");
	expect((document.getElementById("panel-usage") as HTMLElement).hidden).toBe(false);
});

test("a deep link that arrives with the push that deleted the entry lands where it asked", () => {
	// The nastiest ordering of the three: the reader is editing with unsaved
	// changes, one tick brings both the push that removes the entry and a deep
	// link elsewhere. The draft died with the entry, so there is nothing to
	// ask about - and the shell must know that before it decides, which it
	// only does if the page's report is current rather than a render behind.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");

	void act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: statePush(makeState({ servers: [] })) }));
		window.dispatchEvent(new MessageEvent("message", { data: { kind: "focusSection", section: "usage" } }));
	});

	expect(root.querySelector(".server-edit-page")).toBeNull();
	expect(confirmDialog()).toBeNull();
	expect(document.getElementById("tab-usage")?.getAttribute("aria-selected")).toBe("true");
});

test("the question is a real modal: alertdialog semantics, a scrim, and the safe answer holding focus", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");
	fireKeyDown(page(root), "Escape");

	const dialog = openConfirmDialog();
	expect(dialog.getAttribute("role")).toBe("alertdialog");
	expect(dialog.getAttribute("aria-modal")).toBe("true");
	// The question IS the dialog's accessible name.
	const labelledBy = dialog.getAttribute("aria-labelledby");
	expect(labelledBy).not.toBeNull();
	expect(document.getElementById(labelledBy as string)?.textContent).toBe("Discard unsaved changes?");
	// A scrim keeps the page below out of reach until the question is answered.
	expect(document.querySelector(".scrim.confirm-scrim")).not.toBeNull();
	// Default focus on the safe verb: Enter and Esc are the same answer.
	expect(document.activeElement).toBe(buttonByText(dialog, "Keep editing"));
	// The danger verb wears the danger rank, not a restyle.
	expect(buttonByText(dialog, "Discard").dataset.variant).toBe("danger");
	expect(buttonByText(dialog, "Keep editing").dataset.variant).toBe("default");
});

test("the dialog's Esc closes nothing else: the page below never hears the key", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");
	fireKeyDown(page(root), "Escape");
	const keep = buttonByText(openConfirmDialog(), "Keep editing");
	expect(document.activeElement).toBe(keep);

	// A bubble listener past the React root: if the dialog's stopPropagation
	// ever went missing, the shell's guard would hear the key and re-raise the
	// question this press just answered - and so would this listener.
	let leaked = false;
	const listener = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			leaked = true;
		}
	};
	window.addEventListener("keydown", listener);
	fireKeyDown(keep, "Escape");
	window.removeEventListener("keydown", listener);

	expect(leaked).toBe(false);
	expect(confirmDialog()).toBeNull();
	// One press peeled one surface: the page under the question is untouched.
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(inputByLabel(page(root), "Base URL").value).toBe("http://localhost:9999");
});

test("the dialog traps Tab both ways, so the page below is unreachable by keyboard", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");
	fireKeyDown(page(root), "Escape");
	const dialog = openConfirmDialog();
	const keep = buttonByText(dialog, "Keep editing");
	const discard = buttonByText(dialog, "Discard");

	const fireTab = (element: HTMLElement, shiftKey: boolean) => {
		void act(() => {
			element.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
		});
	};

	// Tab off the last control wraps to the first; Shift-Tab off the first
	// comes back around. The form's fields never get a turn.
	void act(() => discard.focus());
	fireTab(discard, false);
	expect(document.activeElement).toBe(keep);
	fireTab(keep, true);
	expect(document.activeElement).toBe(discard);
});

test("keep editing returns focus to the exact field the question interrupted", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	const field = inputByLabel(page(root), "Base URL");
	fireInput(field, "http://localhost:9999");
	// happy-dom's click never focuses, so the reader's place is set by hand.
	void act(() => field.focus());

	fireKeyDown(field, "Escape");
	expect(document.activeElement).toBe(buttonByText(openConfirmDialog(), "Keep editing"));
	fireClick(buttonByText(openConfirmDialog(), "Keep editing"));
	expect(confirmDialog()).toBeNull();
	expect(document.activeElement).toBe(field);
});

test("a hover tip left open under the modal cannot steal its Esc: one press answers the question", () => {
	// The tip's own Esc lives on a window-capture listener, so a bubble-phase
	// dialog would lose the race: the press would peel a tip the scrim already
	// buried while the reader stares at an unanswered question. The dialog
	// listens on window capture too, and stopPropagation skips other NODES,
	// not other listeners on the same window - so the tip still closes, WITH
	// the press rather than instead of it.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod" })] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");
	const helpWrap = page(root).querySelector(".help-wrap") as HTMLElement;
	fireMouseEnter(helpWrap);
	expect(helpWrap.querySelector(".tip-bubble")?.getAttribute("data-open")).toBe("true");

	// A deep link raises the question with the hover-held tip still open: the
	// pointer never moved, so nothing told the tip to close.
	pushToWebview({ kind: "focusSection", section: "usage" });
	const dialog = openConfirmDialog();

	fireKeyDown(document.activeElement as HTMLElement, "Escape");
	expect(confirmDialog()).toBeNull();
	expect(helpWrap.querySelector(".tip-bubble")?.hasAttribute("data-open")).toBe(false);
	expect(root.querySelector(".server-edit-page")).not.toBeNull();
	expect(dialog.isConnected).toBe(false);
});

test("a benign state push under the open question leaves it standing", () => {
	// The extension re-pushes the whole state on every store change; a sync
	// finishing while the reader weighs the question must not blink it away.
	const server = makeDeclaredServer({ label: "Prod" });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [server] })));
	fireClick(buttonByText(root, "Edit"));
	fireInput(inputByLabel(page(root), "Base URL"), "http://localhost:9999");
	fireKeyDown(page(root), "Escape");
	expect(confirmDialog()).not.toBeNull();

	pushToWebview(statePush(makeState({ servers: [server] })));
	expect(confirmDialog()).not.toBeNull();
	fireClick(buttonByText(openConfirmDialog(), "Keep editing"));
	expect(inputByLabel(page(root), "Base URL").value).toBe("http://localhost:9999");
});
