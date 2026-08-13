import * as l10n from "@vscode/l10n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DashboardModel } from "../../dashboard/viewModels";
import { DOCS_LINK_MODELS } from "./docsLinks";
import { DocsLink, Help, HoverTip } from "./help";
import { helpModelsSection } from "./helpText";
import { IconArrowUp, IconCheck, IconClose, IconCopy } from "./icons";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function formatTokens(count: number): string {
	return count.toLocaleString();
}

/**
 * A cost in dollars per million tokens, trimmed to three significant digits:
 * enough to compare models at a glance, and binary-fraction noise never
 * renders.
 */
function formatCost(cost: number): string {
	return `$${Number(cost.toPrecision(3))}`;
}

function formatPricing(model: DashboardModel): string {
	if (model.inputCost === undefined && model.outputCost === undefined) {
		return "-";
	}
	const parts: string[] = [];
	if (model.inputCost !== undefined) {
		parts.push(
			l10n.t({
				message: "{0} in",
				args: [formatCost(model.inputCost)],
				comment: ["price per million input tokens; {0} is a dollar amount"],
			})
		);
	}
	if (model.outputCost !== undefined) {
		parts.push(
			l10n.t({
				message: "{0} out",
				args: [formatCost(model.outputCost)],
				comment: ["price per million output tokens; {0} is a dollar amount"],
			})
		);
	}
	return parts.join(" / ");
}

function pricingDetail(model: DashboardModel): string {
	const parts: string[] = [l10n.t("USD per million tokens")];
	if (model.cacheReadCost !== undefined) {
		parts.push(l10n.t("cache read {0}", formatCost(model.cacheReadCost)));
	}
	if (model.cacheWriteCost !== undefined) {
		parts.push(l10n.t("cache write {0}", formatCost(model.cacheWriteCost)));
	}
	const longContext: string[] = [];
	if (model.longContextInputCost !== undefined) {
		longContext.push(
			l10n.t({
				message: "{0} in",
				args: [formatCost(model.longContextInputCost)],
				comment: ["price per million input tokens; {0} is a dollar amount"],
			})
		);
	}
	if (model.longContextOutputCost !== undefined) {
		longContext.push(
			l10n.t({
				message: "{0} out",
				args: [formatCost(model.longContextOutputCost)],
				comment: ["price per million output tokens; {0} is a dollar amount"],
			})
		);
	}
	if (model.longContextCacheReadCost !== undefined) {
		longContext.push(l10n.t("cache read {0}", formatCost(model.longContextCacheReadCost)));
	}
	if (model.longContextCacheWriteCost !== undefined) {
		longContext.push(l10n.t("cache write {0}", formatCost(model.longContextCacheWriteCost)));
	}
	if (longContext.length > 0) {
		parts.push(l10n.t("long-context tier: {0}", longContext.join(", ")));
	}
	return parts.join(", ");
}

/** The capability flags as localized words: chips in the inspector header, a joined column in the table below. */
export function capabilityList(model: DashboardModel): readonly string[] {
	const caps: string[] = [];
	if (model.toolCalling) {
		caps.push(l10n.t("tools"));
	}
	if (model.imageInput) {
		caps.push(l10n.t("vision"));
	}
	if (model.promptCaching) {
		caps.push(l10n.t("caching"));
	}
	if (model.reasoning) {
		caps.push(l10n.t("reasoning"));
	}
	return caps;
}

/** The capabilities column at fleet scale: dimmed plain text, no chrome per cell. */
function capabilities(model: DashboardModel): string {
	return capabilityList(model).join(", ");
}

function matches(model: DashboardModel, needle: string): boolean {
	return (
		model.name.toLowerCase().includes(needle) ||
		model.id.toLowerCase().includes(needle) ||
		model.family.toLowerCase().includes(needle) ||
		model.serverLabel.toLowerCase().includes(needle)
	);
}

type SortKey = "name" | "family" | "server" | "input" | "output" | "price";
interface Sort {
	readonly key: SortKey;
	readonly dir: 1 | -1;
}

