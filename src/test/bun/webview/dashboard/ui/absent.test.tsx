/**
 * The Absent primitive - a dim dash plus its reason, never a zero - pinned on the accessibility shape a copy drifts
 * on: the dash is decoration (aria-hidden) and the words always ride along, hidden by default and replaced by the
 * caller's visible node when one speaks.
 */
import { afterEach, expect, test } from "bun:test";
import { AbsentDatum } from "../../../../../webview/dashboard/ui/absent";
import { cleanup, mount } from "../../harness";

afterEach(cleanup);

test("the dash is aria-hidden and the default reason is screen-reader-only", () => {
	const root = mount(<AbsentDatum className="hint" />);
	const wrapper = root.querySelector("span.hint");
	expect(wrapper?.querySelector('[aria-hidden="true"]')?.textContent).toBe("-");
	expect(wrapper?.querySelector(".sr-only")?.textContent).toBe("not reported");
});

test("a reason replaces the default text but keeps the hidden register", () => {
	const root = mount(<AbsentDatum className="text-muted-foreground" reason="no parameters resolved" />);
	const wrapper = root.querySelector("span.text-muted-foreground");
	expect(wrapper?.querySelector('[aria-hidden="true"]')?.textContent).toBe("-");
	expect(wrapper?.querySelector(".sr-only")?.textContent).toBe("no parameters resolved");
});

test("a visible child stands in for the hidden reason entirely", () => {
	const root = mount(
		<AbsentDatum className="hint">
			<span className="why">the key does not report one</span>
		</AbsentDatum>
	);
	const wrapper = root.querySelector("span.hint");
	expect(wrapper?.querySelector('[aria-hidden="true"]')?.textContent).toBe("-");
	// The visible words are the reason; a hidden duplicate would be read twice.
	expect(wrapper?.querySelector(".sr-only")).toBeNull();
	expect(wrapper?.querySelector(".why")?.textContent).toBe("the key does not report one");
});
