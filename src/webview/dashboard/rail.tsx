/**
 * The dashboard's rail: navigation and global state, always on screen (it replaced a tab
 * strip whose fleet state scrolled away). The ARIA contract stays the tabs contract:
 * still one pane at a time with a roving tabindex (role="tablist"), only the axis is
 * vertical - and the `tab-<section>` ids stay, which the inspector's focus fallback
 * names. NARROW: below the collapse the rail becomes an icon rail; nothing is hidden -
 * labels, brand, verdict, and sync time go visually-hidden, so the accessible tree and
 * keyboard contract are identical at every width. Collapsed controls carry the tip
 * primitive beside the rail (a tip above would cover its neighbour, and the rail's
 * scrolling column would clip it); every bubble is paint-only, repeating what the
 * accessible tree already carries, and renders only while collapsed.
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
	 * The destination's collapsed-rail icon. Required: an icon rail with a missing icon is a
	 * blank square with no way back to its name.
	 */
	readonly icon: ReactNode;
	/**
	 * The live number this destination is about - the rail's whole claim over a tab strip.
	 * Absent when there is nothing to count: an absent number is a fact, a zero would be a
	 * different and usually wrong one.
	 */
	readonly count?: string | undefined;
	/**
	 * The count said in words, with its own unit ("4 models", "87% of budget"): a bare "4"
	 * announces as "Servers 4", and the tabpanel inherits that name. The visible label stays
	 * inside the accessible name (Label in Name).
	 */
	readonly countLabel?: string | undefined;
	/** Tints the count when it is something to act on rather than merely a total. */
	readonly countTone?: "warn" | "err" | undefined;
}

/**
 * The collapse width as a media query, spelled here as well as in the stylesheet: CSS
 * decides what the rail LOOKS like, this decides what it can DO, and neither can read
 * the other. A test pins the two spellings together.
 */
export const RAIL_COLLAPSE_QUERY = "(width < 1000px)";

/**
 * Whether the rail is painting icons instead of labels. Two behaviours depend on it that
 * a stylesheet cannot express: whether the verdict is worth a tab stop (collapsed, its
 * word is unpainted; expanded, a stop revealing nothing taxes every keyboard user), and
 * whether each control renders its tip bubble at all.
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
				"rail-tab cursor-pointer rounded-sm border border-control-outline px-2 py-1 text-left transition-[color,background-color] duration-[120ms] ease-out focus-visible:outline-(length:--ring-w) focus-visible:outline-offset-(--ring-offset) focus-visible:outline-ring focus-visible:outline-solid max-[1000px]:px-0 max-[1000px]:py-1.5",
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
			// aria-disabled, not disabled (the Button doc's reason): the attribute drops the control
			// from the tab order and stops pointer events, leaving an icon-only control whose tip
			// could never measure itself. The handler refuses instead.
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
					{/* Focusable only while collapsed - there the verdict is a dot and its word unpainted, so
					    a keyboard or touch reader has no other way to read it; above the collapse a stop
					    that reveals nothing taxes every visit. Screen readers reach the word either way. */}
					<p
						className={cn("rail-status pill", `tone-${overall.tone}`)}
						tabIndex={collapsed ? 0 : undefined}
						// The tab stop must say everything the hover says, each thing once: the description
						// points at the visually-hidden sync paragraph (the one fact the pill's own text lacks);
						// the tip - word plus time - would read the word twice, so it stays paint-only.
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
					{/* The acked method, not the fire-and-forget command post: on the command route this rode
					    the chained channel and held every later message for the whole pass. Nothing waits on
					    the ack, but the row-level Retry correlates by id, so this cannot clear its spinner. */}
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
