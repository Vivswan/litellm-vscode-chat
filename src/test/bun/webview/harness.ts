/**
 * Shared harness for the bun + happy-dom webview suite. Owns the three
 * process-global concerns so individual tests cannot forget them: the
 * acquireVsCodeApi stub (postMessage capture), act()-wrapped rendering and
 * event dispatch (assertions must never race React's scheduler), and the
 * secret-leak sweep. postedMessages is process-global because vscodeApi.ts
 * caches the api at import time; resetPosted() in beforeEach is mandatory.
 *
 * Event dispatch goes through React's delegation model: onFocus/onBlur are
 * focusin/focusout at the root, onMouseEnter derives from mouseover, and
 * controlled inputs carry a value tracker on the instance that deduplicates
 * events whose value it already saw - so value/checked writes here go through
 * the prototype setter, bypassing the tracker, and checkboxes toggle via a
 * real click.
 */
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
	DashboardMethod,
	ReadMethod,
	ResponseFor,
	RpcRequest,
	RpcRequestType,
} from "../../../dashboard/endpoints";

/** Every message the page posted to the (stubbed) extension host, in order. */
export const postedMessages: RpcRequestType[] = [];

export function resetPosted(): void {
	postedMessages.length = 0;
}

/** Install the acquireVsCodeApi global; called once from the preload. */
export function installAcquireVsCodeApi(): void {
	(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
		postMessage(message: unknown): void {
			postedMessages.push(message as RpcRequestType);
		},
	});
}

const roots = new Map<HTMLElement, Root>();

/** Render a component tree into a fresh container under document.body. */
export function mount(vnode: ReactNode): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.set(container, root);
	void act(() => {
		root.render(vnode);
	});
	return container;
}

/** Re-render into a container mount() returned (controlled-component prop updates). */
export function render(vnode: ReactNode, container: HTMLElement): void {
	const root = roots.get(container);
	if (root === undefined) {
		throw new Error("render target was not mounted by this harness");
	}
	void act(() => {
		root.render(vnode);
	});
}

/** Unmount and remove every container this file mounted; call in afterEach. */
export function cleanup(): void {
	for (const [container, root] of Array.from(roots.entries())) {
		void act(() => {
			root.unmount();
		});
		roots.delete(container);
		container.remove();
	}
}

/** Dispatch a window message the way the extension host delivers pushes. */
export function pushToWebview(message: unknown): void {
	void act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: message }));
	});
}

/** The posted requests of one method, in order; tests correlate through these instead of minting ids. */
export function postedRequests<K extends DashboardMethod>(method: K): RpcRequest<K>[] {
	// The cast rebuilds the method-payload correlation the union filter proves
	// but TypeScript cannot carry through a generic predicate.
	return postedMessages.filter((message) => message.method === method) as RpcRequest<K>[];
}

/** The posted requests reduced to method plus payload; ids are webview-minted and opaque to assertions. */
export function postedCalls(): { method: DashboardMethod; payload: unknown }[] {
	return postedMessages.map(({ method, payload }) => ({ method, payload }));
}

/** The latest posted request of one method; fails the test when none was posted. */
export function lastRequest<K extends DashboardMethod>(method: K): RpcRequest<K> {
	const requests = postedRequests(method);
	const last = requests.at(-1);
	if (last === undefined) {
		throw new Error(`no ${method} request was posted`);
	}
	return last;
}

/** Deliver one read's response envelope for the given posted request. */
export function respondTo<K extends ReadMethod>(request: RpcRequest<K>, payload: ResponseFor<K>): void {
	pushToWebview({ kind: "response", id: request.id, method: request.method, payload });
}

/**
 * Write value/checked through the prototype setter. React's value tracker
 * redefines the property on the instance and records every write it sees; a
 * write it saw is "no change" to the change plugin, so the event that follows
 * it would be swallowed. The prototype setter is the original happy-dom one.
 */
function setThroughPrototype(element: Element, property: "value" | "checked", next: string | boolean): void {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), property);
	if (descriptor?.set === undefined) {
		throw new Error(`no prototype setter for ${property} on <${element.tagName.toLowerCase()}>`);
	}
	descriptor.set.call(element, next);
}

