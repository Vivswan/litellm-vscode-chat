/**
 * The geometry sweep's registries: the state pairs that must not move what they
 * mark, the width surfaces that must reach the pane's edge, the grandfathered
 * fixtures without a throwing assertion, and the probe-source marker vocabulary
 * the entries and the engine share. check-geometry.ts runs them.
 */
/**
 * A marker as probe SOURCE: two halves joined at runtime, so the assembled word
 * exists only in a thrown message and never in the expression the harness
 * echoes under it, where it would match every failure the probe can have. The
 * runner greps the whole word.
 */
export function marker(kind: "SETUP" | "DRIFT" | "XDRIFT" | "STALE" | "WIDTH", rest: string): string {
	return `"GEOMETRY-" + ${JSON.stringify(`${kind}${rest}`)}`;
}

export type Dim = "x" | "y" | "width" | "height";

interface ExpectedDrift {
	/** Why the drift stands on today's main, for the reader of this registry. */
	readonly reason: string;
	/**
	 * The drifts the marker covers, each as the "<target> <dim>" prefix of a
	 * drift line. Any drift OUTSIDE this list still fails the pair: a marker
	 * that accepted every drift would hide a new defect behind a known one.
	 */
	readonly where: readonly string[];
	/**
	 * The largest magnitude the marker accepts, in px, for every drift it
	 * names. Required, because a prefix alone would bless a 40px regression in
	 * the same place as a known 1px one.
	 */
	readonly maxAbsPx: number;
}

interface StatePairBase {
	readonly name: string;
	/** The render fixture (a renderFixtures/ file name) whose page hosts the element. */
	readonly fixture: string;
	/** Selectors measured before and after the toggle; each must hold every non-intended dimension. */
	readonly targets: readonly string[];
	/** A selector whose nextElementSibling's top edge is also held: "the row below must not move". */
	readonly siblingOf?: string;
	/** Steps run before the baseline measurement (open the popover the pair lives in). */
	readonly setup?: readonly string[];
	/**
	 * A viewport width forced onto the pair's fixture, for a tier the fixture's
	 * own width never reaches; the restVerify should then also prove the tier
	 * engaged, since a platform minimum can hand back something wider.
	 */
	readonly viewportWidth?: number;
	/**
	 * An inline width forced onto .pane itself, for a tier below what any
	 * viewport can reach (the platform's window minimum is ~500px on macOS,
	 * and the armed cover's floor tier lives under a 400px pane). The pane's
	 * container queries answer to its content box, so an inline width engages
	 * the tier directly; the restVerify should still prove it engaged.
	 */
	readonly paneWidth?: number;
	/** Steps that induce the second state. */
	readonly toggle: readonly string[];
	/**
	 * A page expression that must be truthy at the BASELINE, proving the rest
	 * state is really at rest: a fixture that one day starts in the toggled state
	 * would otherwise compare the state against itself.
	 */
	readonly restVerify: string;
	/** The mirror guard after the toggle: truthy proves the state was actually induced. */
	readonly verify: string;
	/**
	 * Dimensions a NAMED target is allowed to change, with the reason in the
	 * entry's comment. Per target on purpose: an exemption one element earns must
	 * not silently cover its neighbours.
	 */
	readonly intended?: Readonly<Record<string, readonly Dim[]>>;
}

/**
 * metricProbe and expectedDrift are mutually exclusive by type: an
 * expected-drift compare never returns, so a probe behind one would never run.
 */
export type StatePair = StatePairBase &
	(
		| {
				/**
				 * Text-bearing slots whose HEIGHT must not depend on font metrics: after
				 * the pair holds, each is re-measured under the harness's divergent font
				 * faces (same glyph sources, deliberately different vertical metrics, so
				 * the swap changes nothing but the metrics) - once with only the mono
				 * token pair diverging (the mixed sans+mono line box that broke on Linux) and
				 * once with both. A height that moves would pass on one platform's fonts
				 * and fail on another's, so it fails here on every platform instead.
				 */
				readonly metricProbe?: readonly string[];
				readonly expectedDrift?: undefined;
		  }
		| {
				/**
				 * The pair drifts on today's main and the defect is known: the sweep stays
				 * green by asserting the NAMED drifts are still there, within the marker's
				 * bound, and nothing else moved. Remove the marker in the same change that
				 * fixes the defect - a marker whose drift is gone fails as stale.
				 */
				readonly expectedDrift: ExpectedDrift;
				readonly metricProbe?: undefined;
		  }
	);

/** The theme appearance row, the settings row every pair on that page anchors to. */
const THEME_ROW = '.setting-row:has([id="setting-ui.theme"])';

/** The inline-completions model-picker row (features-page.ts), whose dangling warning is a covered-slot tenant. */
const INLINE_MODEL_ROW = '.setting-row:has([id="setting-inlineCompletions.model"])';

/** The commit model-picker row (features-page.ts), at rest wearing the long vanished-server warning. */
const COMMIT_MODEL_ROW = '.setting-row:has([id="setting-commitGeneration.model"])';

/** The commit prompt row (features-page.ts), whose bounded auto-growing textarea holds a three-line prompt at rest. */
const COMMIT_PROMPT_ROW = '.setting-row:has([id="setting-commitGeneration.prompt"])';

/** That row's textarea itself, the box whose growth the prompt pair measures. */
const COMMIT_PROMPT_BOX = '[id="setting-commitGeneration.prompt"]';

/** The language filter's mode row (features-page.ts), the companion select above the list row. */
const LANGUAGE_FILTER_MODE_ROW = '.setting-row:has([id="setting-inlineCompletions.languageFilter-mode"])';

/** The language filter's list row (features-page.ts), the setting's primary comma-list row. */
const LANGUAGE_FILTER_LIST_ROW = '.setting-row:has([id="setting-inlineCompletions.languageFilter"])';

/** The usage-thresholds row, whose error contract is "the overlay never changes the row's height". */
const THRESHOLDS_ROW = '.setting-row:has([id="setting-usage.alertThresholds-warning"])';

/**
 * That row's PARSE-error overlay, named by the id its inputs' aria-describedby
 * points at rather than by `.setting-hint .error`: a refused write renders its
 * own overlay in the same covered slot with the same class, and guards that
 * cannot tell the two apart stop naming the state they induce.
 */
const THRESHOLDS_PARSE_ERROR = `${THRESHOLDS_ROW} .setting-hint span.error[id="setting-usage.alertThresholds-problem"]`;

/**
 * The same row's write-REFUSAL overlay: the covered slot's other tenant,
 * identified by NOT carrying the parse error's id (err-scalar.ts pins the same
 * disambiguation).
 */
const THRESHOLDS_REFUSAL = `${THRESHOLDS_ROW} .setting-hint .setting-cover > span.error:not([id])`;

/** The row's ONE help glyph, in the live flow beside whichever tenant the covered slot shows. */
const THRESHOLDS_GLYPH = `${THRESHOLDS_ROW} .setting-hint .setting-live button.help`;

/** The first server row's home; its next sibling is the second row. */
const FIRST_SERVER_ITEM = ".server-list > li.server-item:first-child";

/** The locked-down row (servers-spend.ts's fifth server), whose band is the page's one warn-tier band. */
const LOCKED_DOWN_ITEM = ".server-list > li.server-item:nth-child(5)";

const LOCKED_DOWN_BAND = `${LOCKED_DOWN_ITEM} .row-diagnostic`;

/** The chip whose popover is open - the one chip a state toggle can address across both measurements. */
const OPEN_CHIP = ".chip-anchor:has(.chip-popover) > button.chip-field";

