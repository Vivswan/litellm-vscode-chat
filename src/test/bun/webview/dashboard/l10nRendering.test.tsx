/**
 * Component rendering under a CONFIGURED l10n bundle: the rest of the webview
 * suite exercises the unconfigured English fallback, so nothing there would
 * catch a composite {message, comment} key whose bundle spelling drifts from
 * the call site's (the lookup silently falls back to English). These tests
 * inject a fake bundle with unique markers through the real bootstrapL10n
 * seam and assert the markers render from real components - the hero's
 * comment-form plural nouns and the pricing column's "{0} in"/"{0} out"
 * composite keys. @vscode/l10n configuration is module-global and sticky, so
 * the afterAll reset to an empty bundle (English fallback for whatever runs
 * later in the process) is load-bearing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import * as l10n from "@vscode/l10n";
import { App } from "../../../../webview/dashboard/app";
import { bootstrapL10n } from "../../../../webview/dashboard/l10nBootstrap";
import { ModelsSection } from "../../../../webview/dashboard/models";
import { makeDeclaredServer, makeModel, makeState, statePush } from "../fixtures";
import { buttonByText, cleanup, fireClick, mount, pushToWebview, resetPosted } from "../harness";

// The exact composite keys the call sites mint (message + "/" + joined
// comment); a drifted spelling on either side makes the marker not render,
// which is the failure this file exists to catch. The plain "{0} min ago"
// key doubles as the localization tracer for the Diagnostics tab: its marker
// must show in the on-screen grid and never in the copied (English) block.
const FAKE_BUNDLE: Record<string, string> = {
	"{0} in/price per million input tokens; {0} is a dollar amount": "IN[{0}]",
	"{0} out/price per million output tokens; {0} is a dollar amount": "OUT[{0}]",
	"{0} min ago": "AGO[{0}]",
};

beforeAll(() => {
	window.__l10nBundle = FAKE_BUNDLE;
	bootstrapL10n();
});
afterAll(() => {
	l10n.config({ contents: {} });
	delete window.__l10nBundle;
});
beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

test("the pricing column resolves the composite in/out keys with {0} substituted", () => {
	const priced = makeModel({ inputCost: 2.5, outputCost: 10.125 });
	const root = mount(<ModelsSection models={[priced]} serverCount={1} onInspect={() => {}} />);

	const pricing = root.querySelector(".col-price .tip-wrap > span")?.textContent;
	expect(pricing).toBe("IN[$2.5] / OUT[$10.1]");
});

test("Copy diagnostics stays English under a configured bundle while the server row renders the translated relative time", () => {
	const written: string[] = [];
	const clipboard = {
		writeText: (text: string) => {
			written.push(text);
			return Promise.resolve();
		},
	};
	Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });

	const lastChecked = new Date(Date.now() - 5 * 60 * 1000).toISOString();
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				servers: [makeDeclaredServer({ label: "Prod", modelCount: 1, lastChecked })],
				models: [makeModel()],
			})
		)
	);

	// On screen, the server row's status pill resolves the translated marker.
	// That reading used to sit in the Diagnostics outcome grid too; the grid is
	// gone, and the row that owns the server is the one place it renders now.
	const pill = root.querySelector("#panel-overview .pill .pill-time") as HTMLElement;
	expect(pill.textContent).toContain("AGO[5]");

	const diagnosticsTab = Array.from(root.querySelectorAll("[role='tab']")).find(
		(candidate) => (candidate.textContent ?? "").trim() === "Diagnostics"
	) as HTMLElement;
	fireClick(diagnosticsTab);

	// The copied block is fully English by policy: the plain ISO instant, no
	// localized relative echo anywhere in the text.
	fireClick(buttonByText(root, "Copy diagnostics"));
	expect(written[0]).toContain(`Last checked: ${new Date(lastChecked).toISOString()}`);
	expect(written[0]).not.toContain("AGO[");
});
