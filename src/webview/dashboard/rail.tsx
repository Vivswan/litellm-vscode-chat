/**
 * The dashboard's rail: navigation and global state, always on screen.
 *
 * It replaces a top tab strip, and the reason is the state rather than the
 * geometry. The strip could only say which section you were in; everything
 * about the fleet - is anything broken, how many servers, when did they last
 * sync - lived in a hero band that scrolled away the moment you started
 * reading a table. A reader who wants to know whether their setup is healthy
 * should not have to scroll up to find out.
 *
 * The ARIA contract stays the tabs contract, deliberately. This is still one
 * pane at a time with a roving tabindex, which is what `role="tablist"`
 * describes; only the axis changed, so the arrow keys follow it (Up/Down) and
 * the list declares itself vertical. Keeping it also keeps the `tab-<section>`
 * ids, which the inspector's focus fallback names - retiring the visual strip
 * should not quietly break where focus lands when a dialog closes.
 *
 * NARROW: below the rail's collapse width the rail becomes an icon rail, the
 * way VS Code's own activity bar is one. A dashboard opened in a split editor
 * is often 500-700px wide, where 216px of rail is nearly half the window spent
 * on five words; the icons give that width back to the content.
 *
 * Nothing is hidden to do it. Every label, the brand, the fleet's verdict and
 * its sync time stay in the DOM and go visually-hidden, so the accessible name
 * of every control, the page's h1, and the whole keyboard contract are the same
 * at 500px as at 1500px - what changes is only what is painted. For sighted
 * readers each control carries its own tip, drawn as the page's other tips are.
 */
import * as l10n from "@vscode/l10n";
import type { CSSProperties, KeyboardEvent, ReactNode, SyntheticEvent } from "react";
import { useState } from "react";
import { IconBug, IconSync } from "./icons";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { sendRequest } from "./vscodeApi";

/** The fleet's one-word verdict, exactly as the pills spell it. Not widened to
 *  `string`: `tone-${tone}` would then compose class names that have no rule. */
export interface Overall {
	readonly tone: "ok" | "error" | "warn" | "muted";
	readonly word: string;
}

export interface RailSection<Id extends string = string> {
	readonly id: Id;
	readonly label: string;
	/**
	 * What this destination looks like once the rail collapses and the label
	 * goes visually-hidden. Required rather than optional: an icon rail with a
	 * missing icon is a blank square with no way back to its name, so a new
	 * destination has to bring one.
	 */
	readonly icon: ReactNode;
	/**
	 * The live number this destination is about, on the item itself. This is
	 * the rail's whole claim over a tab strip: a strip can only say where you
	 * are, a count says whether it is worth going. Absent when there is nothing
	 * to count - an absent number is a fact, and a zero would be a different
	 * and usually wrong one.
	 */
	readonly count?: string | undefined;
	/**
	 * The count said in words, for the accessible name: a bare "4" beside a
	 * label announces as "Servers 4", which is a number without a
	 * noun, and the tabpanel inherits that name too. Carries its own unit -
	 * "4 models", "87% of budget" - and the visible label stays inside the
	 * accessible name, as Label in Name requires.
	 */
	readonly countLabel?: string | undefined;
	/** Tints the count when it is something to act on rather than merely a total. */
	readonly countTone?: "warn" | "err" | undefined;
}

/**
 * Where a collapsed-rail tip should paint, as custom properties on the control
 * it belongs to.
 *
 * The tip is generated content (`content: attr(data-tip)`) rather than an
 * element, because an element would put a second copy of the control's own
 * label into the page's text: the same words in the accessible name, in
 * find-in-page, and in anything that reads textContent. What the reader needs
 * is the label PAINTED somewhere else, not said twice.
 *
 * The coordinates arrive as variables rather than as a style the handler picks,
 * so the stylesheet stays the one thing that decides whether there is a tip at
 * all: at full width these variables are inert. They are measured because the
 * rail's own column scrolls in a short window, and only a fixed tip escapes
 * that overflow box - the same reason the help tips are fixed. Coordinates go
 * stale if the rail scrolls while a tip is shown; leaving the control
 * re-measures.
 */