/** The server edit form's first custom-header row (the only .row users on that page are the header rows). */
const FIRST_HEADER_ROW = "#server-edit-page .row";

/** The settings page's Model parameters frame, anchored by its own add button's id. */
const PARAMS_FRAME = ".record-frame:has(#params-add-matcher)";

/** The same frame in JSON mode, where the add button (the resting anchor) is replaced by the side door. */
const JSON_PARAMS_FRAME = '.record-frame:has(textarea[aria-label="Model parameters as JSON"])';

/** The record row whose chips the popover fixtures open; its next sibling holds the row below. */
const GPT5_RECORD_ROW = `.record-row:has(button[aria-label='Open the full editor for "gpt-5*"'])`;

/** The LAST record row, the one nearest the footer its card's verdict covers. */
const LAST_RECORD_ROW = `.record-row:has(button[aria-label='Open the full editor for "claude-sonnet-4"'])`;

/** The Copy diagnostics tool in the Diagnostics page's vertical action stack (third of the four tools). */
const COPY_TOOL = ".diagnostics-tools li:nth-child(3) button";

/** A rail destination that is never the selected one on the coverage fixtures, so its tip is a real reveal. */
const RAIL_MODELS_TAB = '.rail-nav [role="tab"][id="tab-models"]';

/**
 * The cover is out of flow, so a cover that fails to fill the row moves no target.
 * The pair's held dimensions cannot see that, so the verify states the claim itself.
 * Edges must MATCH, not merely contain, since a cover spilling past the row would hide neighbours.
 * "both" makes left an equality too, for the floor tier where the cover takes the whole row.
 * A shrink-to-fit box there would leave the row's first characters readable beside the confirm.
 */
function coversTheRow(item: string, axes: "block" | "both"): string {
	// Left is containment at the wider tiers (the cover may end where its
	// content does, but never past the row) and equality at the floor.
	const left = axes === "both" ? "Math.abs(box.left - covered.left) <= 0.5" : "box.left >= covered.left - 0.5";
	return `(() => {
		const cover = document.querySelector(${JSON.stringify(`${item} .server-actions.armed`)});
		const row = document.querySelector(${JSON.stringify(`${item} .server-row`)});
		if (cover === null || row === null) { return false; }
		const box = cover.getBoundingClientRect();
		const covered = row.getBoundingClientRect();
		return Math.abs(box.top - covered.top) <= 0.5 && Math.abs(box.bottom - covered.bottom) <= 0.5 &&
			Math.abs(box.right - covered.right) <= 0.5 && ${left};
	})()`;
}

/** Narrows .pane to an inline width, engaging container-query tiers no viewport width can reach. */
export function paneWidthStep(width: number): string {
	return `(() => {
		const pane = document.querySelector(".pane");
		if (pane === null) { throw new Error(${marker("SETUP", ": no .pane to narrow")}); }
		pane.style.flex = "0 0 auto";
		pane.style.width = ${JSON.stringify(`${width}px`)};
		pane.style.minWidth = "0";
		pane.style.maxWidth = "none";
	})()`;
}

/** The pane's content-box width is under the given tier threshold - the same measure its container queries read. */
function paneTierEngaged(below: number): string {
	return `(() => {
		const pane = document.querySelector(".pane");
		const style = getComputedStyle(pane);
		return pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) < ${below};
	})()`;
}

/** Writes a value into a React-controlled input through the native setter, then fires the events React listens to. */
function reactType(selector: string, value: string): string {
	return `(() => {
		const input = document.querySelector(${JSON.stringify(selector)});
		if (input === null) { throw new Error(${marker("SETUP", ": no element matches ")} + ${JSON.stringify(selector)}); }
		let proto = Object.getPrototypeOf(input);
		while (proto !== null && Object.getOwnPropertyDescriptor(proto, "value") === undefined) {
			proto = Object.getPrototypeOf(proto);
		}
		if (proto === null) { throw new Error(${marker("SETUP", ": no value setter on ")} + ${JSON.stringify(selector)}); }
		const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
		input.focus({ preventScroll: true });
		setter.call(input, ${JSON.stringify(value)});
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.blur();
	})()`;
}

/**
 * The state pairs. Every entry is one element and one state change, with the
 * intended presentation delta named in its comment and everything else held.
 */
