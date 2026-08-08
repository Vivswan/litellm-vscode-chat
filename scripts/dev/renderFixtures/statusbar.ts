/**
 * A MOCK of the two status bar items in their states, rendered as a strip
 * inside the panel context (the visual-review mandate allows mocking the
 * status bar here; the real items are vscode StatusBarItems the webview
 * cannot host). Mirrors src/extension/ui/status.ts + usageStatusItem.ts
 * renderings: the quiet connection item (count moved to the tooltip) and the
 * usage item plain / warning / error / hidden-when-stale.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const STRIP_SCRIPT = `
(() => {
	const strip = document.createElement("div");
	strip.style.cssText = "position:fixed;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:8px;padding:12px 16px;background:#181818;border-top:1px solid #2b2b2b;font:12px -apple-system,sans-serif;z-index:999";
	const row = (label, items) => {
		const line = document.createElement("div");
		line.style.cssText = "display:flex;align-items:center;gap:12px";
		const caption = document.createElement("span");
		caption.textContent = label;
		caption.style.cssText = "color:#9d9d9d;width:340px;flex:none";
		line.appendChild(caption);
		const bar = document.createElement("div");
		bar.style.cssText = "display:flex;align-items:center;gap:2px;background:#181818;border:1px solid #2b2b2b;padding:2px 6px";
		for (const item of items) {
			const cell = document.createElement("span");
			cell.textContent = item.text;
			cell.style.cssText = "padding:2px 8px;color:" + (item.fg || "#cccccc") + ";background:" + (item.bg || "transparent");
			bar.appendChild(cell);
		}
		line.appendChild(bar);
		strip.appendChild(line);
	};
	row("connected, all budgets healthy (counts live in the tooltip)", [
		{ text: "\\u2713 LiteLLM" },
		{ text: "42%" },
	]);
	row("over the lowest threshold (warning background)", [
		{ text: "\\u2713 LiteLLM" },
		{ text: "87%", bg: "#7a6400", fg: "#ffffff" },
	]);
	row("over the highest threshold / past 100% (error background, literal number)", [
		{ text: "\\u26a0 LiteLLM" },
		{ text: "112%", bg: "#a1260d", fg: "#ffffff" },
	]);
	row("no fresh data or usage.statusBar off (usage item hidden)", [
		{ text: "\\u2713 LiteLLM" },
	]);
	document.body.appendChild(strip);
})();
`;

const fixture: RenderFixture = {
	messages: [{ type: "state", state: baseState() }],
	steps: [STRIP_SCRIPT],
	viewport: { width: 1300, height: 900 },
};

export default fixture;
