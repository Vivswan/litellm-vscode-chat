/**
 * The uncontrolled secret input's own contract, proven at the primitive: the value lives in
 * the node's value PROPERTY and nowhere else (findSentinel sweeps attributes, value
 * properties, serialized HTML, and textContent), through prefill, typing, re-renders,
 * reset, external replacement, and unmount. The form-level flows live in secrets.test.tsx.
 */
import { afterEach, expect, test } from "bun:test";
import { useState } from "react";
import { SecretInput } from "../../../../../webview/dashboard/ui/secretInput";
import { cleanup, findSentinel, fireInput, mount, render } from "../../harness";

const SECRET = "sk-PRIMITIVE-4242-do-not-render";
const TYPED = "sk-PRIMITIVE-TYPED-4242";

afterEach(() => {
	cleanup();
});

function input(root: ParentNode): HTMLInputElement {
	const node = root.querySelector("input");
	if (node === null) {
		throw new Error("no input rendered");
	}
	return node as HTMLInputElement;
}

/** The one legal residence: the input's value property, and only there. */
function expectOnlyInValueProperty(secret: string): void {
	expect(findSentinel(secret)).toEqual(['.value of <input id="secret-under-test">']);
}

test("an initial prefill lands in the value property only - never in any attribute or serialization", () => {
	const root = mount(<SecretInput id="secret-under-test" type="password" value={SECRET} onValueChange={() => {}} />);
	expect(input(root).value).toBe(SECRET);
	expect(input(root).getAttribute("value")).toBeNull();
	expectOnlyInValueProperty(SECRET);
});

test("typing reports through onValueChange and the echoed re-render leaves the node alone", () => {
	// The harness parent below is the form's shape in miniature: state in, value prop back.
	function Harness({ onValue }: { onValue: (next: string) => void }) {
		const [value, setValue] = useState(SECRET);
		return (
			<SecretInput
				id="secret-under-test"
				type="password"
				value={value}
				onValueChange={(next) => {
					setValue(next);
					onValue(next);
				}}
			/>
		);
	}
	const seen: string[] = [];
	const root = mount(<Harness onValue={(next) => seen.push(next)} />);
	expectOnlyInValueProperty(SECRET);

	fireInput(input(root), TYPED);
	// The submit read-out: what the parent state holds is exactly what was typed.
	expect(seen).toEqual([TYPED]);
	expect(input(root).value).toBe(TYPED);
	expect(input(root).getAttribute("value")).toBeNull();
	expectOnlyInValueProperty(TYPED);
	expect(findSentinel(SECRET)).toEqual([]);
});

test("a re-render with unrelated prop changes keeps the value in the property, still attribute-free", () => {
	const root = mount(<SecretInput id="secret-under-test" type="password" value={SECRET} onValueChange={() => {}} />);
	// The reveal toggle's shape: same value, a different type (and disabled flip).
	render(<SecretInput id="secret-under-test" type="text" value={SECRET} onValueChange={() => {}} />, root);
	expect(input(root).type).toBe("text");
	expectOnlyInValueProperty(SECRET);
	render(
		<SecretInput id="secret-under-test" type="password" value={SECRET} disabled={true} onValueChange={() => {}} />,
		root
	);
	expect(input(root).disabled).toBe(true);
	expectOnlyInValueProperty(SECRET);
});

test("an external value change overwrites the node: prefill landing and discard/reset are this one move", () => {
	const root = mount(<SecretInput id="secret-under-test" type="password" value="" onValueChange={() => {}} />);
	expect(input(root).value).toBe("");

	// The prefill's shape: the parent state changes without a keystroke.
	render(<SecretInput id="secret-under-test" type="password" value={SECRET} onValueChange={() => {}} />, root);
	expect(input(root).value).toBe(SECRET);
	expectOnlyInValueProperty(SECRET);

	// The reset's shape: the parent state empties; no residue anywhere.
	render(<SecretInput id="secret-under-test" type="password" value="" onValueChange={() => {}} />, root);
	expect(input(root).value).toBe("");
	expect(findSentinel(SECRET)).toEqual([]);
});

test("unmounting removes the node - the value's one residence - from the document", () => {
	const root = mount(<SecretInput id="secret-under-test" type="password" value={SECRET} onValueChange={() => {}} />);
	const node = input(root);
	expectOnlyInValueProperty(SECRET);
	cleanup();
	expect(document.contains(node)).toBe(false);
	expect(findSentinel(SECRET)).toEqual([]);
});

test("a non-fresh spread cannot smuggle defaultValue back through the primitive", () => {
	const smuggled = {
		id: "secret-under-test",
		type: "password",
		value: SECRET,
		onValueChange: () => {},
		defaultValue: SECRET,
	};
	// @ts-expect-error: defaultValue is never-typed, so a spread (which skips excess-property checks) still fails
	const element = <SecretInput {...smuggled} />;
	expect(element).toBeDefined();
});
