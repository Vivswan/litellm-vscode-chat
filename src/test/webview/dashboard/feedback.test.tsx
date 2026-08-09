/**
 * The intent feedback layer: success toasts for the server intents (their
 * lifecycle - appear, auto-dismiss, manual dismiss), failure banners with
 * their Dismiss wiring, and the busy spinner inside an in-flight Save.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import type { WebviewToExtensionMessage } from "../../../extension/dashboard/protocol";
import { App } from "../../../webview/dashboard/app";
import { makeDeclaredServer, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
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

function toastTexts(root: ParentNode): string[] {
	return Array.from(root.querySelectorAll(".toast span")).map((el) => (el.textContent ?? "").trim());
}

test("a save success raises a toast in the polite live region and its own caveat rides along", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	expect(root.querySelector(".toasts")?.getAttribute("aria-live")).toBe("polite");

	pushToWebview({ type: "intentSucceeded", intentType: "saveServerSetting", requestId: "r1" });
	expect(toastTexts(root)).toEqual(["Server saved"]);

	pushToWebview({ type: "intentSucceeded", intentType: "removeServerSetting", requestId: "r2" });
	expect(toastTexts(root)).toEqual(["Server saved", "Server removed"]);

	pushToWebview({
		type: "intentSucceeded",
		intentType: "saveServerSetting",
		requestId: "r3",
		message: "The old group still exists.",
	});
	expect(toastTexts(root)).toContain("Server saved. The old group still exists.");
});

test("scalar and record intents stay silent on success; their change is the feedback", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	pushToWebview({ type: "intentSucceeded", intentType: "setModelParameters", requestId: "r1" });
	pushToWebview({ type: "intentSucceeded", intentType: "setNumberSetting", requestId: "r2" });
	expect(toastTexts(root)).toEqual([]);
});

test("a toast dismisses on click and expires on its own after the configured duration", async () => {
	const root = mount(<App toastDurationMs={30} />);
	pushToWebview(statePush(makeState()));

	pushToWebview({ type: "intentSucceeded", intentType: "removeServerSetting", requestId: "r1" });
	expect(toastTexts(root)).toEqual(["Server removed"]);
	fireClick(root.querySelector(".toast button[aria-label='Dismiss notification']") as HTMLElement);
	expect(toastTexts(root)).toEqual([]);

	pushToWebview({ type: "intentSucceeded", intentType: "removeServerSetting", requestId: "r2" });
	expect(toastTexts(root)).toEqual(["Server removed"]);
	await new Promise((resolve) => setTimeout(resolve, 80));
	await act(() => {});
	expect(toastTexts(root)).toEqual([]);
});

test("a failure renders as an alert banner, never a toast, and Dismiss clears it", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	pushToWebview({
		type: "intentFailed",
		intentType: "removeServerSetting",
		message: "the settings write was refused",
		kind: "validation",
		requestId: "r1",
	});

	expect(toastTexts(root)).toEqual([]);
	const banner = root.querySelector(".banner.banner-error[role='alert']");
	expect(banner?.textContent).toContain("Removing failed: the settings write was refused");
	fireClick(buttonByText(banner as HTMLElement, "Dismiss"));
	expect(root.querySelector(".banner.banner-error[role='alert']")).toBeNull();
});

test("the in-flight Save disables and shows the busy spinner until its ack lands", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	fireClick(buttonByText(root, "Add your first server"));
	fireInput(inputByLabel(root, "Label"), "Prod");
	fireInput(inputByLabel(root, "Base URL"), "http://localhost:4000");
	resetPosted();
	fireClick(buttonByText(root, "Save"));

	const saving = buttonByText(root, "Saving...");
	expect(saving.disabled).toBe(true);
	expect(saving.querySelector(".spinner")).not.toBeNull();

	const posted = postedMessages[0] as Extract<WebviewToExtensionMessage, { type: "saveServerSetting" }>;
	pushToWebview({ type: "intentSucceeded", intentType: "saveServerSetting", requestId: posted.requestId });
	expect(root.querySelector(".slide-over")).toBeNull();
	expect(toastTexts(root)).toEqual(["Server saved"]);
});

test("the toast stack caps at three, dropping the oldest first", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	for (const id of ["r1", "r2", "r3", "r4"]) {
		pushToWebview({ type: "intentSucceeded", intentType: "saveServerSetting", requestId: id });
	}
	// Four successes, three toasts: the first one was dropped.
	expect(toastTexts(root)).toEqual(["Server saved", "Server saved", "Server saved"]);
	expect(root.querySelectorAll(".toast").length).toBe(3);
});

test("a late adopt ack still raises its toast with no form open (closing a form mid-adopt relies on this)", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	pushToWebview({ type: "intentSucceeded", intentType: "adoptServer", requestId: "after-close-anyway" });
	expect(toastTexts(root)).toEqual(["Server adopted"]);
});
