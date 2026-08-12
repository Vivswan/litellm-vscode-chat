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

const noop = () => {};

function mountSection(servers: readonly ReturnType<typeof makeDeclaredServer>[]) {
	return mount(
		<ServersSection
			servers={servers}
			now={Date.now()}
			ack={undefined}
			failures={{}}
			inlineSecrets={undefined}
			onDismissFailure={noop}
			onClearInlineSecrets={noop}
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

	const pills = [...root.querySelectorAll("tbody .pill")];
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
	// The explainer moved off the (non-rendering) title attribute onto the hover tip.
	expect(unchecked?.closest(".tip-wrap")?.querySelector(".help-tip")?.textContent).toContain("Sync models");
});

test("an ok row still carrying a sync error shows the warn tone, matching the section's error banner", () => {
	const root = mountSection([
		makeDeclaredServer({ label: "Prod", state: "ok", error: "the group upsert failed", modelCount: 3 }),
	]);
	const pill = root.querySelector("tbody .pill");
	expect(pill?.classList.contains("tone-warn")).toBe(true);
	expect(pill?.textContent).toContain("Sync issue");
	// The full error text stays visible (and selectable) in the section banner.
	expect(root.textContent).toContain("Prod: the group upsert failed");
});
