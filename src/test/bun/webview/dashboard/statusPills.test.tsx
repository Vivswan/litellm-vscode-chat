/**
 * The status pills (dot + plain-language verdict + relative time) and the relative-time formatter behind them.
 * Native titles do not render in the webview host, so everything a pill says is either in its visible text or in
 * the CSS hover tip element next to it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ServersSection } from "../../../../webview/dashboard/servers";
import { relativeTime } from "../../../../webview/dashboard/time";
import { makeDeclaredServer } from "../fixtures";
import { cleanup, mount, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

function mountSection(servers: readonly ReturnType<typeof makeDeclaredServer>[]) {
	return mount(
		<ServersSection
			currencySymbol="$"
			servers={servers}
			now={Date.now()}
			onEditServer={() => {}}
			onAdoptServer={() => {}}
			onAddServer={() => {}}
		/>
	);
}

test("relativeTime rounds to the coarsest readable unit and tolerates clock drift and garbage", () => {
	const now = Date.parse("2026-07-30T12:00:00Z");
	const at = (offsetSeconds: number) => new Date(now - offsetSeconds * 1000).toISOString();
	expect(relativeTime(at(0), now)).toBe("just now");
	expect(relativeTime(at(-20), now)).toBe("just now"); // webview clock behind the host's
	expect(relativeTime(at(44), now)).toBe("just now");
	expect(relativeTime(at(45), now)).toBe("1 min ago");
	expect(relativeTime(at(300), now)).toBe("5 min ago");
	expect(relativeTime(at(3600), now)).toBe("1 h ago");
	expect(relativeTime(at(7500), now)).toBe("2 h ago");
	expect(relativeTime(at(86400), now)).toBe("1 day ago");
	expect(relativeTime(at(86400 * 3), now)).toBe("3 days ago");
	expect(relativeTime("not a timestamp", now)).toBeUndefined();
});

test("each server state renders its pill tone, verdict, and relative check time", () => {
	const justChecked = new Date(Date.now() - 5000).toISOString();
	const root = mountSection([
		makeDeclaredServer({ label: "Fine", state: "ok", lastChecked: justChecked }),
		makeDeclaredServer({
			label: "Broken",
			baseUrl: "http://b",
			state: "error",
			error: "boom",
			lastChecked: justChecked,
		}),
		makeDeclaredServer({ label: "Fresh", baseUrl: "http://c", state: "unchecked" }),
	]);

	const pills = [...root.querySelectorAll(".server-list .pill")];
	expect(pills.length).toBe(3);
	const byText = (word: string) => pills.find((pill) => pill.textContent?.includes(word));

	const ok = byText("Connected");
	expect(ok?.classList.contains("tone-ok")).toBe(true);
	expect(ok?.querySelector(".dot")).not.toBeNull();
	expect(ok?.querySelector(".pill-time")?.textContent).toBe("just now");

	const error = byText("Error");
	expect(error?.classList.contains("tone-error")).toBe(true);

	const unchecked = byText("Not checked");
	expect(unchecked?.classList.contains("tone-muted")).toBe(true);
	expect(unchecked?.querySelector(".pill-time")).toBeNull();
	// No tip on the pill: it sits inside the row's disclosure button, where a
	// focusable tip wrapper would be a nested interactive. The unchecked row's
	// next step lives in its drawer's Discovery last checked fact instead.
	expect(unchecked?.closest(".tip-wrap")).toBeNull();
});

test("an ok row still carrying a sync error shows the warn tone, matching its own diagnostic line", () => {
	const root = mountSection([
		makeDeclaredServer({ label: "Prod", state: "ok", error: "the group upsert failed", servedModelCount: 3 }),
	]);
	const pill = root.querySelector(".server-list .pill");
	expect(pill?.classList.contains("tone-warn")).toBe(true);
	expect(pill?.textContent).toContain("Sync issue");
	// The full error text stays visible and selectable under the row. A row that kept serving is degraded, not
	// blocking, and the tone says so on both.
	const diagnostic = root.querySelector(".row-diagnostic");
	expect(diagnostic?.classList.contains("tier-warn")).toBe(true);
	expect(diagnostic?.textContent).toContain("the group upsert failed");
	expect(diagnostic?.textContent).toContain("Prod");
});

test("an error-state row still serving models reads Sync issue beside the warn dot, never Error", () => {
	// The one-classifier guard: a declared entry serving through an UNEXPECTED failure ranks
	// degraded (its diagnostic says "serving its last known models"), so the word must be the
	// degraded verdict's. A second state walk once put "Error" beside this row's warn dot.
	const root = mountSection([
		makeDeclaredServer({
			label: "Gateway",
			state: "error",
			error: "boom on the newest sync",
			declaredModelCount: 2,
			servedModelCount: 2,
		}),
	]);
	const pill = root.querySelector(".server-list .pill");
	expect(pill?.textContent).toContain("Sync issue");
	expect(pill?.textContent).not.toContain("Error");
	expect(pill?.classList.contains("tone-warn")).toBe(true);
	// The word, the dot, and the line all say the same verdict: degraded, still serving.
	const diagnostic = root.querySelector(".row-diagnostic");
	expect(diagnostic?.classList.contains("tier-warn")).toBe(true);
	expect(diagnostic?.textContent).toContain("serving its last known models");
});

test("the pill's tone follows the row's worst diagnostic, so the dot and the line never disagree", () => {
	// One classifier, one output: a pill working the row out for itself put two verdicts on one server and let them
	// contradict each other in public.
	const cases: readonly { readonly server: ReturnType<typeof makeDeclaredServer>; readonly tone: string }[] = [
		// Nothing wrong at all.
		{ server: makeDeclaredServer({ label: "Healthy", state: "ok" }), tone: "tone-ok" },
		// Advisory: the entry declared this failure and is serving through it.
		{
			server: makeDeclaredServer({
				label: "Declared",
				baseUrl: "http://b",
				state: "error",
				error: "404 on /models",
				expected: true,
				declaredModelCount: 2,
				servedModelCount: 2,
			}),
			tone: "tone-ok",
		},
		// Degraded: it answers, but without settings its owner wrote.
		{
			server: makeDeclaredServer({ label: "Ignored", baseUrl: "http://c", notices: ["entry-params-inactive"] }),
			tone: "tone-warn",
		},
		// Blocking: it serves nothing.
		{
			server: makeDeclaredServer({ label: "Down", baseUrl: "http://d", state: "error", error: "refused" }),
			tone: "tone-error",
		},
		// Degraded: the same failure while models keep serving - warn, not the blocking red.
		{
			server: makeDeclaredServer({
				label: "Serving",
				baseUrl: "http://h",
				state: "error",
				error: "refused",
				servedModelCount: 2,
			}),
			tone: "tone-warn",
		},
		// SEVERAL problems at once: the dot must take the worst, not the first found. This row carries an
		// inactive-entry notice (degraded) alongside a failure that serves nothing (blocking).
		{
			server: makeDeclaredServer({
				label: "Both",
				baseUrl: "http://e",
				state: "error",
				error: "refused",
				notices: ["entry-params-inactive"],
			}),
			tone: "tone-error",
		},
		// An expected failure with NOTHING declared serves no models, so it is blocking and the dot is red.
		{
			server: makeDeclaredServer({
				label: "Nothing",
				baseUrl: "http://f",
				state: "error",
				error: "404",
				expected: true,
			}),
			tone: "tone-error",
		},
		// The one branch that bypasses the severity: nothing has looked at this row yet, so it carries no diagnostic,
		// and "no diagnostic" must not read as health.
		{ server: makeDeclaredServer({ label: "Fresh", baseUrl: "http://g", state: "unchecked" }), tone: "tone-muted" },
	];
	// These rows carry no spend tone, so each band's paint tier maps 1:1 onto its
	// severity; the spend tone's lift (a degraded band painted error-tier) is the
	// one sanctioned divergence and has its own suite (serverSpend.test.tsx).
	const tierToTone: Readonly<Record<string, string>> = {
		"tier-error": "tone-error",
		"tier-warn": "tone-warn",
		"tier-advisory": "tone-ok",
	};
	for (const { server, tone } of cases) {
		const root = mountSection([server]);
		const pill = root.querySelector(".server-row .pill");
		expect(pill?.classList.contains(tone), `${server.label} pill`).toBe(true);
		// And the line beneath it, where there is one, ranks the row identically.
		const line = root.querySelector(".row-diagnostic");
		if (line !== null) {
			const tier = [...line.classList].find((name) => name.startsWith("tier-")) ?? "";
			expect(tierToTone[tier], `${server.label} line ${tier}`).toBe(tone);
		}
		cleanup();
	}
});