function useRailTip(): {
	style: CSSProperties;
	place: (event: SyntheticEvent<HTMLElement>) => void;
	clear: (event: SyntheticEvent<HTMLElement>) => void;
} {
	const [style, setStyle] = useState<CSSProperties>({});
	const place = (event: SyntheticEvent<HTMLElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		setStyle({
			"--rail-tip-left": `${rect.right + 8}px`,
			"--rail-tip-top": `${rect.top + rect.height / 2}px`,
		} as CSSProperties);
	};
	// Dropped when the pointer or focus leaves, so nothing can paint from stale
	// coordinates. Hover cannot outlive a window resize, but FOCUS can, and
	// dragging an editor splitter is exactly when the rail's geometry moves -
	// including across the width where the rail itself collapses.
	// A pointer leaving a control that still holds focus clears nothing: the tip
	// is still painted for the focus, and dropping its coordinates would leave it
	// to fall back to the static position.
	const clear = (event: SyntheticEvent<HTMLElement>) => {
		if (document.activeElement !== event.currentTarget) {
			setStyle({});
		}
	};
	return { style, place, clear };
}

/** One destination. Its own tip state, since only the hovered control needs coordinates. */
function RailTab<Id extends string>({
	section,
	active,
	onSelect,
}: {
	section: RailSection<Id>;
	active: boolean;
	onSelect: () => void;
}) {
	const { style, place, clear } = useRailTip();
	const named =
		section.countLabel === undefined ? section.label : l10n.t("{0}, {1}", section.label, section.countLabel);
	return (
		<button
			type="button"
			role="tab"
			id={`tab-${section.id}`}
			aria-selected={active}
			aria-controls={`panel-${section.id}`}
			tabIndex={active ? 0 : -1}
			{...(section.countLabel === undefined ? {} : { "aria-label": named })}
			onClick={onSelect}
			onMouseEnter={place}
			onMouseLeave={clear}
			onFocus={place}
			onBlur={clear}
			style={style}
			className={cn(
				"rail-tab cursor-pointer rounded-sm border border-control-outline px-2 py-1 text-left transition-[color,background-color] duration-[120ms] ease-out focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid max-[1000px]:px-0 max-[1000px]:py-1.5",
				active
					? "bg-accent-soft font-semibold text-accent-text"
					: "text-muted-foreground hover:bg-ghost-hover hover:text-foreground"
			)}
		>
			<span className="rail-icon" aria-hidden="true" data-tip={named}>
				{section.icon}
			</span>
			<span className="rail-label">{section.label}</span>
			{section.count !== undefined ? (
				<span
					aria-hidden="true"
					className={cn(
						"rail-count",
						section.countTone === "err" ? "text-err" : section.countTone === "warn" ? "text-warn" : undefined
					)}
				>
					{section.count}
				</span>
			) : null}
		</button>
	);
}

