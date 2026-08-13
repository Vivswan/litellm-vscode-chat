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
 */
import * as l10n from "@vscode/l10n";
import type { KeyboardEvent } from "react";
import { IconBug } from "./icons";
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
	 * The live number this destination is about, on the item itself. This is
	 * the rail's whole claim over a tab strip: a strip can only say where you
	 * are, a count says whether it is worth going. Absent when there is nothing
	 * to count - an absent number is a fact, and a zero would be a different
	 * and usually wrong one.
	 */
	readonly count?: string | undefined;
	/**
	 * The count said in words, for the accessible name: a bare "4" beside a
	 * label announces as "Servers & Models 4", which is a number without a
	 * noun, and the tabpanel inherits that name too. Carries its own unit -
	 * "4 models", "87% of budget" - and the visible label stays inside the
	 * accessible name, as Label in Name requires.
	 */
	readonly countLabel?: string | undefined;
	/** Tints the count when it is something to act on rather than merely a total. */
	readonly countTone?: "warn" | "err" | undefined;
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
						<button
							key={section.id}
							type="button"
							role="tab"
							id={`tab-${section.id}`}
							aria-selected={section.id === active}
							aria-controls={`panel-${section.id}`}
							tabIndex={section.id === active ? 0 : -1}
							{...(section.countLabel === undefined
								? {}
								: { "aria-label": l10n.t("{0}, {1}", section.label, section.countLabel) })}
							onClick={() => onSelect(section.id)}
							className={cn(
								"cursor-pointer rounded-sm border border-control-outline px-2 py-1 text-left transition-[color,background-color] duration-[120ms] ease-out focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
								section.id === active
									? "bg-accent-soft font-semibold text-accent-text"
									: "text-muted-foreground hover:bg-ghost-hover hover:text-foreground"
							)}
						>
							{section.label}
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
					))}
				</div>
				{/* The fleet's state, pinned. This is the half a tab strip could not
				    carry: it stays put while the pane beside it scrolls. */}
				<div className="rail-state">
					{/* The same pill and tone vocabulary every server row uses: one set of
				    state indicators for the page, so the rail's verdict and a row's
				    can never drift apart visually. */}
					<p className={cn("rail-status pill", `tone-${overall.tone}`)}>
						<span className="dot" />
						{overall.word}
					</p>
					{synced !== undefined ? <p className="rail-synced">{l10n.t("last sync {0}", synced)}</p> : null}
					<Button
						variant="secondary"
						size="compact"
						disabled={serverCount === 0}
						onClick={() => sendRequest("executeCommand", { command: "syncModels" })}
					>
						{l10n.t("Sync models")}
					</Button>
					<Button
						variant="secondary"
						size="compact"
						onClick={() => sendRequest("executeCommand", { command: "reportIssue" })}
					>
						<IconBug /> {l10n.t("Report a bug")}
					</Button>
				</div>
			</div>
		</nav>
	);
}