const SORT_VALUES: Record<SortKey, (model: DashboardModel) => string | number | undefined> = {
	name: (model) => model.name.toLowerCase(),
	family: (model) => model.family.toLowerCase(),
	server: (model) => model.serverLabel.toLowerCase(),
	input: (model) => model.maxInputTokens,
	output: (model) => model.maxOutputTokens,
	price: (model) => model.inputCost,
};

/** Rows without the sorted value (e.g. unpriced models) sink to the bottom in either direction. */
function compareBy(sort: Sort): (a: DashboardModel, b: DashboardModel) => number {
	const value = SORT_VALUES[sort.key];
	return (a, b) => {
		const av = value(a);
		const bv = value(b);
		if (av === bv) {
			return 0;
		}
		if (av === undefined) {
			return 1;
		}
		if (bv === undefined) {
			return -1;
		}
		return (av < bv ? -1 : 1) * sort.dir;
	};
}

function SortHeader({
	label,
	sortKey,
	sort,
	numeric,
	colClass,
	onSort,
}: {
	label: string;
	sortKey: SortKey;
	sort: Sort | undefined;
	numeric?: boolean;
	/** The stylesheet's hook for dropping this whole column on narrow panels; layout only. */
	colClass?: string;
	onSort: (key: SortKey) => void;
}) {
	const active = sort?.key === sortKey;
	const classes = [numeric === true ? "num" : undefined, colClass].filter((name) => name !== undefined).join(" ");
	return (
		<th
			className={classes.length > 0 ? classes : undefined}
			aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
		>
			<button type="button" className="sort" onClick={() => onSort(sortKey)}>
				{label}
				<span className={active ? (sort.dir === 1 ? "sort-arrow" : "sort-arrow desc") : "sort-arrow idle"}>
					<IconArrowUp />
				</span>
			</button>
		</th>
	);
}

/**
 * Windowing constants. The stylesheet's 26px row height is only a minimum
 * (a larger host font grows the rows), so the arithmetic runs on the first
 * rendered row's measured offsetHeight and DEFAULT_ROW_HEIGHT is the
 * fallback while nothing is measurable - which is permanently the case in
 * the happy-dom suite, where offsetHeight is always 0; the tests exercise
 * the fallback path only. The threshold keeps small fleets on the simple
 * full-render path, and the overscan hides the window edges while scrolling.
 */
const WINDOW_THRESHOLD = 50;
const DEFAULT_ROW_HEIGHT = 26;
const OVERSCAN = 10;
const FALLBACK_VIEWPORT = 420;