/** A rail footer action: its label paints beside the icon, or becomes its tip. */
function RailAction({
	icon,
	label,
	disabled,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	const { style, place, clear } = useRailTip();
	return (
		<Button
			variant="secondary"
			size="compact"
			// aria-disabled, not disabled, and for the reason the Button's own
			// doc block gives: the attribute drops the control out of the tab
			// order and stops every pointer event, which on the collapsed rail
			// left an icon-only control that could not be focused and whose tip
			// could never measure itself - so a first run with no servers yet
			// showed one glyph nobody could decode. The handler refuses instead.
			aria-disabled={disabled === true}
			onClick={() => {
				if (disabled !== true) {
					onClick();
				}
			}}
			onMouseEnter={place}
			onMouseLeave={clear}
			onFocus={place}
			onBlur={clear}
			style={style}
			className="rail-action max-[1000px]:size-8 max-[1000px]:px-0 max-[1000px]:py-0"
		>
			<span className="rail-action-icon" aria-hidden="true" data-tip={label}>
				{icon}
			</span>
			<span className="rail-action-label">{label}</span>
		</Button>
	);
}

export function Rail<Id extends string>({
	sections,
	active,
	onSelect,
	overall,
	synced,
	serverCount,
}: {
	sections: readonly RailSection<Id>[];
	active: Id;
	onSelect: (id: Id) => void;
	/** Sync has nothing to ask with no servers configured. */
	serverCount: number;
	overall: Overall;
	/** Already-relative "2 min ago"; absent when nothing has synced. */
	synced: string | undefined;
}) {
	const { style: verdictTipStyle, place: placeVerdictTip, clear: clearVerdictTip } = useRailTip();
	const select = (id: Id) => {
		onSelect(id);
		document.getElementById(`tab-${id}`)?.focus();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		const index = sections.findIndex((section) => section.id === active);
		const at = (position: number) => sections[position]?.id;
		let next: Id | undefined;
		if (event.key === "ArrowDown") {
			next = at((index + 1) % sections.length);
		} else if (event.key === "ArrowUp") {
			next = at((index + sections.length - 1) % sections.length);
		} else if (event.key === "Home") {
			next = at(0);
		} else if (event.key === "End") {
			next = at(sections.length - 1);
		}
		if (next === undefined) {
			return;
		}
		select(next);
		event.preventDefault();
	};

	// Said once, so the verdict's tip and its screen-reader text cannot drift:
	// the collapsed rail paints a dot, and this is what the dot means.
	const verdict = synced === undefined ? overall.word : l10n.t("{0}, last sync {1}", overall.word, synced);

	return (
		<nav className="rail" aria-label={l10n.t("Dashboard")}>
			<div className="rail-inner">
				<h1 className="rail-brand">LiteLLM</h1>
				{/* A tablist is what this is - one pane at a time with a roving
				    tabindex - and the nav around it carries the landmark. */}
				<div
					className="rail-nav"
					role="tablist"
					aria-orientation="vertical"
					aria-label={l10n.t("Dashboard sections")}
					onKeyDown={onKeyDown}
				>
					{sections.map((section) => (
						<RailTab
							key={section.id}
							section={section}
							active={section.id === active}
							onSelect={() => onSelect(section.id)}
						/>
					))}
				</div>
				{/* The fleet's state, pinned. This is the half a tab strip could not
				    carry: it stays put while the pane beside it scrolls. */}
				<div className="rail-state">
					{/* The same pill and tone vocabulary every server row uses: one set of
				    state indicators for the page, so the rail's verdict and a row's
				    can never drift apart visually. */}
					{/* Focusable, though it performs no action, and it is the same
					    exception the page's other tips take (HoverTip's `focusable`):
					    once the rail collapses this verdict is painted as a dot, and a
					    dot that only decodes on hover decodes for nobody on a keyboard
					    or a touchscreen. The word stays in the DOM for assistive tech
					    either way; the tab stop is what puts it on SCREEN. */}
					<p
						className={cn("rail-status pill", `tone-${overall.tone}`)}
						// biome-ignore lint/a11y/noNoninteractiveTabindex: the collapsed rail paints this verdict as a dot whose only other trigger is hover; see above
						tabIndex={0}
						onMouseEnter={placeVerdictTip}
						onMouseLeave={clearVerdictTip}
						onFocus={placeVerdictTip}
						onBlur={clearVerdictTip}
						style={verdictTipStyle}
					>
						{/* aria-hidden because the tip is generated content on this element, and
						    Chromium folds generated content into the accessible name: without
						    it the verdict announces once as the paragraph's text and again as
						    its own tooltip. The word itself is the span below. */}
						<span className="dot" data-tip={verdict} aria-hidden="true" />
						<span className="rail-word">{overall.word}</span>
					</p>
					{synced !== undefined ? <p className="rail-synced">{l10n.t("last sync {0}", synced)}</p> : null}
					{/* The acked method, not the fire-and-forget command post: this is the
					    page's most prominent sync, and on the command route it rode the
					    chained channel and held every later dashboard message for the whole
					    pass. Nothing here waits on the ack - the command reports its own
					    outcome as a toast - but the row-level Retry correlates by request
					    id, so this sync cannot clear that row's spinner. */}
					<RailAction
						icon={<IconSync />}
						label={l10n.t("Sync models")}
						disabled={serverCount === 0}
						onClick={() => sendRequest("syncModels", null)}
					/>
					<RailAction
						icon={<IconBug />}
						label={l10n.t("Report a bug")}
						onClick={() => sendRequest("executeCommand", { command: "reportIssue" })}
					/>
				</div>
			</div>
		</nav>
	);
}
