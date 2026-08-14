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
 * readers each collapsed control carries the page's tip primitive (ui/tip.tsx),
 * placed beside the rail: the rail is a column against the window's edge, so a
 * tip above a control would cover its neighbour, and the rail's own scrolling
 * column would clip an absolute tip. Every rail bubble is paint-only - its text
 * repeats what the accessible tree already carries (a control's own label, or,
 * for the verdict, the word plus the sync line that stays in the DOM beside
 * it), so none of them is a description; the verdict's tab stop instead points
 * at that sync paragraph, which is the one fact its own text does not carry.
 * The bubbles render only while the rail is collapsed: at full width the label
 * is painted right there, and a tip repeating it is noise.
 */
import * as l10n from "@vscode/l10n";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { IconBug, IconSync } from "./icons";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { TipBubble, useTip } from "./ui/tip";
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
 * The width at which the rail collapses, as a media query, spelled here as well
 * as in the stylesheet - CSS decides what the rail LOOKS like and this decides
 * what it can DO, and neither can read the other. A test pins the two spellings
 * together so they cannot drift.
 */
export const RAIL_COLLAPSE_QUERY = "(width < 1000px)";

/**
 * Whether the rail is currently painting icons instead of labels.
 *
 * The rail's own geometry is CSS's business, but two behaviours depend on it and
 * cannot be expressed in a stylesheet: whether the fleet's verdict is worth a
 * tab stop (below the collapse its word is unpainted, so a keyboard reader has
 * no other way to reach it; above it, a stop that reveals nothing is a stop
 * every keyboard user pays on every visit), and whether each control renders
 * its tip bubble at all (above the collapse the labels are painted, and a tip
 * repeating the label beside it is noise).
 */
function useCollapsedRail(): boolean {
	const [collapsed, setCollapsed] = useState(false);
	useEffect(() => {
		const query = window.matchMedia(RAIL_COLLAPSE_QUERY);
		const update = () => setCollapsed(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	return collapsed;
}

/** One destination. Its own tip, since only the hovered control needs coordinates. */
function RailTab<Id extends string>({
	section,
	active,
	collapsed,
	onSelect,
}: {
	section: RailSection<Id>;
	active: boolean;
	collapsed: boolean;
	onSelect: () => void;
}) {
	const tip = useTip("beside", collapsed);
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
			{...tip.triggerProps}
			className={cn(
				"rail-tab cursor-pointer rounded-sm border border-control-outline px-2 py-1 text-left transition-[color,background-color] duration-[120ms] ease-out focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid max-[1000px]:px-0 max-[1000px]:py-1.5",
				active
					? "bg-accent-soft font-semibold text-accent-text"
					: "text-muted-foreground hover:bg-ghost-hover hover:text-foreground"
			)}
		>
			<span className="rail-icon" aria-hidden="true">
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
			{collapsed ? <TipBubble tip={tip}>{named}</TipBubble> : null}
		</button>
	);
}

/** A rail footer action: its label paints beside the icon, or becomes its tip. */
function RailAction({
	icon,
	label,
	disabled,
	collapsed,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	disabled?: boolean;
	collapsed: boolean;
	onClick: () => void;
}) {
	const tip = useTip("beside", collapsed);
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
			{...tip.triggerProps}
			// mx-0: the footer's glyph-column arithmetic (--rail-inset in
			// dashboard.css) aligns the verdict dot against this button's inline
			// padding, so the padding stays in the layout here.
			className="rail-action mx-0 max-[1000px]:size-8 max-[1000px]:px-0 max-[1000px]:py-0"
		>
			<span className="rail-action-icon" aria-hidden="true">
				{icon}
			</span>
			<span className="rail-action-label">{label}</span>
			{collapsed ? <TipBubble tip={tip}>{label}</TipBubble> : null}
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
	const collapsed = useCollapsedRail();
	const verdictTip = useTip("beside", collapsed);
	// The sync line's id, minted rather than spelled: the verdict pill points
	// its description at that paragraph, and a literal id would be correct only
	// for as long as exactly one rail is ever mounted.
	const syncedId = useId();
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
		// data-tip-edge: the collapsed controls' tips anchor their x to this
		// box's right edge, so the column of tips lines up (ui/tip.tsx).
		<nav className="rail" aria-label={l10n.t("Dashboard")} data-tip-edge="">
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
							collapsed={collapsed}
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
					{/* Focusable only while the rail is collapsed, which is the only
					    width where the tab stop buys anything: there the verdict is a
					    dot and its word is unpainted, so hover is otherwise the sole way
					    to read it and a keyboard or touch reader has none. Above the
					    collapse the word is right there, and a stop that reveals nothing
					    is one every keyboard user pays on every visit. Screen readers
					    reach the word at both widths either way - it is in the DOM. */}
					<p
						className={cn("rail-status pill", `tone-${overall.tone}`)}
						tabIndex={collapsed ? 0 : undefined}
						// The tab stop must say everything the hover says, and each thing
						// once. The pill's own text is the verdict word, and the sync line
						// below is still in the DOM at this width (visually-hidden, not
						// removed), so the description points at THAT paragraph rather than
						// at the tip - whose text is the word and the time together, and
						// would read the word twice. The tip stays paint-only, as the tabs'
						// tips are.
						aria-describedby={collapsed && synced !== undefined ? syncedId : undefined}
						{...verdictTip.triggerProps}
					>
						<span className="dot" aria-hidden="true" />
						<span className="rail-word">{overall.word}</span>
						{collapsed ? <TipBubble tip={verdictTip}>{verdict}</TipBubble> : null}
					</p>
					{synced !== undefined ? (
						<p className="rail-synced" id={syncedId}>
							{l10n.t("last sync {0}", synced)}
						</p>
					) : null}
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
						collapsed={collapsed}
						onClick={() => sendRequest("syncModels", null)}
					/>
					<RailAction
						icon={<IconBug />}
						label={l10n.t("Report a bug")}
						collapsed={collapsed}
						onClick={() => sendRequest("executeCommand", { command: "reportIssue" })}
					/>
				</div>
			</div>
		</nav>
	);
}