export const STATE_PAIRS: readonly StatePair[] = [
	{
		// The band pipeline's one-geometry claim (problemBand.tsx): lifting a
		// band's paint tier - warn to error, the spend lift - changes hue, wash,
		// and headline text, but every toned tier wears the same 2px bar and the
		// --band-x formula holds the text x, so neither the band nor the row
		// below may move.
		name: "problem-band-tier-lift",
		fixture: "servers-spend.ts",
		targets: [LOCKED_DOWN_BAND, LOCKED_DOWN_ITEM],
		siblingOf: LOCKED_DOWN_ITEM,
		toggle: [
			`document.querySelector(${JSON.stringify(LOCKED_DOWN_BAND)}).classList.replace("tier-warn", "tier-error")`,
		],
		restVerify:
			`(() => { const band = document.querySelector(${JSON.stringify(LOCKED_DOWN_BAND)}); ` +
			// The label check pins the nth-child guess to the row it means: another
			// warn band drifting into fifth place must fail here, not measure wrongly.
			`return band !== null && band.classList.contains("tier-warn") && ` +
			`band.textContent.includes("locked-down"); })()`,
		verify: `document.querySelector(${JSON.stringify(LOCKED_DOWN_BAND)}).classList.contains("tier-error")`,
	},
	{
		// Marking a settings row modified may change the gutter border's COLOR and
		// reveal the Reset action (opacity only); the row's box and the row below
		// must not move.
		name: "settings-row-modified",
		fixture: "settings.ts",
		targets: [THEME_ROW],
		siblingOf: THEME_ROW,
		toggle: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				push.state.settings.appearance.themeScope = "global";
				push.state.settings.appearance.accentScope = "global";
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		restVerify: `!document.querySelector(${JSON.stringify(THEME_ROW)}).classList.contains("modified")`,
		verify: `document.querySelector(${JSON.stringify(THEME_ROW)}).classList.contains("modified")`,
	},
	{
		// The dangling-reference warning on a feature model row is a covered-slot
		// tenant (the same height-keeping overlay as the scalar rows' errors),
		// and the configured pair stays in the option list either way, so losing
		// the ref's DECLARED SERVER behind a pick may change NOTHING but the
		// warning: the row's box and the row below must hold still.
		name: "feature-model-dangling",
		fixture: "features-page.ts",
		targets: [INLINE_MODEL_ROW],
		siblingOf: INLINE_MODEL_ROW,
		toggle: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				push.state.servers = push.state.servers.filter((server) => server.label !== "prod");
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		restVerify:
			`(() => { const hint = document.querySelector(${JSON.stringify(`${INLINE_MODEL_ROW} .setting-hint`)}); ` +
			`const select = document.querySelector(${JSON.stringify(`${INLINE_MODEL_ROW} select`)}); ` +
			`return hint !== null && !hint.classList.contains("setting-covered") && ` +
			`select?.selectedOptions[0]?.textContent === "prod: gpt-5-mini"; })()`,
		verify:
			`(() => { const hint = document.querySelector(${JSON.stringify(`${INLINE_MODEL_ROW} .setting-hint`)}); ` +
			`const select = document.querySelector(${JSON.stringify(`${INLINE_MODEL_ROW} select`)}); ` +
			`return hint !== null && hint.classList.contains("setting-covered") && ` +
			`hint.querySelector(".setting-cover .error") !== null && ` +
			// The pick survives the loss with the same rendered text - the
			// no-new-geometry design the pair exists to prove.
			`select?.selectedOptions[0]?.textContent === "prod: gpt-5-mini"; })()`,
	},
	{
		// The test-completion probe's landed outcome is a covered-description
		// tenant (SettingRow's notice slot, the same height-keeping overlay as
		// the errors), so a finished probe may move neither the row's box nor
		// the row below.
		name: "fim-probe-outcome",
		fixture: "features-page.ts",
		targets: [INLINE_MODEL_ROW],
		siblingOf: INLINE_MODEL_ROW,
		toggle: [
			`(() => {
				const button = Array.from(document.querySelectorAll(${JSON.stringify(`${INLINE_MODEL_ROW} button`)})).find(
					(candidate) => candidate.textContent === "Test model"
				);
				button.click();
				const posted = (window.__posted || []).filter((message) => message.method === "testFeatureModel").at(-1);
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							kind: "ack",
							id: posted.id,
							method: "testFeatureModel",
							message: "Completion received - 42 characters",
						},
					})
				);
			})()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(`${INLINE_MODEL_ROW} [role="status"]`)}) === null`,
		verify:
			`(() => { const status = document.querySelector(${JSON.stringify(`${INLINE_MODEL_ROW} [role="status"]`)}); ` +
			`return status !== null && status.textContent.includes("Completion received"); })()`,
	},
	{
		// Custom-entry mode opens a deliberate two-line editor (inputs above,
		// ranked actions below): a user-initiated reveal, so the row's HEIGHT
		// change is the intended delta while its x, y, and width hold - the
		// editor must grow downward in place, never shift the row.
		name: "feature-model-custom-entry",
		fixture: "features-page.ts",
		targets: [INLINE_MODEL_ROW],
		intended: { [INLINE_MODEL_ROW]: ["height"] },
		toggle: [
			`(() => {
				const select = document.querySelector('[id="setting-inlineCompletions.model"]');
				const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
				setter.call(select, "custom");
				select.dispatchEvent(new Event("change", { bubbles: true }));
			})()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(`${INLINE_MODEL_ROW} input[maxlength]`)}) === null`,
		verify:
			`(() => { const input = document.querySelector(${JSON.stringify(`${INLINE_MODEL_ROW} input[maxlength]`)}); ` +
			`const buttons = Array.from(document.querySelectorAll(${JSON.stringify(`${INLINE_MODEL_ROW} button`)})); ` +
			`return input !== null && buttons.some((candidate) => candidate.textContent === "Use model"); })()`,
	},
	{
		// The commit prompt's bounded auto-growing textarea: typing more lines is
		// the user-initiated change whose only intended delta is HEIGHT - the row
		// AND the box itself are both held, so the box grows DOWNWARD in place
		// while its x, y, and width hold. The verify also proves the growth
		// actually happened AND stopped at the eight-row ceiling (internal scroll
		// engaged), so a harness where the box cannot size to its content fails
		// loudly instead of passing an unmoved row. No metricProbe on purpose:
		// the box's height is lh-derived BY DESIGN, so it moves with font metrics.
		name: "commit-prompt-textarea-grows",
		fixture: "features-page.ts",
		targets: [COMMIT_PROMPT_ROW, COMMIT_PROMPT_BOX],
		intended: { [COMMIT_PROMPT_ROW]: ["height"], [COMMIT_PROMPT_BOX]: ["height"] },
		toggle: [
			reactType(
				COMMIT_PROMPT_BOX,
				Array.from({ length: 12 }, (_, line) => `Keep commit subjects short (rule ${line + 1}).`).join("\n")
			),
		],
		restVerify:
			`(() => { const box = document.querySelector(${JSON.stringify(COMMIT_PROMPT_BOX)}); ` +
			`if (box === null) { return false; } ` +
			`window.__commitPromptRestHeight = box.getBoundingClientRect().height; ` +
			`return box.value.split("\\n").length === 3 && window.__commitPromptRestHeight > 0; })()`,
		verify:
			`(() => { const box = document.querySelector(${JSON.stringify(COMMIT_PROMPT_BOX)}); ` +
			`if (box === null) { return false; } ` +
			`return box.value.split("\\n").length === 12 && ` +
			`box.getBoundingClientRect().height > window.__commitPromptRestHeight + 1 && ` +
			`box.scrollHeight > box.clientHeight + 1; })()`,
	},
	{
		// One setting, two rows: flipping the language filter's mode re-labels
		// the list row (title, description, help, placeholder) and re-selects
		// the mode option, but both rows keep single-line texts by design, so
		// neither row's box nor the row below the pair may move.
		name: "language-filter-mode-switch",
		fixture: "features-page.ts",
		// The list row is its group's last row (no next sibling), so the held
		// downstream witness is the next group's model row; the mode row's own
		// sibling is the list row, held twice over.
		targets: [LANGUAGE_FILTER_MODE_ROW, LANGUAGE_FILTER_LIST_ROW, COMMIT_MODEL_ROW],
		siblingOf: LANGUAGE_FILTER_MODE_ROW,
		toggle: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				push.state.settings.languageFilter = {
					mode: "allow",
					languages: push.state.settings.languageFilter.languages,
				};
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		restVerify:
			`(() => { const mode = document.querySelector('[id="setting-inlineCompletions.languageFilter-mode"]'); ` +
			`const row = document.querySelector(${JSON.stringify(LANGUAGE_FILTER_LIST_ROW)}); ` +
			`return mode?.value === "block" && row !== null && row.textContent.includes("Blocked languages"); })()`,
		verify:
			`(() => { const mode = document.querySelector('[id="setting-inlineCompletions.languageFilter-mode"]'); ` +
			`const row = document.querySelector(${JSON.stringify(LANGUAGE_FILTER_LIST_ROW)}); ` +
			// The list itself survives the flip: the mode never edits the languages.
			`const list = document.querySelector('[id="setting-inlineCompletions.languageFilter"]'); ` +
			`return mode?.value === "allow" && row !== null && row.textContent.includes("Allowed languages") && ` +
			`list?.value === "markdown, plaintext"; })()`,
	},
	{
		// The covered slot renders ONE line however much the tenant holds, so a
		// standing warning holds the row; opening its Details disclosure is the
		// user-initiated reveal whose only intended delta is the row's height
		// (the full consequence-first sentence joins the flow below). The
		// warning's line is deliberately shorter than that sentence, which is
		// why Details is offered at all here.
		name: "covered-slot-details-disclosure",
		fixture: "features-page.ts",
		targets: [COMMIT_MODEL_ROW],
		intended: { [COMMIT_MODEL_ROW]: ["height"] },
		toggle: [
			`(() => {
				const button = Array.from(document.querySelectorAll(${JSON.stringify(`${COMMIT_MODEL_ROW} button`)})).find(
					(candidate) => candidate.textContent === "Details"
				);
				button.click();
			})()`,
		],
		restVerify:
			`(() => { const row = document.querySelector(${JSON.stringify(COMMIT_MODEL_ROW)}); ` +
			`return row !== null && row.querySelector(".setting-detail") === null && ` +
			`Array.from(row.querySelectorAll("button")).some((candidate) => candidate.textContent === "Details"); })()`,
		verify:
			`(() => { const detail = document.querySelector(${JSON.stringify(`${COMMIT_MODEL_ROW} .setting-detail`)}); ` +
			`return detail !== null && detail.textContent.includes("no longer configured"); })()`,
	},
	{
		// On the icon rail a tab paints an icon and nothing else, so its tip is
		// how a sighted reader learns its name - and a name arriving under the
		// pointer must not move the column it names. The bubble is fixed-position
		// INSIDE its trigger, which is exactly the construction that could push
		// the tab if it ever rejoined the flow: the rail's inner column, the
		// tablist, and the tab below the hovered one are all held. The pointer
		// half is driven here because a headless page has a deterministic
		// mouseover and a heuristic :focus-visible; the keyboard half is pinned
		// in src/test/bun/webview/dashboard/tip.test.tsx.
		name: "rail-tab-tip-reveal",
		fixture: "rail-coverage-collapsed.ts",
		targets: [".rail-inner", ".rail-nav", RAIL_MODELS_TAB],
		siblingOf: RAIL_MODELS_TAB,
		toggle: [
			`(() => {
				const tab = document.querySelector(${JSON.stringify(RAIL_MODELS_TAB)});
				if (tab === null) { throw new Error(${marker("SETUP", ": no Models tab on the collapsed rail")}); }
				// mouseover, not mouseenter: React delegates onMouseEnter off the
				// bubbling pair, so a non-bubbling mouseenter reaches no handler.
				tab.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			})()`,
		],
		restVerify: `document.querySelector('.rail .tip-bubble[data-open="true"]') === null`,
		verify:
			`(() => { const bubble = document.querySelector(${JSON.stringify(`${RAIL_MODELS_TAB} .tip-bubble`)}); ` +
			`return bubble?.getAttribute("data-open") === "true" && ` +
			`bubble.getBoundingClientRect().width > 0 && ` +
			// The bubble says the name the collapsed rail stopped painting.
			`bubble.textContent.includes("Models"); })()`,
	},
	{
		// A modified row's hover/focus reveal is opacity through the Reveal
		// primitive; revealing it must not move the row or the row below. Driven
		// through the focus half, because a fixture step cannot create :hover.
		name: "settings-row-reveal",
		fixture: "settings-appearance-set.ts",
		targets: [THEME_ROW],
		siblingOf: THEME_ROW,
		toggle: [
			`document.querySelector(${JSON.stringify(`${THEME_ROW} .setting-actions button.reveal-json`)})` +
				`.focus({ preventScroll: true })`,
		],
		// The opacity lives on the Reveal WRAPPER (ui/reveal.tsx's data-slot), not
		// the button: computed opacity does not inherit as a value, so a guard on
		// the button inside a faded wrapper would read "1" in both states.
		restVerify:
			`getComputedStyle(document.querySelector(` +
			`${JSON.stringify(`${THEME_ROW} .setting-actions [data-slot="reveal"]:has(> button.reset)`)}` +
			`)).opacity === "0"`,
		verify:
			`document.querySelector(${JSON.stringify(THEME_ROW)}).contains(document.activeElement) && ` +
			`getComputedStyle(document.querySelector(` +
			`${JSON.stringify(`${THEME_ROW} .setting-actions [data-slot="reveal"]:has(> button.reset)`)}` +
			`)).opacity === "1"`,
	},
	{
		// A settings row's parse error COVERS the description, so the row must not
		// grow. The verify also holds the row's one help glyph, which trails the
		// error's own tail while the cover stands: a cover without a painted glyph
		// is a regression this pair names.
		name: "settings-row-error-overlay",
		fixture: "settings.ts",
		targets: [THRESHOLDS_ROW],
		siblingOf: THRESHOLDS_ROW,
		toggle: [reactType('[id="setting-usage.alertThresholds-warning"]', "abc")],
		restVerify: `document.querySelector(${JSON.stringify(THRESHOLDS_PARSE_ERROR)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(THRESHOLDS_PARSE_ERROR)}) !== null && ` +
			`(document.querySelector(${JSON.stringify(THRESHOLDS_GLYPH)})?.getBoundingClientRect().width ?? 0) > 0`,
	},
	{
		// The Copy diagnostics check-mark flash swaps the button's leading glyph
		// in place: it must not resize the button or move the action stack. The
		// rest glyph's path is stashed on the window so the verify proves the swap
		// happened rather than comparing the state against itself.
		name: "diagnostics-copy-flash",
		fixture: "diagnostics.ts",
		targets: [COPY_TOOL, ".diagnostics-tools"],
		siblingOf: ".diagnostics-tools",
		toggle: [`document.querySelector(${JSON.stringify(COPY_TOOL)}).click()`],
		restVerify:
			`(() => { const button = document.querySelector(${JSON.stringify(COPY_TOOL)}); ` +
			`if (button === null || !button.textContent.includes("Copy diagnostics")) { return false; } ` +
			`window.__copyGlyphAtRest = button.querySelector("svg path")?.getAttribute("d") ?? ""; ` +
			`return window.__copyGlyphAtRest.length > 0; })()`,
		verify:
			`(() => { const path = document.querySelector(${JSON.stringify(COPY_TOOL)})` +
			`?.querySelector("svg path")?.getAttribute("d") ?? ""; ` +
			`return path.length > 0 && path !== window.__copyGlyphAtRest; })()`,
	},
	{
		// The server row's actions cluster occupies a reserved track and reveals by
		// opacity: revealing it must not move the row, its name or URL text, or
		// the row below. Driven through :focus-within, the reveal's keyboard half.
		name: "server-row-actions-reveal",
		fixture: "servers-spend.ts",
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-name`,
			`${FIRST_SERVER_ITEM} .server-url`,
			`${FIRST_SERVER_ITEM} .server-actions`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions button`)})` +
				`.focus({ preventScroll: true })`,
		],
		restVerify:
			`getComputedStyle(document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions`)}))` +
			`.opacity === "0"`,
		verify:
			`getComputedStyle(document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions`)}))` +
			`.opacity === "1"`,
	},
	{
		// Refresh now's busy label swaps in over a reserved width twin (both labels
		// stay mounted in one grid cell), so flipping to "Refreshing..." must not
		// resize the button, move Add server, or move the header line.
		name: "servers-refresh-busy",
		fixture: "servers-spend.ts",
		targets: [
			"#servers-section > .section-head .section-actions",
			"#servers-section > .section-head .section-actions > button:first-child",
			"button.refresh-usage",
		],
		toggle: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				push.state.usage.refreshing = true;
				push.state.usage.refreshingExplicitly = true;
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		restVerify: `document.querySelector("button.refresh-usage").disabled === false`,
		verify:
			`document.querySelector("button.refresh-usage").disabled === true && ` +
			`getComputedStyle(document.querySelector("button.refresh-usage .spinner")).visibility === "visible"`,
	},
	{
		// Arming Remove swaps the resting pair for a two-step confirm that leaves
		// the flow and COVERS the row's cells, and must move NOTHING. The cluster
		// itself is not a target: becoming the cover changes its box by design.
		name: "server-row-armed-cover",
		fixture: "servers-spend.ts",
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-line`,
			`${FIRST_SERVER_ITEM} .server-name`,
			`${FIRST_SERVER_ITEM} .server-usage`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`(() => {
				const remove = [...document.querySelectorAll(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions button`)})]
					.find((button) => button.textContent.trim() === "Remove");
				if (remove === undefined) { throw new Error(${marker("SETUP", ": no Remove button on the first server row")}); }
				remove.click();
			})()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) !== null && ` +
			coversTheRow(FIRST_SERVER_ITEM, "block"),
	},
	{
		// The folded tier's twin of the pair above, where the row is two lines and
		// a cover failing to fill it would leave the whole meta line readable
		// under the confirm. The restVerify also proves the tier really folded,
		// since a platform minimum can hand back something wider.
		name: "server-row-armed-cover-folded",
		fixture: "servers-spend.ts",
		viewportWidth: 500,
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-line`,
			`${FIRST_SERVER_ITEM} .server-name`,
			`${FIRST_SERVER_ITEM} .server-usage`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`(() => {
				const remove = [...document.querySelectorAll(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions button`)})]
					.find((button) => button.textContent.trim() === "Remove");
				if (remove === undefined) { throw new Error(${marker("SETUP", ": no Remove button on the first server row")}); }
				remove.click();
			})()`,
		],
		restVerify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) === null && ` +
			`getComputedStyle(document.querySelector(".server-meta")).display === "flex"`,
		verify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) !== null && ` +
			coversTheRow(FIRST_SERVER_ITEM, "block"),
	},
	{
		// The floor tier's cover takes the WHOLE row (grid-column 1/-1,
		// inset-inline 0, justify-self stretch): one that shrink-to-fits leaves
		// the row's first characters readable beside the confirm, so the claim is
		// both axes. paneWidth reaches the sub-400 tier no viewport width can
		// (the platform window minimum), and the restVerify proves it engaged.
		name: "server-row-armed-cover-floor",
		fixture: "servers-spend.ts",
		paneWidth: 320,
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-line`,
			`${FIRST_SERVER_ITEM} .server-name`,
			`${FIRST_SERVER_ITEM} .server-usage`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`(() => {
				const remove = [...document.querySelectorAll(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions button`)})]
					.find((button) => button.textContent.trim() === "Remove");
				if (remove === undefined) { throw new Error(${marker("SETUP", ": no Remove button on the first server row")}); }
				remove.click();
			})()`,
		],
		restVerify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) === null && ` +
			paneTierEngaged(400),
		verify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) !== null && ` +
			coversTheRow(FIRST_SERVER_ITEM, "both"),
	},
	{
		// The "stale" qualifier lands INLINE before the spend figure and the
		// .server-usage floor absorbs it, so the mark must not move the row, the
		// cell, or the row below. The setup first makes every card fresh: the
		// fixture ships one already stale, whose composition would pre-widen the
		// shared track and let a dropped floor pass unmeasured. The unit's width
		// and x are INTENDED - "stale 42%" is more text, right-justified.
		name: "server-spend-stale",
		fixture: "servers-spend.ts",
		setup: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				for (const server of push.state.usage.servers) {
					if (server.kind === "usage") { server.fresh = true; }
				}
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-usage`,
			`${FIRST_SERVER_ITEM} .spend-unit`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				for (const server of push.state.usage.servers) {
					if (server.kind === "usage") { server.fresh = server.label !== "prod"; }
				}
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		restVerify: `document.querySelector(".spend-note") === null`,
		verify: `document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .spend-note`)}) !== null`,
		intended: { [`${FIRST_SERVER_ITEM} .spend-unit`]: ["width", "x"] },
	},
	{
		// The folded twin, where the spend cell sits on a WRAPPING flex meta line
		// and the word arriving without a reservation could re-wrap it. Only width
		// is intended there (the unit is left-aligned). No all-fresh setup on
		// purpose: the reservation under test is per-cell at this tier, and the
		// fixture's own stale row keeps the header's wrapping gloss constant. The
		// restVerify proves the tier folded, or the wide tier is measured twice.
		name: "server-spend-stale-folded",
		fixture: "servers-spend.ts",
		viewportWidth: 500,
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-usage`,
			`${FIRST_SERVER_ITEM} .spend-unit`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				const prod = push.state.usage.servers.find((server) => server.label === "prod");
				if (prod === undefined) { throw new Error(${marker("SETUP", ": no prod usage card in the fixture push")}); }
				prod.fresh = false;
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		restVerify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .spend-note`)}) === null && ` +
			`document.querySelector(".spend-note") !== null && ` +
			`getComputedStyle(document.querySelector(".server-meta")).display === "flex"`,
		verify: `document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .spend-note`)}) !== null`,
		intended: { [`${FIRST_SERVER_ITEM} .spend-unit`]: ["width"] },
	},
	{
		// A record chip's invalid mark is a border-color change on a border that is
		// always there, and the popover is out of flow: the claim is the vertical
		// one, that the mark never adds a line or moves the row. Width and x are
		// INTENDED - the chip echoes the draft's text and resizes by design.
		name: "record-chip-invalid",
		fixture: "settings.ts",
		targets: [OPEN_CHIP, ".chip-list:has(.chip-popover)"],
		setup: [
			`(() => {
				const chips = [...document.querySelectorAll("button.chip-field")]
					.filter((chip) => chip.querySelector(".chip-key")?.textContent === "temperature");
				if (chips.length < 2) { throw new Error(${marker("SETUP", ": no second temperature chip to open")}); }
				chips[1].click();
			})()`,
		],
		toggle: [reactType(".chip-popover input.value", "not json")],
		restVerify: `document.querySelector(${JSON.stringify(`${OPEN_CHIP}.invalid`)}) === null`,
		verify: `document.querySelector(${JSON.stringify(`${OPEN_CHIP}.invalid`)}) !== null`,
		intended: { [OPEN_CHIP]: ["width", "x"] },
	},
	{
		// The server form's field problem is an overlay COVERING the row's reserved
		// hint slot, and the connection-consequence note holds its box as an
		// invisible twin: a field going invalid must not move the input or grow
		// the form.
		name: "form-url-error",
		fixture: "form-apikey.ts",
		targets: ["#server-baseUrl", "#server-edit-page"],
		toggle: [reactType("#server-baseUrl", "not a url")],
		restVerify: `document.querySelector('[id="server-baseUrl-error"] .error') === null`,
		verify: `document.querySelector('[id="server-baseUrl-error"] .error') !== null`,
	},
	{
		// A custom-header row's parse verdict lands in the row's reserved status
		// line: the row, the row below, and the form must not move when a name
		// goes invalid.
		name: "form-header-row-error",
		fixture: "form-apikey.ts",
		targets: [FIRST_HEADER_ROW, "#server-edit-page"],
		siblingOf: FIRST_HEADER_ROW,
		toggle: [reactType(`${FIRST_HEADER_ROW} input[aria-label="Header name"]`, "bad header")],
		restVerify: `document.querySelector("#server-edit-page .row .row-status.error") === null`,
		verify: `document.querySelector("#server-edit-page .row .row-status.error") !== null`,
	},
	{
		// The matcher editor overlay's per-row verdict lands in the row's reserved
		// status line: the row, the rows grid, and the Add action under it must
		// not move. The capability twin below drives the same machinery.
		name: "record-overlay-row-error",
		fixture: "record-overlay.ts",
		targets: [".matcher-editor .rows > .row", ".matcher-editor .rows"],
		siblingOf: ".matcher-editor .rows",
		toggle: [reactType(".matcher-editor .rows input.value", "not json")],
		restVerify: `document.querySelector(".matcher-editor .row-status.error") === null`,
		verify: `document.querySelector(".matcher-editor .row-status.error") !== null`,
	},
	{
		// The capability twin, whose rows carry standing HINTS at rest: a problem
		// landing beside them must hold the grid and the overlay footer still.
		name: "form-caps-overlay-row-error",
		fixture: "form-caps-open.ts",
		targets: [".matcher-editor .rows", ".matcher-editor .editor-footer"],
		siblingOf: ".matcher-editor .rows",
		toggle: [
			`(() => {
				const rows = [...document.querySelectorAll(".matcher-editor .rows > .row")];
				const row = rows.find((r) => r.querySelector("input.key")?.value === "supported_openai_params");
				if (row === undefined) { throw new Error(${marker("SETUP", ": no supported_openai_params row in the overlay")}); }
				const input = row.querySelector("input.value");
				if (input === null) { throw new Error(${marker("SETUP", ": the supported_openai_params row offers no value input")}); }
				const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
				input.focus({ preventScroll: true });
				setter.call(input, "not json");
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.blur();
			})()`,
		],
		restVerify: `document.querySelector(".matcher-editor .row-status.error") === null`,
		verify: `document.querySelector(".matcher-editor .row-status.error") !== null`,
	},
	{
		// A refused record Apply lands in the footer's inline message slot: the
		// frame, its action bar, the slot's own box, the Add action, and the
		// commit trio must not move. The toggle drives the real flow, quoting the
		// posted request's id off the harness stub like err-recordeditor.ts.
		name: "record-apply-failure-note",
		fixture: "settings.ts",
		setup: [
			// A dirty draft first, since that is the state the refusal lands on.
			`(() => {
				const chips = [...document.querySelectorAll("button.chip-field")]
					.filter((chip) => chip.querySelector(".chip-key")?.textContent === "temperature");
				if (chips.length === 0) { throw new Error(${marker("SETUP", ": no temperature chip to open")}); }
				chips[0].click();
			})()`,
			reactType(".chip-popover input.value", "0.9"),
			`document.querySelector(${JSON.stringify(OPEN_CHIP)}).click()`,
		],
		targets: [
			PARAMS_FRAME,
			`${PARAMS_FRAME} .toolbar.editor-actions`,
			`${PARAMS_FRAME} .editor-status`,
			`${PARAMS_FRAME} .editor-commit`,
			"#params-add-matcher",
		],
		toggle: [
			`(() => {
				const frame = document.querySelector(${JSON.stringify(PARAMS_FRAME)});
				[...frame.querySelectorAll("button")].find((b) => b.textContent.trim() === "Apply").click();
				const posted = window.__posted.filter((m) => m.method === "setModelParameters").pop();
				if (posted === undefined) { throw new Error(${marker("SETUP", ": Apply posted no setModelParameters request")}); }
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							kind: "fail",
							id: posted.id,
							method: "setModelParameters",
							message: "The write to models.parameters was refused by the configuration target.",
							failureKind: "validation",
						},
					})
				);
			})()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .failure-note.error`)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .failure-note.error`)})` +
			`?.textContent.includes("refused by the configuration target") === true`,
		metricProbe: [`${PARAMS_FRAME} .editor-status`],
	},
	{
		// A refused settings write covers the posting row's description slot: the
		// row and the row below must not move. Sibling pair of
		// settings-row-error-overlay, which toggles the slot's OTHER tenant.
		name: "settings-write-failure-overlay",
		fixture: "settings.ts",
		targets: [THRESHOLDS_ROW],
		siblingOf: THRESHOLDS_ROW,
		toggle: [
			`(() => {
				const box = document.getElementById("setting-usage.alertThresholds-warning");
				const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
				box.focus({ preventScroll: true });
				setter.call(box, "70%");
				box.dispatchEvent(new Event("input", { bubbles: true }));
				box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
				const posted = window.__posted.filter((m) => m.method === "setUsageAlertThresholds").pop();
				if (posted === undefined) { throw new Error(${marker("SETUP", ": Enter posted no setUsageAlertThresholds request")}); }
				// The reader tabs to the row's help before the refusal lands: the row
				// has ONE glyph outside the swapping tenants, so the same element must
				// keep the keyboard through the cover mounting - no hand-off, no swap.
				const glyph = document.querySelector(${JSON.stringify(THRESHOLDS_GLYPH)});
				if (glyph === null) { throw new Error(${marker("SETUP", ": no help glyph on the thresholds row")}); }
				glyph.focus({ preventScroll: true });
				window.__thresholdsGlyph = glyph;
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							kind: "fail",
							id: posted.id,
							method: "setUsageAlertThresholds",
							message: "Alert thresholds must be above 0% and at most 100% - enter values like 80% or 0.8.",
							failureKind: "validation",
							row: "usage.alertThresholds",
						},
					})
				);
			})()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(THRESHOLDS_REFUSAL)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(THRESHOLDS_REFUSAL)}) !== null && ` +
			`(document.querySelector(${JSON.stringify(THRESHOLDS_GLYPH)})?.getBoundingClientRect().width ?? 0) > 0 && ` +
			`document.activeElement === window.__thresholdsGlyph && ` +
			`document.activeElement === document.querySelector(${JSON.stringify(THRESHOLDS_GLYPH)})`,
	},
	{
		// The server form's rename note holds its box as an invisible spacing twin
		// under the Label row: speaking must not push the rows below down. The
		// fixture opens with a field error already standing, so this also proves
		// the note does not disturb the covered-slot error above it.
		name: "form-rename-note",
		fixture: "err-serverform.ts",
		targets: ["#server-label", "#server-baseUrl", "#server-edit-page"],
		toggle: [reactType("#server-label", "prod-eu")],
		restVerify:
			`getComputedStyle(document.querySelector("#server-edit-page .rename-note"))` + `.visibility === "hidden"`,
		verify: `getComputedStyle(document.querySelector("#server-edit-page .rename-note"))` + `.visibility === "visible"`,
	},
	{
		// The add form's twin: a label colliding with a declared entry speaks the
		// collides note in the same reserved line, and must not push the form
		// down. Only the ADD form renders .collides-note, and "prod" is a declared
		// label in the shared base state, so the toggle is a real collision.
		name: "form-collides-note",
		fixture: "form-apiversion-auto.ts",
		targets: ["#server-label", "#server-baseUrl", "#server-edit-page"],
		toggle: [reactType("#server-label", "prod")],
		restVerify:
			`getComputedStyle(document.querySelector("#server-edit-page .collides-note"))` + `.visibility === "hidden"`,
		verify:
			`getComputedStyle(document.querySelector("#server-edit-page .collides-note"))` + `.visibility === "visible"`,
	},
	{
		// The matcher editor's status line under the matcher input is ONE reserved
		// line (the grammar reading at rest, the parse verdict while one stands),
		// so a verdict must not move the Inherits control, the field rows, or the
		// footer. The toggle uses a reserved name, so both readings apply at once.
		name: "record-overlay-prefix-error",
		fixture: "record-overlay.ts",
		targets: [".matcher-editor .matcher-line", ".matcher-editor .rows", ".matcher-editor .editor-footer"],
		siblingOf: ".matcher-editor .editor-section",
		toggle: [reactType(".matcher-editor .matcher-line input.key", "__proto__")],
		restVerify: `document.querySelector(".matcher-editor .matcher-status.error") === null`,
		verify: `document.querySelector(".matcher-editor .matcher-status.error") !== null`,
	},
	{
		// The same slot's other swap: an EMPTY matcher's status speaks the parse's
		// verdict, and the first keystroke swaps it for the grammar reading, which
		// must not move the sections below. The setup drives the editor into the
		// empty state the fixture never rests in.
		name: "record-overlay-empty-matcher-status",
		fixture: "record-overlay.ts",
		setup: [reactType(".matcher-editor .matcher-line input.key", "")],
		targets: [".matcher-editor .matcher-line", ".matcher-editor .rows", ".matcher-editor .editor-footer"],
		siblingOf: ".matcher-editor .editor-section",
		toggle: [reactType(".matcher-editor .matcher-line input.key", "gpt-4")],
		restVerify: `document.querySelector(".matcher-editor .matcher-status.error") !== null`,
		verify:
			`document.querySelector(".matcher-editor .matcher-status.error") === null && ` +
			`(document.querySelector(".matcher-editor .matcher-status")?.textContent.length ?? 0) > 0`,
	},
	{
		// The Edit-as-JSON side door's parse verdict lands in its reserved line
		// under the textarea (dashboard.css .json-status) - the frame, the
		// textarea, and the action bar must not move on the first bad character.
		name: "record-json-status",
		fixture: "settings.ts",
		setup: [
			`(() => {
				const frame = document.querySelector(${JSON.stringify(PARAMS_FRAME)});
				if (frame === null) { throw new Error(${marker("SETUP", ": no element matches ")} + ${JSON.stringify(PARAMS_FRAME)}); }
				const door = [...frame.querySelectorAll("button")].find((b) => b.textContent.trim() === "Edit as JSON");
				if (door === undefined) { throw new Error(${marker("SETUP", ": no Edit as JSON button in the params frame")}); }
				door.click();
			})()`,
		],
		// JSON_PARAMS_FRAME, not PARAMS_FRAME: the side door replaces the Add
		// action the resting anchor rides on, so the frame is re-anchored by the
		// door's own textarea for every measurement after setup.
		targets: [
			JSON_PARAMS_FRAME,
			`${JSON_PARAMS_FRAME} .record-json textarea`,
			`${JSON_PARAMS_FRAME} .toolbar.editor-actions`,
		],
		toggle: [reactType(`${JSON_PARAMS_FRAME} .record-json textarea`, "not json")],
		restVerify: `document.querySelector(${JSON.stringify(`${JSON_PARAMS_FRAME} .json-status.error`)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(`${JSON_PARAMS_FRAME} .json-status.error`)})` +
			`?.textContent.length > 0`,
	},
	{
		// The card's verdict mounts in the footer's inline message slot when a
		// popover closes over an invalid draft: the row, the row below, the table,
		// the frame, the footer, the slot, and both button groups must hold still.
		name: "record-row-status",
		fixture: "record-popover.ts",
		targets: [
			GPT5_RECORD_ROW,
			".record-table",
			PARAMS_FRAME,
			`${PARAMS_FRAME} .toolbar.editor-actions`,
			`${PARAMS_FRAME} .editor-status`,
			`${PARAMS_FRAME} .editor-commit`,
			"#params-add-matcher",
		],
		siblingOf: GPT5_RECORD_ROW,
		toggle: [
			reactType(".chip-popover input.value", "not json"),
			`document.querySelector(${JSON.stringify(OPEN_CHIP)}).click()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .record-verdict`)}) === null`,
		verify: `document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .record-verdict`)}) !== null`,
		metricProbe: [`${PARAMS_FRAME} .editor-status`],
	},
	{
		// The same claim from the LAST row, whose verdict lands in the footer
		// directly under it. The chip's own width/x change belongs to
		// record-chip-invalid, not measured here.
		name: "record-last-row-status",
		fixture: "settings.ts",
		setup: [
			`(() => {
				const chips = [...document.querySelectorAll("button.chip-field")]
					.filter((chip) => chip.querySelector(".chip-key")?.textContent === "temperature");
				if (chips.length < 3) { throw new Error(${marker("SETUP", ": no last-row temperature chip to open")}); }
				chips[2].click();
			})()`,
		],
		targets: [
			LAST_RECORD_ROW,
			PARAMS_FRAME,
			`${PARAMS_FRAME} .toolbar.editor-actions`,
			`${PARAMS_FRAME} .editor-status`,
			`${PARAMS_FRAME} .editor-commit`,
			"#params-add-matcher",
		],
		toggle: [
			reactType(".chip-popover input.value", "not json"),
			`document.querySelector(${JSON.stringify(OPEN_CHIP)}).click()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .record-verdict`)}) === null`,
		verify: `document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .record-verdict`)}) !== null`,
		metricProbe: [`${PARAMS_FRAME} .editor-status`],
	},
	{
		// The chip popover's verdict lands in its reserved status slot AFTER the
		// actions: Remove field must not move down under the pointer. Width is
		// INTENDED on both - the popover hugs its content and the value input
		// echoes the draft's text, so the claim is the vertical one.
		name: "chip-popover-status",
		fixture: "record-popover.ts",
		targets: [".chip-popover", ".chip-popover .chip-popover-actions"],
		toggle: [reactType(".chip-popover input.value", "not json")],
		restVerify: `document.querySelector(".chip-popover-status .error") === null`,
		verify: `document.querySelector(".chip-popover-status .error") !== null`,
		intended: {
			".chip-popover": ["width"],
			".chip-popover .chip-popover-actions": ["width"],
		},
	},
	{
		// The record grid's key track is a fixed range in the stylesheet, so TYPING a
		// key - focus still in the input, no blur - must not re-solve the tracks: the
		// first row's value cell, the grid, and the footer hold while a name far past
		// the 24ch cap goes in. This is the no-reflow property the deleted JS
		// key-track freeze used to approximate; the setup adds a fresh row so the
		// typing strands no directive mark (a hint would legitimately fill a status
		// line elsewhere).
		name: "record-overlay-key-typing",
		fixture: "record-overlay.ts",
		setup: [
			`(() => {
				const add = [...document.querySelectorAll(".matcher-editor button")]
					.find((b) => b.textContent.trim() === "Add parameter");
				if (add === undefined) { throw new Error(${marker("SETUP", ": no Add parameter action in the overlay")}); }
				add.click();
			})()`,
		],
		targets: [".matcher-editor .rows", ".matcher-editor .rows > .row .cell.value", ".matcher-editor .editor-footer"],
		siblingOf: ".matcher-editor .rows",
		toggle: [
			`(() => {
				const inputs = [...document.querySelectorAll(".matcher-editor .rows input.key")];
				const input = inputs[inputs.length - 1];
				if (input === undefined) { throw new Error(${marker("SETUP", ": no key input in the overlay grid")}); }
				const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
				input.focus({ preventScroll: true });
				setter.call(input, "a_much_longer_parameter_name_than_any_track_should_chase");
				input.dispatchEvent(new Event("input", { bubbles: true }));
			})()`,
		],
		restVerify: `[...document.querySelectorAll(".matcher-editor .rows input.key")].at(-1)?.value === ""`,
		verify:
			`[...document.querySelectorAll(".matcher-editor .rows input.key")].at(-1)?.value === ` +
			`"a_much_longer_parameter_name_than_any_track_should_chase" && ` +
			`document.activeElement === [...document.querySelectorAll(".matcher-editor .rows input.key")].at(-1)`,
	},
	{
		// The same typing claim with a directive mark deliberately stranded: a
		// wrong-record-type key mounts the "ignored" badge in the row's flag cell
		// and its sentence in the reserved status line, and neither may move the
		// value cell, the grid, or the footer. The pair above adds a fresh row
		// precisely to AVOID this state; this one exists to create it.
		name: "record-overlay-key-wrong-type",
		fixture: "record-overlay.ts",
		setup: [
			`(() => {
				const add = [...document.querySelectorAll(".matcher-editor button")]
					.find((b) => b.textContent.trim() === "Add parameter");
				if (add === undefined) { throw new Error(${marker("SETUP", ": no Add parameter action in the overlay")}); }
				add.click();
			})()`,
		],
		targets: [".matcher-editor .rows", ".matcher-editor .rows > .row .cell.value", ".matcher-editor .editor-footer"],
		siblingOf: ".matcher-editor .rows",
		toggle: [
			`(() => {
				const inputs = [...document.querySelectorAll(".matcher-editor .rows input.key")];
				const input = inputs[inputs.length - 1];
				if (input === undefined) { throw new Error(${marker("SETUP", ": no key input in the overlay grid")}); }
				const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
				input.focus({ preventScroll: true });
				setter.call(input, "_openrouter_model");
				input.dispatchEvent(new Event("input", { bubbles: true }));
			})()`,
		],
		restVerify:
			`[...document.querySelectorAll(".matcher-editor .rows input.key")].at(-1)?.value === "" && ` +
			`document.querySelector(".matcher-editor .chip-flag-ignored") === null`,
		verify:
			`[...document.querySelectorAll(".matcher-editor .rows input.key")].at(-1)?.value === "_openrouter_model" && ` +
			`document.querySelector(".matcher-editor .row .chip-flag-ignored") !== null`,
	},
	{
		// The server form commit bar's trailing facts share one wrap-proof line
		// (dashboard.css .commit-status): the unsaved count speaking must move
		// neither the bar, the slot, nor the page - the count is the slot's
		// non-shrinking region and only the saved-to fact clips. The verify also
		// proves the spoken count itself is unclipped at this width.
		name: "form-commit-bar-count",
		fixture: "form-apikey.ts",
		targets: ["#server-edit-page .form-card .toolbar", "#server-edit-page .commit-status", "#server-edit-page"],
		toggle: [reactType("#server-label", "prod-renamed")],
		restVerify: `document.querySelector(".unsaved-count") === null`,
		verify: `(() => {
			const count = document.querySelector(".unsaved-count");
			if (count === null) { return false; }
			const box = count.getBoundingClientRect();
			return box.width > 0 && count.scrollWidth <= count.clientWidth + 0.5;
		})()`,
	},
	{
		// The MCP endpoint's problem takes the hint's place (the server form's
		// one-line-per-row idiom), so a URL Save refuses must move neither the
		// input it marks, the Budget row above it, nor the page. Without that the
		// rows would jump on the first bad keystroke, mid-typing.
		name: "form-mcp-endpoint-error",
		fixture: "form-apikey.ts",
		targets: ["#server-mcp-url", "#server-budget", "#server-edit-page"],
		toggle: [reactType("#server-mcp-url", "not a url")],
		// The id belongs to the hint CELL, which is always mounted (it reserves the
		// line); the problem is the overlay inside it.
		restVerify: `document.querySelector("#server-mcp-url-error .error") === null`,
		verify: `(() => {
			const error = document.querySelector("#server-mcp-url-error .error");
			return error !== null && error.textContent.trim().length > 0;
		})()`,
	},
	{
		// The MCP opt-in reveals its endpoint row BELOW itself (the API version
		// idiom), so the page's HEIGHT legitimately follows the row in and out.
		// That one dimension is the intended delta and is named as such rather
		// than dropping the surface - the page's x, y and width have no business
		// moving either. Everything the reveal decorates above it holds outright:
		// the Budget row keeps its place, so the endpoint opening never jogs the
		// section it belongs to. The fixture rests REVEALED, so the toggle here
		// closes the row; the claim is symmetric.
		name: "form-mcp-endpoint-reveal",
		fixture: "form-apikey.ts",
		targets: ["#server-budget", "#server-edit-page"],
		intended: { "#server-edit-page": ["height"] },
		toggle: [
			`(() => {
				const box = [...document.querySelectorAll("#server-edit-page input[type=checkbox]")]
					.find((input) => input.closest("label")?.textContent.includes("MCP tools available in chat"));
				if (box === undefined) { throw new Error(${marker("SETUP", ": no MCP opt-in checkbox on the form")}); }
				box.click();
			})()`,
		],
		restVerify: `document.querySelector("#server-mcp-url") !== null`,
		verify: `document.querySelector("#server-mcp-url") === null`,
	},
];

export interface WidthSurface {
	readonly name: string;
	readonly fixture: string;
	/** The surface's structural container, whose right edge is the claim. */
	readonly selector: string;
	/** How close to the pane's content edge the container must reach, in px. */
	readonly within?: number;
}

/**
 * The width extremes: each surface rendered at 2000px, asserting its structural
 * container's right edge lands on the pane's content edge (the charter's ruling
 * that structure runs full-bleed and only prose keeps a reading measure).
 * measure.test.ts pins the ruling in source; this pins that the rendered box
 * actually reaches the edge.
 */
export const WIDTH_SURFACES: readonly WidthSurface[] = [
	{ name: "models-list-full-bleed", fixture: "models.ts", selector: ".model-list" },
	{ name: "servers-list-full-bleed", fixture: "servers-spend.ts", selector: "ul.server-list" },
	{ name: "diagnostics-problems-full-bleed", fixture: "diagnostics.ts", selector: ".config-diagnostics" },
	{ name: "diagnostics-resolution-full-bleed", fixture: "diagnostics.ts", selector: ".resolved-scroll" },
	// The settings rows adopt .settings-groups' shared tracks through subgrid
	// and the label gutter is one fixed token both pages read, but the fixed
	// trailing actions slot must still land on the pane's content edge. The
	// claim is on the actions cell because the row's own box overhangs by 8px
	// (the hover tint), so the cell is where the CONTENT stops; scoped to the
	// owning panel because the OTHER page's rows also match bare .setting-row
	// from inside their hidden tabpanel (rect 0).
	{
		name: "settings-rows-full-bleed",
		fixture: "settings.ts",
		selector: "#panel-settings .setting-row .setting-actions",
	},
	// The Features page adopts the same row construction on its own pane.
	{
		name: "features-rows-full-bleed",
		fixture: "features-page.ts",
		selector: "#panel-features .setting-row .setting-actions",
	},
];

/**
 * Fixtures that drive a flow through steps WITHOUT a throwing assertion on
 * their own subject, grandfathered as found - each pinned to a digest of its
 * steps, so MODIFYING a grandfathered flow invalidates the exemption along with
 * adding a new one. THIS LIST ONLY SHRINKS: a fixture running its steps against
 * the wrong page exits 0 with a plausible PNG, which has happened at scale. An
 * entry whose fixture now throws (or lost its steps, or is gone) fails as
 * stale. To update a digest is to re-grandfather changed steps, which defeats
 * the leg: add the throwing assertion and DELETE the entry.
 */
export const UNGUARDED_FIXTURE_PINS: readonly (readonly [string, string])[] = [
	["confirm-discard.ts", "8bca510c05ad"],
	["diagnostics-inspector.ts", "8a1701a0f708"],
	["form-apikey.ts", "d1121e72b575"],
	["form-apiversion-auto.ts", "f9159772b925"],
	["form-apiversion-custom.ts", "d1121e72b575"],
	["form-apiversion-none.ts", "d1121e72b575"],
	["form-caps-open.ts", "8273f2c88f65"],
	["form-oauth.ts", "d1121e72b575"],
	["form-records-overlay.ts", "8273f2c88f65"],
	["form-vk-storedkey.ts", "9be5ebf832e0"],
	["hc-forced-record-invalid.ts", "e6f86d9eb7ab"],
	["inspector-model-notes.ts", "5ef021c0554c"],
	["inspector-model.ts", "5ef021c0554c"],
	["record-jump.ts", "0db9cae39f56"],
	["record-overlay.ts", "0c38ae0f98c1"],
	["record-popover-flip.ts", "7d7a07d525d6"],
	["record-popover-invalid.ts", "e6f86d9eb7ab"],
	["record-popover.ts", "09c360d3a746"],
	["servers-endpoint-hints.ts", "45844f265eaa"],
	["settings-filter.ts", "72273e6f6374"],
	["statusbar.ts", "b519826d19a2"],
	["suggest-capability.ts", "f2e38615ae1a"],
	["suggest-matcher.ts", "3ec18f42049b"],
	["thresholds-both.ts", "43c20b956022"],
	["thresholds-custom.ts", "a55530d1cc7f"],
	["thresholds-error-only.ts", "47864ae45868"],
];
