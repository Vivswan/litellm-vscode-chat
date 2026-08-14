/**
 * The status pills (dot + plain-language verdict + relative time) and the
 * relative-time formatter behind them. Pills replace the old raw state words
 * and native-title details: titles do not render in the webview host, so
 * everything a pill wants to say is either in its visible text or in the CSS
 * hover tip element next to it.
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
	// next step lives in its drawer's Last checked fact instead.
	expect(unchecked?.closest(".tip-wrap")).toBeNull();
});

test("an ok row still carrying a sync error shows the warn tone, matching its own diagnostic line", () => {
	const root = mountSection([
		makeDeclaredServer({ label: "Prod", state: "ok", error: "the group upsert failed", modelCount: 3 }),
	]);
	const pill = root.querySelector(".server-list .pill");
	expect(pill?.classList.contains("tone-warn")).toBe(true);
	expect(pill?.textContent).toContain("Sync issue");
	// The full error text stays visible (and selectable) - under this row now,
	// rather than in a section banner the reader had to match back to it. A row
	// that kept serving is degraded, not blocking, and the tone says so on both.
	const diagnostic = root.querySelector(".row-diagnostic");
	expect(diagnostic?.classList.contains("sev-degraded")).toBe(true);
	expect(diagnostic?.textContent).toContain("the group upsert failed");
	expect(diagnostic?.textContent).toContain("Prod");
});

test("the pill's tone follows the row's worst diagnostic, so the dot and the line never disagree", () => {
	// One classifier, one output. The pill used to work the row out for itself,
	// which put two verdicts on one server and let them contradict each other in
	// public: an entry serving declared models through an expected failure wore
	// an amber dot over the quiet grey tier, and an entry whose parameters were
	// being ignored wore a green dot over an amber one.
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
		// SEVERAL problems at once: the dot must take the worst, not the first
		// found or the last written. This row carries an inactive-entry notice
		// (degraded) alongside a failure that serves nothing (blocking).
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
		// An expected failure with NOTHING declared serves no models, so it is
		// blocking and the dot is red - it used to be amber, and that change had
		// no test holding it.
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
		// The one branch that bypasses the severity entirely: nothing has looked
		// at this row yet, so it carries no diagnostic, and "no diagnostic" must
		// not read as health.
		{ server: makeDeclaredServer({ label: "Fresh", baseUrl: "http://g", state: "unchecked" }), tone: "tone-muted" },
	];
	const severityToTone: Readonly<Record<string, string>> = {
		"sev-blocking": "tone-error",
		"sev-degraded": "tone-warn",
		"sev-advisory": "tone-ok",
	};
	for (const { server, tone } of cases) {
		const root = mountSection([server]);
		const pill = root.querySelector(".server-row .pill");
		expect(pill?.classList.contains(tone), `${server.label} pill`).toBe(true);
		// And the line beneath it, where there is one, ranks the row identically.
		const line = root.querySelector(".row-diagnostic");
		if (line !== null) {
			const severity = [...line.classList].find((name) => name.startsWith("sev-")) ?? "";
			expect(severityToTone[severity], `${server.label} line ${severity}`).toBe(tone);
		}
		cleanup();
	}
});
