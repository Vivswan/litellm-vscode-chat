/**
 * The webview half of the cross-surface serving-vocabulary pin (the host suite
 * covers the status bar, notifier, paste line, and the state-builder mirror;
 * src/test/statusVocabulary.ts is the shared table): for every window state,
 * the hero's word and tone and the server rows' pills - words AND dot tones -
 * must say what the table says, and coverage fails closed.
 */
import { afterEach, expect, test } from "bun:test";
import { classifyOverall } from "../../../../dashboard/presenters";
import { overallState } from "../../../../webview/dashboard/app";
import { ServersSection } from "../../../../webview/dashboard/servers";
import {
	aggregateContradictions,
	uncoveredPills,
	uncoveredVerdicts,
	WINDOW_STATE_ROWS,
} from "../../../statusVocabulary";
import { cleanup, mount } from "../harness";

afterEach(() => {
	cleanup();
});

test("the table's own expectations are class-consistent (no surface may contradict another)", () => {
	for (const row of WINDOW_STATE_ROWS) {
		expect(aggregateContradictions(row), row.name).toEqual([]);
	}
});

test("coverage fails closed: every verdict and every pill word has a row", () => {
	expect(uncoveredVerdicts()).toEqual([]);
	expect(uncoveredPills()).toEqual([]);
});

test("the hero reads each window state with the table's word and tone", () => {
	for (const row of WINDOW_STATE_ROWS) {
		expect(classifyOverall(row.rows), row.name).toBe(row.expect.verdict);
		const hero = overallState(row.rows, 0, row.totalModels);
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
			expect(pill?.textContent ?? "", `${row.name}: pill ${index} word`).toContain(expected.word);
			expect(
				pill?.classList.contains(`tone-${expected.tone}`) ?? false,
				`${row.name}: pill ${index} tone-${expected.tone}`
			).toBe(true);
		});
		cleanup();
	}
});
