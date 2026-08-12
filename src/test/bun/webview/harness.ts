/**
 * Shared harness for the bun + happy-dom webview suite. Owns the three
 * process-global concerns so individual tests cannot forget them: the
 * acquireVsCodeApi stub (postMessage capture), act()-wrapped rendering and
 * event dispatch (assertions must never race preact's scheduler), and the
 * secret-leak sweep. postedMessages is process-global because vscodeApi.ts
 * caches the api at import time; resetPosted() in beforeEach is mandatory.
 */
import type { ComponentChild } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { WebviewToExtensionMessage } from "../../../dashboard/protocol";

/** Every message the page posted to the (stubbed) extension host, in order. */
export const postedMessages: WebviewToExtensionMessage[] = [];

export function resetPosted(): void {
	postedMessages.length = 0;
}

/** Install the acquireVsCodeApi global; called once from the preload. */
export function installAcquireVsCodeApi(): void {
	(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
		postMessage(message: unknown): void {
			postedMessages.push(message as WebviewToExtensionMessage);
		},
	});
}

const containers: HTMLElement[] = [];

/** Render a component tree into a fresh container under document.body. */
export function mount(vnode: ComponentChild): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	containers.push(container);
	void act(() => {
		render(vnode, container);
	});
	return container;
}

/** Unmount and remove every container this file mounted; call in afterEach. */
export function cleanup(): void {
	for (const container of containers.splice(0)) {
		void act(() => {
			render(null, container);
		});
		container.remove();
	}
}

/** Dispatch a window message the way the extension host delivers pushes. */
export function pushToWebview(message: unknown): void {
	void act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: message }));
	});
}

/** Set an input's value and fire the input event preact listens for. */
export function fireInput(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	void act(() => {
		element.value = value;
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

export function fireBlur(element: HTMLElement): void {
	void act(() => {
		element.dispatchEvent(new Event("blur"));
	});
}

export function fireFocus(element: HTMLElement): void {
	void act(() => {
		element.dispatchEvent(new Event("focus"));
	});
}

/**
 * Pin an element's measured geometry. happy-dom performs no layout, so
 * getBoundingClientRect always returns zeros; placement tests substitute
 * realistic geometry on the trigger before dispatching the hover or focus
 * event that measures it. right/width/x/y are derived; the placement code
 * only reads left, top, and bottom.
 */
export function stubBoundingRect(element: HTMLElement, rect: { left: number; top: number; bottom: number }): void {
	const full = {
		...rect,
		right: rect.left,
		width: 0,
		height: rect.bottom - rect.top,
		x: rect.left,
		y: rect.top,
		toJSON: () => ({}),
	};
	element.getBoundingClientRect = () => full as DOMRect;
}

export function fireMouseEnter(element: HTMLElement): void {
	void act(() => {
		element.dispatchEvent(new Event("mouseenter"));
	});
}

export function fireClick(element: HTMLElement): void {
	void act(() => {
		element.click();
	});
}

/** Tick or untick a checkbox / select a radio and fire its change event. */
export function fireCheck(element: HTMLInputElement, checked: boolean): void {
	void act(() => {
		element.checked = checked;
		element.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

/** Pick a select's option by value and fire the change event preact listens for. */
export function fireSelect(element: HTMLSelectElement, value: string): void {
	void act(() => {
		element.value = value;
		element.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

export function fireKeyDown(element: HTMLElement, key: string): void {
	void act(() => {
		element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	});
}

/**
 * Everywhere a secret could surface in the page. Serialized HTML alone is not
 * enough: a value assigned to an input via JS never appears in outerHTML, so
 * an HTML sweep passes trivially against a real leak. Every sentinel
 * assertion therefore checks input/textarea value properties, all attributes,
 * and textContent as well. Returns human-readable findings; assert equality
 * with [] so a failure names the leak site.
 */
export function findSentinel(sentinel: string): string[] {
	const findings: string[] = [];
	const html = document.documentElement.outerHTML;
	if (html.includes(sentinel)) {
		findings.push("serialized document HTML");
	}
	if (document.documentElement.textContent?.includes(sentinel)) {
		findings.push("document textContent");
	}
	for (const element of Array.from(document.querySelectorAll("*"))) {
		for (const attribute of Array.from(element.attributes)) {
			if (attribute.value.includes(sentinel)) {
				findings.push(`attribute ${attribute.name} on <${element.tagName.toLowerCase()}>`);
			}
		}
	}
	for (const element of Array.from(document.querySelectorAll("input, textarea"))) {
		const value = (element as HTMLInputElement | HTMLTextAreaElement).value;
		if (value.includes(sentinel)) {
			findings.push(`.value of <${element.tagName.toLowerCase()} id="${element.id}">`);
		}
	}
	return findings;
}

/** The rendered text of the first element matching the selector, trimmed. */
export function textOf(root: ParentNode, selector: string): string {
	const element = root.querySelector(selector);
	if (element === null) {
		throw new Error(`no element matches ${selector}`);
	}
	return (element.textContent ?? "").trim();
}

/** The button whose visible text matches exactly, after trimming. */
export function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
	const button = Array.from(root.querySelectorAll("button")).find(
		(candidate) => (candidate.textContent ?? "").trim() === text
	);
	if (button === undefined) {
		throw new Error(`no button with text "${text}"`);
	}
	return button as HTMLButtonElement;
}

/** The input whose associated label text matches exactly (for/id pairing). */
export function inputByLabel(root: ParentNode, labelText: string): HTMLInputElement {
	const label = Array.from(root.querySelectorAll("label")).find(
		(candidate) => (candidate.textContent ?? "").trim() === labelText
	);
	const id = label?.getAttribute("for");
	if (id === null || id === undefined) {
		throw new Error(`no label "${labelText}" with a for attribute`);
	}
	const input = root.querySelector(`#${CSS.escape(id)}`);
	if (!(input instanceof HTMLInputElement)) {
		throw new Error(`label "${labelText}" does not point at an input`);
	}
	return input;
}
