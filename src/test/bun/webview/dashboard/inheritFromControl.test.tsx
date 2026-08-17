/**
 * The Inherits control's keys-mode entry pin: choosing "only listed records" must write NOTHING until a key is
 * typed. An empty `_inherit_from` list IS the barrier, so auto-writing [] on the mode switch would snap the select
 * to "nothing - barrier" and make keys mode unreachable from scratch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { PrefixGroup } from "../../../../dashboard/recordDraft";
import { newParamRow } from "../../../../dashboard/recordDraft";
import { RecordMatcherEditorOverlay } from "../../../../webview/dashboard/recordEditors";
import { cleanup, fireInput, mount, render, resetPosted } from "../harness";

beforeEach(resetPosted);
afterEach(cleanup);

/** The control under test lives in the matcher editor overlay; one group at a time, wrapped back into the list. */
function Harness({ groups, onChange }: { groups: readonly PrefixGroup[]; onChange: (next: PrefixGroup[]) => void }) {
	return (
		<RecordMatcherEditorOverlay
			kind="params"
			group={groups[0] as PrefixGroup}
			fallbackFocusId="x"
			note="note"
			onChange={(next) => onChange([next])}
			onRemove={() => onChange([])}
			onClose={() => undefined}
		/>
	);
}

describe("InheritFromControl keys mode", () => {
	test("entering keys mode writes nothing; the first typed key writes the list; emptying drops the row", () => {
		let groups: PrefixGroup[] = [{ prefix: "gpt-5.6", params: [newParamRow("temperature", "0.3")] }];
		const writes: PrefixGroup[][] = [];
		const onChange = (next: PrefixGroup[]) => {
			writes.push(next);
			groups = next;
		};
		const root = mount(<Harness groups={groups} onChange={onChange} />);
		const select = root.querySelector<HTMLSelectElement>(".inherit-from select");
		if (select === null) {
			throw new Error("no inherit-from select");
		}
		// Switch to keys mode: NO write, the input appears, the select stays put.
		void act(() => {
			select.value = "keys";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(writes).toHaveLength(0);
		expect(select.value).toBe("keys");
		const keys = root.querySelector<HTMLInputElement>(".inherit-keys");
		if (keys === null) {
			throw new Error("keys input did not appear");
		}
		// The first key writes the list.
		fireInput(keys, "gpt-5*");
		expect(writes).toHaveLength(1);
		expect(writes[0]?.[0]?.params.some((p) => p.key === "_inherit_from" && p.valueText === '["gpt-5*"]')).toBe(true);
		// Re-render over the written groups (the editors are controlled).
		void act(() => {
			render(<Harness groups={groups} onChange={onChange} />, root);
		});
		// Emptying the input drops the row instead of writing [].
		const keysAgain = root.querySelector<HTMLInputElement>(".inherit-keys");
		if (keysAgain === null) {
			throw new Error("keys input vanished");
		}
		fireInput(keysAgain, "");
		const last = writes.at(-1);
		expect(last?.[0]?.params.some((p) => p.key === "_inherit_from")).toBe(false);
	});

	test("emptying a STORED keys row keeps the input mounted instead of unmounting it mid-edit", () => {
		// A keys row loaded from the store enters edit with the local pending
		// flag false; dropping the row on empty must set it, or the input
		// vanishes under the user's cursor and the select snaps to default.
		let groups: PrefixGroup[] = [
			{
				prefix: "gpt-5.6",
				params: [newParamRow("temperature", "0.3"), newParamRow("_inherit_from", '["gpt-5*"]')],
			},
		];
		const onChange = (next: PrefixGroup[]) => {
			groups = next;
		};
		const root = mount(<Harness groups={groups} onChange={onChange} />);
		const keys = root.querySelector<HTMLInputElement>(".inherit-keys");
		if (keys === null) {
			throw new Error("stored keys row did not render its input");
		}
		fireInput(keys, "");
		expect(groups[0]?.params.some((p) => p.key === "_inherit_from")).toBe(false);
		void act(() => {
			render(<Harness groups={groups} onChange={onChange} />, root);
		});
		const select = root.querySelector<HTMLSelectElement>(".inherit-from select");
		expect(select?.value).toBe("keys");
		expect(root.querySelector<HTMLInputElement>(".inherit-keys")).not.toBeNull();
	});
});