export function ModelsSection({
	models,
	serverCount,
	scope,
	onInspect,
}: {
	models: readonly DashboardModel[];
	serverCount: number;
	/**
	 * Narrows the list to one server's models; the servers table's model-count
	 * links set it, its chip's clear button reports back through onClear. One
	 * object so a scope without a working clear cannot be expressed.
	 */
	scope?: { readonly label: string; readonly onClear: () => void } | undefined;
	/**
	 * Open a model's inspector overlay. App owns the inspector (it renders
	 * over whatever tab is active - the Diagnostics table opens it in place),
	 * so this section only names the row. The full row identity travels: one
	 * snapshot can render under several labels.
	 */
	onInspect: (target: { scopeKey: string; rawId: string; serverLabel: string }) => void;
}) {
	const [filter, setFilter] = useState("");
	const [sort, setSort] = useState<Sort | undefined>(undefined);
	const [scrollTop, setScrollTop] = useState(0);
	const [copied, setCopied] = useState<string | undefined>(undefined);
	const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
	const scrollRef = useRef<HTMLElement>(null);
	const copySeq = useRef(0);

	// Re-measure after every render: the guarded set makes this settle in one
	// extra pass when the theme's font size changes the real row height.
	useEffect(() => {
		const row = scrollRef.current?.querySelector<HTMLTableRowElement>("tbody tr:not(.spacer)");
		const measured = row?.offsetHeight ?? 0;
		if (measured > 0 && measured !== rowHeight) {
			setRowHeight(measured);
		}
	});

	// Publish this scrollport's own distance from the top of the page, which is
	// what its height budget is made of. The stylesheet used to guess that
	// distance with a hand-tuned em value; a guess is wrong the moment anything
	// above the table changes, and it had already been inherited unchanged from
	// a page this table no longer lives on.
	//
	// Document-relative, not viewport-relative. The two agree only at the top of
	// the page, and the difference is not cosmetic: a viewport-relative top
	// shrinks as the reader scrolls, which raises the cap, which lengthens the
	// page, which allows more scroll. Republished on the next render that value
	// climbs again, and keeps climbing. Adding the scroll offset back names the
	// same distance at every scroll position, so the budget has a fixed point to
	// settle on - the height at which the page exactly fits and stops scrolling.
	//
	// Measured before paint so no frame renders at the fallback, and re-measured
	// whenever this element's own box changes. That one observer covers the
	// three things that move it: the first real layout, the container
	// breakpoints above it reflowing, and the panel it sits in going from hidden
	// to shown - every tab panel stays mounted, so this runs while the models
	// destination is not on screen. An unrendered element measures as a zero box
	// and is skipped rather than published as a top of zero, which would cap the
	// scrollport at nearly the whole viewport for a frame.
	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (element === null) {
			return;
		}
		const publish = () => {
			const rect = element.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) {
				return;
			}
			element.style.setProperty("--models-scroll-top", `${Math.round(rect.top + window.scrollY)}px`);
		};
		publish();
		const observer = new ResizeObserver(publish);
		observer.observe(element);
		window.addEventListener("resize", publish, { passive: true });
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", publish);
		};
	}, []);

	// A new scope means a new list, so the scrollport rewinds: a scroll
	// position inherited from the previous server would drop the reader
	// mid-list (the window clamp keeps it in range, but not at the top).
	const scopeLabel = scope?.label;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scopeLabel is the deliberate rewind key (see above), not a read
	useEffect(() => {
		if (scrollRef.current !== null) {
			scrollRef.current.scrollTop = 0;
		}
		setScrollTop(0);
	}, [scopeLabel]);

	// Keyed to the server count, not the distinct labels: two groups can share
	// a label, and their models must stay attributable.
	const showServerColumn = serverCount > 1;
	// The scope narrows first, then the text filter: the chip and the input
	// compose as two independent conditions.
	const scoped = scope === undefined ? models : models.filter((model) => model.serverLabel === scope.label);
	const needle = filter.trim().toLowerCase();
	const filtered = needle.length === 0 ? scoped : scoped.filter((model) => matches(model, needle));
	const sorted = sort === undefined ? filtered : [...filtered].sort(compareBy(sort));

	const toggleSort = (key: SortKey) => {
		setSort((current) => (current?.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
	};

	const copyId = (model: DashboardModel, rowId: string) => {
		// Clipboard write is fire-and-forget; the check mark is the only feedback.
		navigator.clipboard?.writeText(model.id).catch(() => {});
		setCopied(rowId);
		const seq = ++copySeq.current;
		setTimeout(() => {
			if (copySeq.current === seq) {
				setCopied(undefined);
			}
		}, 1500);
	};

	// The window over the sorted rows. Start clamps against the row count so
	// a filter that shrinks the list under a deep scroll position cannot leave
	// the window past the end.
	const windowed = sorted.length > WINDOW_THRESHOLD;
	const viewport = (() => {
		const height = scrollRef.current?.clientHeight ?? 0;
		return height > 0 ? height : FALLBACK_VIEWPORT;
	})();
	const windowSize = Math.ceil(viewport / rowHeight) + OVERSCAN * 2;
	const start = windowed
		? Math.max(0, Math.min(Math.floor(scrollTop / rowHeight) - OVERSCAN, sorted.length - windowSize))
		: 0;
	const end = windowed ? Math.min(sorted.length, start + windowSize) : sorted.length;
	const visible = sorted.slice(start, end);
	const columns = 7 + (showServerColumn ? 1 : 0);

	return (
		// The id anchors a server row's model-count link: it navigates here and
		// App moves focus onto this section (hence the tabIndex), so the keyboard
		// position follows the reader across the destination change.
		<section id="models-section" tabIndex={-1}>
			<h2>
				{l10n.t("Models")} <Help text={helpModelsSection()} />
				<DocsLink href={DOCS_LINK_MODELS} label={l10n.t("Open the models guide")} />
			</h2>
			{models.length === 0 ? (
				<div className="empty-block">
					{/* Two different nothings. With no servers at all this destination
					    is reachable on a fresh install, and telling that reader to run
					    a sync would send them to ask nobody; the first thing they need
					    is a server. With servers configured, a sync is exactly the
					    right suggestion. */}
					{serverCount === 0 ? (
						<>
							<p>{l10n.t("No models yet.")}</p>
							<p className="hint">{l10n.t("Add a server under Servers and its models appear here once it syncs.")}</p>
						</>
					) : (
						<>
							<p>{l10n.t("No models discovered yet.")}</p>
							<p className="hint">
								{l10n.t("Models appear here once a server has synced; run Sync models to ask your servers now.")}
							</p>
						</>
					)}
				</div>
			) : (
				<>
					<div className="filterbar">
						<Input
							type="text"
							placeholder={l10n.t("Filter by name, family, or server")}
							aria-label={l10n.t("Filter models")}
							value={filter}
							onChange={(event) => setFilter(event.currentTarget.value)}
						/>
						{scope !== undefined ? (
							<span className="chip">
								{l10n.t("Server: {0}", scope.label)}
								<Button
									variant="secondary"
									size="compact"
									aria-label={l10n.t("Clear the server filter")}
									onClick={scope.onClear}
								>
									<IconClose />
								</Button>
							</span>
						) : null}
						<span className="hint">{l10n.t("showing {0} of {1}", sorted.length, scoped.length)}</span>
					</div>
					{/* When windowed, the scrollport is a focusable, labelled region so
					    arrow/PageDown scrolling works from the keyboard, and the table
					    declares its true row count while only a window of rows exists
					    in the DOM. Visiting every row by Tab alone is out of scope:
					    off-window rows are reachable by scrolling, not by focus. */}
					<section
						className={windowed ? "table-scroll windowed" : "table-scroll"}
						ref={scrollRef}
						aria-label={l10n.t("Models table")}
						tabIndex={windowed ? 0 : undefined}
						onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
					>
						<table className="models" aria-rowcount={windowed ? sorted.length + 1 : undefined}>
							<thead>
								<tr>
									<SortHeader label={l10n.t("Model")} sortKey="name" sort={sort} onSort={toggleSort} />
									<SortHeader
										label={l10n.t("Family")}
										sortKey="family"
										sort={sort}
										colClass="col-family"
										onSort={toggleSort}
									/>
									{showServerColumn ? (
										<SortHeader label={l10n.t("Server")} sortKey="server" sort={sort} onSort={toggleSort} />
									) : null}
									<SortHeader
										label={l10n.t("Input tokens")}
										sortKey="input"
										sort={sort}
										numeric
										colClass="col-input"
										onSort={toggleSort}
									/>
									<SortHeader
										label={l10n.t("Output tokens")}
										sortKey="output"
										sort={sort}
										numeric
										colClass="col-output"
										onSort={toggleSort}
									/>
									<SortHeader
										label={l10n.t("Pricing ($/M)")}
										sortKey="price"
										sort={sort}
										numeric
										colClass="col-price"
										onSort={toggleSort}
									/>
									<th className="col-caps">{l10n.t("Capabilities")}</th>
									<th>{/* inspect */}</th>
								</tr>
							</thead>
							<tbody>
								{start > 0 ? (
									// biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a spacer row is layout filler with no content; presentation removes it from the accessibility tree, which is the point
									<tr className="spacer" role="presentation">
										<td colSpan={columns} style={{ height: `${start * rowHeight}px`, padding: 0, border: "none" }} />
									</tr>
								) : null}
								{visible.map((model, index) => {
									// Sorted-position identity: rows rebuild wholesale on every
									// state push, and a model appears once per server.
									const rowId = `${model.serverLabel}/${model.id}`;
									const caps = capabilities(model);
									return (
										// biome-ignore lint/suspicious/noArrayIndexKey: windowed rows are positional by construction; the absolute index is the identity
										<tr key={start + index} aria-rowindex={windowed ? start + index + 2 : undefined}>
											<td className="model-name">
												{/* The span is the stylesheet's ellipsis cap for pathological
												    names; the full name stays in the DOM (and in the inspector's
												    heading), only its rendering trims. */}
												<span className="model-name-text">{model.name}</span>
												{model.declared === true ? (
													<HoverTip
														focusable
														tip={l10n.t(
															"Declared in the entry's discovery.declared list; the server's discovery does not list it."
														)}
													>
														<Badge className="ml-1.5 align-middle">{l10n.t("declared")}</Badge>
													</HoverTip>
												) : null}
												{/* Beside the name because the name is what it copies. The
												    server label keeps the accessible name unique when one raw
												    ID is registered through several servers. */}
												<Button
													variant="secondary"
													size="compact"
													className="icon-action"
													aria-label={l10n.t("Copy model ID {0} from {1}", model.id, model.serverLabel)}
													onClick={() => copyId(model, rowId)}
												>
													{copied === rowId ? <IconCheck /> : <IconCopy />}
												</Button>
											</td>
											<td className="col-family">{model.family}</td>
											{showServerColumn ? <td>{model.serverLabel}</td> : null}
											<td className="num col-input">{formatTokens(model.maxInputTokens)}</td>
											<td className="num col-output">{formatTokens(model.maxOutputTokens)}</td>
											<td className="num col-price">
												{/* Cache and long-context tiers exist only here, so the tip
												    is focus-reachable; native title tooltips do not show in
												    the webview host. */}
												<HoverTip focusable tip={pricingDetail(model)}>
													<span>{formatPricing(model)}</span>
												</HoverTip>
											</td>
											<td className="caps col-caps">
												{/* Truncates with a CSS ellipsis to hold the column budget; the
													    tip carries the full list, and it is focusable because the
													    ellipsized tail is invisible without a pointer. */}
												{caps.length > 0 ? (
													<HoverTip focusable tip={caps}>
														<span className="caps-text">{caps}</span>
													</HoverTip>
												) : null}
											</td>
											<td className="actions">
												{/* One quiet text action, not an icon: "Inspect" says what
												    opens (the merged parameters-and-capabilities panel), and
												    the uniform row height survives (no taller chrome). It
												    stays visible at rest - it is the inspector's only entry
												    point on this row, so hover-reveal would make it
												    undiscoverable. */}
												<Button
													variant="secondary"
													size="compact"
													className="params-action"
													aria-label={l10n.t("Inspect {0} on {1}", model.name, model.serverLabel)}
													onClick={() =>
														onInspect({ scopeKey: model.scopeKey, rawId: model.rawId, serverLabel: model.serverLabel })
													}
												>
													{l10n.t("Inspect")}
												</Button>
											</td>
										</tr>
									);
								})}
								{end < sorted.length ? (
									// biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a spacer row is layout filler with no content; presentation removes it from the accessibility tree, which is the point
									<tr className="spacer" role="presentation">
										<td
											colSpan={columns}
											style={{ height: `${(sorted.length - end) * rowHeight}px`, padding: 0, border: "none" }}
										/>
									</tr>
								) : null}
							</tbody>
						</table>
					</section>
					{sorted.length === 0 ? <p className="empty">{l10n.t("No models match the filter.")}</p> : null}
				</>
			)}
		</section>
	);
}
