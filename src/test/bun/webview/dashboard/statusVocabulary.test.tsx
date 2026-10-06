/**
 * The webview half of the cross-surface serving-vocabulary pin (the host suite covers the status bar, notifier, paste
 * line, and the state-builder mirror; src/test/statusVocabulary.ts is the shared table): for every window state, the
 * hero's word and tone and the server rows' pills - words AND dot tones - must say what the table says.
 */
import { afterEach, expect, test } from "bun:test";
import { classifyOverall } from "../../../../dashboard/presenters";
import { overallState } from "../../../../webview/dashboard/app";
import type { ServerPillWord } from "../../../../webview/dashboard/servers";
import { ServersSection } from "../../../../webview/dashboard/servers";
import { type ALL_PILL_WORDS, rowVerdict, WINDOW_STATE_ROWS } from "../../../statusVocabulary";
import { cleanup, mount } from "../harness";

/**
 * The table's word list against the webview vocabulary, compile-pinned both ways: a word added on either side fails
 * this assignment until the other side lists it. This project can reach the .tsx module; the host-importable table
 * cannot, which is why the pin lives here rather than beside the list.
 */
const _pillWordsMatchVocabulary: [
	Exclude<ServerPillWord, (typeof ALL_PILL_WORDS)[number]>,
	Exclude<(typeof ALL_PILL_WORDS)[number], ServerPillWord>,
] extends [never, never]
	? true
	: never = true;

/** The element's direct text, child elements (the pill's dot and time) excluded. */
function ownText(node: Element): string {
	return [...node.childNodes]
		.filter((child) => child.nodeType === Node.TEXT_NODE)
		.map((child) => child.textContent ?? "")
		.join("")
		.trim();
}

afterEach(() => {
	cleanup();
});

test("the hero reads each window state with the table's word and tone", () => {
	for (const row of WINDOW_STATE_ROWS) {
		// The owner's rows for the row's window (the host suite pins the real builder to the same owner) and the
		// merged served count (the table's totalModels pins it to the builder's servedModelCount).
		const rows = rowVerdict(row).rows();
		expect(classifyOverall(rows), row.name).toBe(row.expect.verdict);
		const hero = overallState(rows, row.totalModels);
		expect(hero.word, `${row.name}: hero word`).toBe(row.expect.hero.word);
		expect(hero.tone, `${row.name}: hero tone`).toBe(row.expect.hero.tone);
	}
});

test("the row pills say each window state with the table's words and tones", () => {
	for (const row of WINDOW_STATE_ROWS) {
		const root = mount(
			<ServersSection
				currencySymbol="$"
				servers={row.rows}
				now={Date.parse("2026-07-26T00:05:00.000Z")}
				onEditServer={() => {}}
				onAdoptServer={() => {}}
				onAddServer={() => {}}
			/>
		);
		const pills = [...root.querySelectorAll(".server-list .server-row .pill")];
		expect(pills.length, `${row.name}: pill count`).toBe(row.expect.pills.length);
		row.expect.pills.forEach((expected, index) => {
			const pill = pills[index];
			if (pill === undefined) {
				throw new Error(`${row.name}: pill ${index} missing`);
			}
			// The word alone and exactly: a substring check would let "Connected" pass on a rendered "Not Connected",
			// and the pill's time span ride in.
			expect(ownText(pill), `${row.name}: pill ${index} word`).toBe(expected.word);
			expect(pill.classList.contains(`tone-${expected.tone}`), `${row.name}: pill ${index} tone-${expected.tone}`).toBe(
				true
			);
		});
		cleanup();
	}
});
