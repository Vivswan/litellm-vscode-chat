import { useEffect, useRef, useState } from "preact/hooks";
import type { DashboardModel } from "../../extension/dashboard/protocol";
import { Help, HoverTip } from "./help";
import { HELP_MODELS_SECTION } from "./helpText";
import { IconArrowUp, IconCheck, IconCopy } from "./icons";

function formatTokens(count: number): string {
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
		parts.push(`${formatCost(model.inputCost)} in`);
	}
	if (model.outputCost !== undefined) {
		parts.push(`${formatCost(model.outputCost)} out`);
	}
	return parts.join(" / ");
}

function pricingDetail(model: DashboardModel): string {
	const parts: string[] = ["USD per million tokens"];
	if (model.cacheReadCost !== undefined) {
		parts.push(`cache read ${formatCost(model.cacheReadCost)}`);
	}
	if (model.cacheWriteCost !== undefined) {
		parts.push(`cache write ${formatCost(model.cacheWriteCost)}`);
	}
	const longContext: string[] = [];
	if (model.longContextInputCost !== undefined) {
		longContext.push(`${formatCost(model.longContextInputCost)} in`);
	}
	if (model.longContextOutputCost !== undefined) {
		longContext.push(`${formatCost(model.longContextOutputCost)} out`);
	}
	if (model.longContextCacheReadCost !== undefined) {
		longContext.push(`cache read ${formatCost(model.longContextCacheReadCost)}`);
	}
	if (model.longContextCacheWriteCost !== undefined) {
		longContext.push(`cache write ${formatCost(model.longContextCacheWriteCost)}`);
	}
	if (longContext.length > 0) {
		parts.push(`long-context tier: ${longContext.join(", ")}`);
	}
	return parts.join(", ");
}

/** The capabilities column at fleet scale: dimmed plain text, no chrome per cell. */
function capabilities(model: DashboardModel): string {
	const caps: string[] = [];
	if (model.toolCalling) {
		caps.push("tools");
	}
	if (model.imageInput) {
		caps.push("vision");
	}
	if (model.promptCaching) {
		caps.push("caching");
	}
	if (model.reasoning) {
		caps.push("reasoning");
	}
	return caps.join(", ");
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
	onSort,
}: {
	label: string;
	sortKey: SortKey;
	sort: Sort | undefined;
	numeric?: boolean;
	onSort: (key: SortKey) => void;
}) {
	const active = sort?.key === sortKey;
	return (
		<th
			class={numeric === true ? "num" : undefined}
			aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
		>
			<button type="button" class="sort" onClick={() => onSort(sortKey)}>
				{label}
				<span class={active ? (sort.dir === 1 ? "sort-arrow" : "sort-arrow desc") : "sort-arrow idle"}>
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

export function ModelsSection({ models, serverCount }: { models: readonly DashboardModel[]; serverCount: number }) {
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

	// Keyed to the server count, not the distinct labels: two groups can share
	// a label, and their models must stay attributable.
	const showServerColumn = serverCount > 1;
	const needle = filter.trim().toLowerCase();
	const filtered = needle.length === 0 ? models : models.filter((model) => matches(model, needle));
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
		<section>
			<h2>
				Models <Help text={HELP_MODELS_SECTION} />
			</h2>
			{models.length === 0 ? (
				<div class="empty-block">
					<p>No models discovered yet.</p>
					<p class="hint">
						Models appear here once a server is connected and synced: add one under Servers, then run Sync models.
					</p>
				</div>
			) : (
				<>
					<div class="filterbar">
						<input
							type="text"
							placeholder="Filter by name, family, or server"
							aria-label="Filter models"
							value={filter}
							onInput={(event) => setFilter(event.currentTarget.value)}
						/>
						<span class="hint">
							showing {sorted.length} of {models.length}
						</span>
					</div>
					{/* When windowed, the scrollport is a focusable, labelled region so
					    arrow/PageDown scrolling works from the keyboard, and the table
					    declares its true row count while only a window of rows exists
					    in the DOM. Visiting every row by Tab alone is out of scope:
					    off-window rows are reachable by scrolling, not by focus. */}
					<section
						class={windowed ? "table-scroll windowed" : "table-scroll"}
						ref={scrollRef}
						aria-label="Models table"
						tabIndex={windowed ? 0 : undefined}
						onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
					>
						<table class="models" aria-rowcount={windowed ? sorted.length + 1 : undefined}>
							<thead>
								<tr>
									<SortHeader label="Model" sortKey="name" sort={sort} onSort={toggleSort} />
									<SortHeader label="Family" sortKey="family" sort={sort} onSort={toggleSort} />
									{showServerColumn ? (
										<SortHeader label="Server" sortKey="server" sort={sort} onSort={toggleSort} />
									) : null}
									<SortHeader label="Input tokens" sortKey="input" sort={sort} numeric onSort={toggleSort} />
									<SortHeader label="Output tokens" sortKey="output" sort={sort} numeric onSort={toggleSort} />
									<SortHeader label="Pricing ($/M)" sortKey="price" sort={sort} numeric onSort={toggleSort} />
									<th>Capabilities</th>
									<th>{/* row actions */}</th>
								</tr>
							</thead>
							<tbody>
								{start > 0 ? (
									// biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a spacer row is layout filler with no content; presentation removes it from the accessibility tree, which is the point
									<tr class="spacer" role="presentation">
										<td colSpan={columns} style={{ height: `${start * rowHeight}px`, padding: 0, border: "none" }} />
									</tr>
								) : null}
								{visible.map((model, index) => {
									// Sorted-position identity: rows rebuild wholesale on every
									// state push, and a model appears once per server.
									const rowId = `${model.serverLabel}/${model.id}`;
									return (
										<tr key={start + index} aria-rowindex={windowed ? start + index + 2 : undefined}>
											<td>{model.name}</td>
											<td>{model.family}</td>
											{showServerColumn ? <td>{model.serverLabel}</td> : null}
											<td class="num">{formatTokens(model.maxInputTokens)}</td>
											<td class="num">{formatTokens(model.maxOutputTokens)}</td>
											<td class="num">
												{/* Cache and long-context tiers exist only here, so the tip
												    is focus-reachable; native title tooltips do not show in
												    the webview host. */}
												<HoverTip focusable tip={pricingDetail(model)}>
													<span>{formatPricing(model)}</span>
												</HoverTip>
											</td>
											<td class="caps">{capabilities(model)}</td>
											<td class="actions">
												<button
													type="button"
													class="quiet icon-action"
													aria-label={`Copy model ID ${model.id}`}
													onClick={() => copyId(model, rowId)}
												>
													{copied === rowId ? <IconCheck /> : <IconCopy />}
												</button>
											</td>
										</tr>
									);
								})}
								{end < sorted.length ? (
									// biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a spacer row is layout filler with no content; presentation removes it from the accessibility tree, which is the point
									<tr class="spacer" role="presentation">
										<td
											colSpan={columns}
											style={{ height: `${(sorted.length - end) * rowHeight}px`, padding: 0, border: "none" }}
										/>
									</tr>
								) : null}
							</tbody>
						</table>
					</section>
					{sorted.length === 0 ? <p class="empty">No models match the filter.</p> : null}
				</>
			)}
		</section>
	);
}