/** Set an input's value and fire the input event React's onChange listens for. */
export function fireInput(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	void act(() => {
		setThroughPrototype(element, "value", value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** React maps onBlur to the bubbling focusout event and delegates it at the root. */
export function fireBlur(element: HTMLElement, relatedTarget?: HTMLElement): void {
	void act(() => {
		element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: relatedTarget ?? null }));
	});
}

/** React maps onFocus to the bubbling focusin event and delegates it at the root. */
export function fireFocus(element: HTMLElement): void {
	void act(() => {
		element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
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

/** React synthesizes onMouseEnter from the bubbling mouseover event. */
export function fireMouseEnter(element: HTMLElement): void {
	void act(() => {
		element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
	});
}

/**
 * React synthesizes onMouseLeave from the bubbling mouseout event, and only
 * when relatedTarget - where the pointer went - sits outside the listened
 * element's subtree. Passing a descendant as `to` therefore exercises the
 * pointer moving deeper (a trigger's own tooltip bubble, say) and must NOT
 * fire onMouseLeave; the default, document.body, is a plain departure.
 */
export function fireMouseLeave(element: HTMLElement, to?: HTMLElement): void {
	void act(() => {
		element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: to ?? document.body }));
	});
}

/**
 * Resize happy-dom's viewport, firing matchMedia change listeners and the
 * window resize event. act()-wrapped because components subscribe to both.
 * happy-dom's default is 1024x768; a suite that shrinks the viewport must
 * restore it in afterEach, or every later suite inherits the narrow window.
 */
export function setViewport(width: number, height: number): void {
	const happy = (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } })
		.happyDOM;
	void act(() => {
		happy.setViewport({ width, height });
	});
}

export function fireClick(element: HTMLElement): void {
	void act(() => {
		element.click();
	});
}

/**
 * Tick or untick a checkbox / select a radio. React fires a checkbox's
 * onChange from its click event, and happy-dom's click runs the native
 * activation behavior (toggling checked internally, unseen by the tracker),
 * so the click is the whole gesture. A call that asks for the state the box
 * is already in is a test bug (the click would toggle the wrong way), so it
 * fails loud instead of guessing.
 */
export function fireCheck(element: HTMLInputElement, checked: boolean): void {
	if (element.checked === checked) {
		throw new Error(`fireCheck asked for ${String(checked)} but the ${element.type} is already ${String(checked)}`);
	}
	void act(() => {
		element.click();
	});
}

/** Pick a select's option by value and fire the change event React listens for. */
export function fireSelect(element: HTMLSelectElement, value: string): void {
	void act(() => {
		setThroughPrototype(element, "value", value);
		element.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

export function fireKeyDown(element: HTMLElement, key: string): void {
	// cancelable, like the real thing: a handler that answers a key with
	// preventDefault (Radix's dismissal layers read defaultPrevented to decide
	// whether to act) would otherwise be silently overruled here and nowhere
	// else.
	void act(() => {
		element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
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
				const idPart = element.id === "" ? "" : ` id="${element.id}"`;
				findings.push(`attribute ${attribute.name} on <${element.tagName.toLowerCase()}${idPart}>`);
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

/** One element's contribution to an accessible name: its text nodes in tree order, aria-hidden subtrees excluded. */
function visibleTextOf(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return node.textContent ?? "";
	}
	if (node instanceof Element) {
		if (node.getAttribute("aria-hidden") === "true") {
			return "";
		}
		let text = "";
		for (const child of Array.from(node.childNodes)) {
			text += visibleTextOf(child);
		}
		return text;
	}
	return "";
}

/**
 * A directly referenced target's text, the accname root-reference exception:
 * a node named by aria-labelledby/aria-describedby is read even when it is
 * itself aria-hidden (the tooltip bubble's whole wiring, ui/tip.tsx), while
 * aria-hidden subtrees INSIDE it stay excluded like everywhere else.
 */
function referencedTextOf(target: Element): string {
	let text = "";
	for (const child of Array.from(target.childNodes)) {
		text += visibleTextOf(child);
	}
	return text;
}

/**
 * The accessible name a control computes, the way the a11y tree would:
 * aria-labelledby, then aria-label, then the subtree's text nodes in tree
 * order with aria-hidden subtrees excluded, whitespace-collapsed. Deliberately
 * blind to CSS: happy-dom runs no layout, so a subtree hidden only by a
 * visibility utility still contributes here - which is what lets an assertion
 * on this name catch a width twin that lost its aria-hidden while keeping
 * `invisible` (textContent, which ignores both, cannot).
 */
export function accessibleNameOf(element: HTMLElement): string {
	const labelledBy = element.getAttribute("aria-labelledby");
	if (labelledBy !== null) {
		return labelledBy
			.split(/\s+/)
			.map((id) => {
				const target = document.getElementById(id);
				return target === null ? "" : referencedTextOf(target);
			})
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
	}
	const label = element.getAttribute("aria-label");
	if (label !== null) {
		return label.replace(/\s+/g, " ").trim();
	}
	return visibleTextOf(element).replace(/\s+/g, " ").trim();
}

/**
 * An element's accessible DESCRIPTION: the aria-describedby targets' text, in
 * order, modeled like accessibleNameOf above - aria-hidden subtrees excluded,
 * with the same root-reference exception for the targets themselves.
 */
export function accessibleDescriptionOf(element: HTMLElement): string {
	return (element.getAttribute("aria-describedby") ?? "")
		.split(/\s+/)
		.filter((id) => id.length > 0)
		.map((id) => {
			const target = document.getElementById(id);
			return target === null ? "" : referencedTextOf(target);
		})
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
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
