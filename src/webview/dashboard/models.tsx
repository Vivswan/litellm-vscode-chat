import * as l10n from "@vscode/l10n";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	CAPABILITY_FLAGS,
	capabilityList,
	EMPTY_MODEL_FILTER,
	filterModels,
	isFilterActive,
	isPriced,
	type ModelFilter,
	type ModelFilterOptions,
	modelFilterOptions,
	priceFilterLabel,
	toggleCapability,
	toggleFamily,
	togglePrice,
	toggleServer,
} from "../../dashboard/modelFilters";
import type { DashboardModel } from "../../dashboard/viewModels";
import { capabilityDisplayLabel, costUnitLabel } from "../../shared/config/capabilityDisplay";
import { DOCS_LINK_MODELS } from "./docsLinks";
import { helpModelsSection } from "./helpText";
import { IconArrowUp, IconCheck, IconClose, IconCopy } from "./icons";
import { Button } from "./ui/button";
import { DisclosureChevron } from "./ui/disclosureChevron";
import { Input } from "./ui/input";
import { Reveal } from "./ui/reveal";
import { Section } from "./ui/section";
import { Select } from "./ui/select";

export function formatTokens(count: number): string {
	return count.toLocaleString();
}

/**
 * A cost per million tokens, trimmed to three significant digits (binary-fraction noise
 * never renders). The symbol is usage.currencySymbol verbatim; never converted.
 */
function formatCost(cost: number, currencySymbol: string): string {
	return `${currencySymbol}${Number(cost.toPrecision(3))}`;
}

/**
 * The row's price phrase as SEPARATE segments, so the floor tier can shed the output
 * half whole with its own separator. The output half is shedable only while the input
 * half stands: an output-only price is the row's whole answer, and a bare "per M" says
 * nothing.
 */
function PriceParts({ model, currencySymbol }: { model: DashboardModel; currencySymbol: string }) {
	const inPart =
		model.inputCost === undefined
			? undefined
			: l10n.t({
					message: "{0} in",
					args: [formatCost(model.inputCost, currencySymbol)],
					comment: ["price per million input tokens; {0} is a currency amount"],
				});
	const outPart =
		model.outputCost === undefined
			? undefined
			: l10n.t({
					message: "{0} out",
					args: [formatCost(model.outputCost, currencySymbol)],
					comment: ["price per million output tokens; {0} is a currency amount"],
				});
	return (
		<>
			{inPart}
			{inPart !== undefined && outPart !== undefined ? <span className="price-sep"> / </span> : null}
			{outPart === undefined ? null : inPart === undefined ? (
				outPart
			) : (
				<span className="price-secondary">{outPart}</span>
			)}
		</>
	);
}

/**
 * The cost fields the detail can show, named from the shared capability vocabulary: the
 * reader moves between this row and the inspector, and a field that changed its name in
 * transit would read as a different fact.
 */
const DETAIL_COSTS = [
	["inputCost", "input_cost_per_token"],
	["outputCost", "output_cost_per_token"],
	["cacheReadCost", "cache_read_input_token_cost"],
	["cacheWriteCost", "cache_creation_input_token_cost"],
	["longContextInputCost", "long_context_input_cost_per_token"],
	["longContextOutputCost", "long_context_output_cost_per_token"],
	["longContextCacheReadCost", "long_context_cache_read_input_token_cost"],
	["longContextCacheWriteCost", "long_context_cache_creation_input_token_cost"],
] as const satisfies readonly (readonly [keyof DashboardModel, string])[];

/** An open field's wire key IS its name; the shared vocabulary labels the rest. */
function fieldLabel(name: string): string {
	return capabilityDisplayLabel(name) ?? name;
}

/**
 * The row's detail: its complete record AND the escape hatch for a clipped row - both
 * lines end in an ellipsis, and what they trim is exactly what a narrow pane loses
 * first, so opening the row makes every field reachable without pointing. `costs`
 * reports whether any priced field made it in: the per-million note belongs to those.
 */
function detailFields(
	model: DashboardModel,
	currencySymbol: string
): {
	readonly fields: readonly { label: string; value: string; mono?: boolean }[];
	readonly costs: boolean;
} {
	const fields: { label: string; value: string; mono?: boolean }[] = [
		// What a request's `model` field actually carries, which is not always
		// what the row is titled with.
		{ label: l10n.t("Model ID"), value: model.rawId, mono: true },
		{ label: l10n.t("Family"), value: model.family },
		{ label: l10n.t("Server"), value: model.serverLabel },
		{ label: fieldLabel("max_input_tokens"), value: formatTokens(model.maxInputTokens), mono: true },
		{
			// An undeclared limit is a number the extension picked, and it caps
			// requests: worth saying so where the number is read.
			label: fieldLabel("max_output_tokens"),
			value: model.outputLimitDeclared
				? formatTokens(model.maxOutputTokens)
				: l10n.t("{0} (assumed)", formatTokens(model.maxOutputTokens)),
			mono: true,
		},
	];
	let costs = false;
	for (const [property, wireKey] of DETAIL_COSTS) {
		const cost = model[property];
		if (typeof cost === "number") {
			fields.push({ label: fieldLabel(wireKey), value: formatCost(cost, currencySymbol), mono: true });
			costs = true;
		}
	}
	// Every capability, answered. The row above prints only what the model can
	// do, so this is where the negative answer lives - named and valued the way
	// the inspector's capabilities table names and values it, one click deeper.
	for (const [wireKey, property] of CAPABILITY_FLAGS) {
		fields.push({ label: fieldLabel(wireKey), value: model[property] === true ? l10n.t("yes") : l10n.t("no") });
	}
	if (model.declared === true) {
		fields.push({
			label: l10n.t("Listed by"),
			value: l10n.t("Declared in the entry's discovery.declared list; the server's discovery does not list it."),
		});
	}
	return { fields, costs };
}

/** Prices are per million tokens throughout; the row says so once rather than on every figure. */
function pricingNote(currencySymbol: string): string {
	return costUnitLabel(currencySymbol);
}

/**
 * The open row's detail. Its height is measured by the list (the window
 * arithmetic needs it exactly), so the ref has to reach the outer box.
 */
function ModelDetail({
	id,
	model,
	currencySymbol,
	ref,
}: {
	id: string;
	model: DashboardModel;
	currencySymbol: string;
	ref: React.Ref<HTMLDivElement>;
}) {
	const { fields, costs } = detailFields(model, currencySymbol);
	return (
		<div className="model-detail" id={id} ref={ref}>
			<dl className="model-detail-grid">
				{fields.map((field) => (
					<div key={field.label} className="model-detail-field">
						<dt>{field.label}</dt>
						<dd className={field.mono === true ? "mono" : undefined}>{field.value}</dd>
					</div>
				))}
			</dl>
			{costs ? <p className="model-detail-note">{pricingNote(currencySymbol)}</p> : null}
		</div>
	);
}

/**
 * Token counts at a glance: "128k", not "128,000" - the second line is skimmed, and
 * four exact digits mid-sentence are read rather than seen. The exact figure lives in
 * the row's detail.
 */
function compactTokens(count: number): string {
	if (count >= 1_000_000) {
		return `${Number((count / 1_000_000).toPrecision(3))}M`;
	}
	if (count >= 1000) {
		return `${Math.round(count / 1000)}k`;
	}
	return String(count);
}

/**
 * A row's identity for the copy flash and the open row, surviving re-sort and re-filter.
 * The label alone is not an identity - two provider groups may carry the SAME label, so
 * scopeKey is what distinguishes them; the label stays because the reader sees it.
 */
function rowIdOf(model: DashboardModel): string {
	return `${model.scopeKey}/${model.serverLabel}/${model.id}`;
}

/**
 * The quiet half of the row's first line. The server joins only when there is more than
 * one to tell apart; a declared model says so here rather than wearing a badge, because
 * it is the same kind of fact as the family.
 */
function metaLine(model: DashboardModel, showServer: boolean): string {
	const origin = showServer ? `${model.family} - ${model.serverLabel}` : model.family;
	return model.declared === true ? `${origin}, ${l10n.t("declared")}` : origin;
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

/**
 * Sorting without column headers: the control moves onto the section's header line. A
 * native select, matching the host's own dropdowns; direction is a separate toggle
 * because folding it in would double the options.
 */
const SORT_LABELS: Record<SortKey, () => string> = {
	name: () => l10n.t("Model"),
	family: () => l10n.t("Family"),
	server: () => l10n.t("Server"),
	input: () => l10n.t("Input tokens"),
	output: () => l10n.t("Output tokens"),
	price: () => l10n.t("Price"),
};

const SORT_KEYS = Object.keys(SORT_LABELS) as readonly SortKey[];

/** The unsorted state is a real choice, not the absence of one: it is the order the servers reported. */
const UNSORTED = "discovered";

function SortControl({
	sort,
	showServer,
	onChange,
}: {
	sort: Sort | undefined;
	/** One server means no Server key to sort by; the same rule that hides it from the rows. */
	showServer: boolean;
	onChange: (sort: Sort | undefined) => void;
}) {
	const keys = showServer ? SORT_KEYS : SORT_KEYS.filter((key) => key !== "server");
	return (
		<span className="sort-control">
			<label className="sort-label">
				{l10n.t("Sort")}
				<Select
					value={sort?.key ?? UNSORTED}
					onChange={(event) => {
						const value = event.currentTarget.value;
						onChange(value === UNSORTED ? undefined : { key: value as SortKey, dir: 1 });
					}}
				>
					<option value={UNSORTED}>{l10n.t("As discovered")}</option>
					{keys.map((key) => (
						<option key={key} value={key}>
							{SORT_LABELS[key]()}
						</option>
					))}
				</Select>
			</label>
			{/* Pressed is the descending state, so the control announces which way the list runs.
			    Disabled while unsorted: no direction to flip. text-foreground steps the glyph up from
			    secondary's muted tier - at that tier the ENABLED arrow read as its own disabled
			    state, which is dimmed twice below it. */}
			<Button
				variant="secondary"
				size="compact"
				className="sort-dir text-foreground"
				aria-label={l10n.t("Sort descending")}
				aria-pressed={sort !== undefined && sort.dir === -1}
				disabled={sort === undefined}
				onClick={() => {
					if (sort !== undefined) {
						onChange({ key: sort.key, dir: sort.dir === 1 ? -1 : 1 });
					}
				}}
			>
				<span className={sort !== undefined && sort.dir === -1 ? "sort-arrow desc" : "sort-arrow"}>
					<IconArrowUp />
				</span>
			</Button>
		</span>
	);
}

/**
 * One filter pill, aria-pressed carrying the state. Free-text pills pass `title` so a
 * truncated label survives on hover; fixed-vocabulary pills leave it off, or every
 * reader would be fed a description repeating the name it just announced.
 */
function FilterPill({
	pressed,
	label,
	title,
	onToggle,
}: {
	pressed: boolean;
	label: string;
	title?: string;
	onToggle: () => void;
}) {
	return (
		<button type="button" className="filter-pill" aria-pressed={pressed} title={title} onClick={onToggle}>
			{label}
		</button>
	);
}

/**
 * The structured filters, one wrapping row of pills in the columnar tier's column order,
 * so they read as a legend for the rows. Which pills exist is the options' business
 * (modelFilterOptions); the server group follows the rows' own rule - one server
 * serving means no server names anywhere on this page.
 */
function FilterPills({
	options,
	active,
	showServers,
	showClear,
	onChange,
	onClearAll,
}: {
	options: ModelFilterOptions;
	active: ModelFilter;
	/** The rows' serverCount > 1 rule; the options' own two-server rule still applies under it. */
	showServers: boolean;
	/**
	 * Whether this row carries clear-all. The parent decides: when the pressed pills empty
	 * the list, the empty state renders its own "Clear filters", and two identical controls
	 * a line apart read as two different actions.
	 */
	showClear: boolean;
	/**
	 * Takes an updater, never a computed state: two toggles in one React batch would both
	 * derive from the same stale `active` and the second would silently undo the first.
	 */
	onChange: (update: (filter: ModelFilter) => ModelFilter) => void;
	onClearAll: () => void;
}) {
	const groups: { key: string; label: string; pills: readonly React.ReactNode[] }[] = [
		{
			key: "family",
			label: l10n.t("Filter by family"),
			pills: options.families.map((family) => (
				<FilterPill
					key={family}
					pressed={active.families.has(family)}
					label={family}
					title={family}
					onToggle={() => onChange((filter) => toggleFamily(filter, family))}
				/>
			)),
		},
		{
			key: "server",
			label: l10n.t("Filter by server"),
			// When one server serves, dead server toggles hide with the rows' own
			// rule - but a pill still PRESSED from when there were two must stay
			// visible, or the filter it applies would have no control to unpress.
			pills: options.servers
				.filter((server) => showServers || active.servers.has(server.scopeKey))
				.map((server) => (
					<FilterPill
						key={server.scopeKey}
						pressed={active.servers.has(server.scopeKey)}
						label={server.display}
						title={server.display}
						onToggle={() => onChange((filter) => toggleServer(filter, server.scopeKey, server.label))}
					/>
				)),
		},
		{
			key: "price",
			label: l10n.t("Filter by price"),
			pills: options.prices.map((price) => (
				<FilterPill
					key={price}
					pressed={active.prices.has(price)}
					label={priceFilterLabel(price)}
					onToggle={() => onChange((filter) => togglePrice(filter, price))}
				/>
			)),
		},
		{
			key: "capability",
			label: l10n.t("Filter by capability"),
			pills: options.capabilities.map((capability) => (
				<FilterPill
					key={capability.key}
					pressed={active.capabilities.has(capability.key)}
					label={capability.label()}
					onToggle={() => onChange((filter) => toggleCapability(filter, capability.key))}
				/>
			)),
		},
	];
	const populated = groups.filter((group) => group.pills.length > 0);
	if (populated.length === 0) {
		return null;
	}
	return (
		<div className="filter-pills">
			{populated.map((group) => (
				<fieldset key={group.key} className="filter-pill-group" aria-label={group.label}>
					{group.pills}
				</fieldset>
			))}
			{showClear ? (
				<Button variant="secondary" size="compact" onClick={onClearAll}>
					{l10n.t("Clear filters")}
				</Button>
			) : null}
		</div>
	);
}

/**
 * Windowing constants. The stylesheet's row height is only a minimum (host fonts grow
 * rows), so the arithmetic runs on the first rendered row's measured height;
 * DEFAULT_ROW_HEIGHT is the fallback while nothing is measurable - permanently the case
 * under happy-dom (offsetHeight 0), so the tests exercise the fallback path only.
 */
const WINDOW_THRESHOLD = 50;
/** Exported so the tests measure against the component's own number instead of a copy that can drift. */
export const DEFAULT_ROW_HEIGHT = 46;
const OVERSCAN = 10;
/**
 * The scrollport's height before there is one to measure. Generous on purpose: too
 * small leaves a blank strip under the last row until the first scroll; too large only
 * costs a few extra rows on one paint.
 */
const FALLBACK_VIEWPORT = 1000;

export function ModelsSection({
	models,
	serverCount,
	currencySymbol,
	scope,
	onInspect,
}: {
	models: readonly DashboardModel[];
	serverCount: number;
	/** The configured cost prefix (usage.currencySymbol); display only, never a conversion. */
	currencySymbol: string;
	/**
	 * Narrows the list to one server's models. One object so a scope without a working
	 * clear cannot be expressed.
	 */
	scope?: { readonly label: string; readonly onClear: () => void } | undefined;
	/**
	 * Open a model's inspector overlay. App owns the inspector, so this section only names
	 * the row; the full identity travels (one snapshot can render under several labels).
	 */
	onInspect: (target: { scopeKey: string; rawId: string; serverLabel: string }) => void;
}) {
	const [filter, setFilter] = useState("");
	const [pills, setPills] = useState<ModelFilter>(EMPTY_MODEL_FILTER);
	const [sort, setSort] = useState<Sort | undefined>(undefined);
	const [scrollTop, setScrollTop] = useState(0);
	const [copied, setCopied] = useState<string | undefined>(undefined);
	const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
	/**
	 * The one open row, held by row id rather than index: sorting and filtering renumber
	 * the list. When the open row leaves the list there is simply nothing to match.
	 */
	const [openRow, setOpenRow] = useState<string | undefined>(undefined);
	/** The open row's detail height, measured rather than assumed; see the window arithmetic below. */
	const [stripHeight, setStripHeight] = useState(0);
	const scrollRef = useRef<HTMLElement>(null);
	const copySeq = useRef(0);

	// Re-measure after every render: the guarded set makes this settle in one
	// extra pass when the theme's font size changes the real row height. The
	// row's first line, not the whole row: an open row is taller by its detail,
	// and the uniform height the window arithmetic runs on is the line's.
	useEffect(() => {
		const line = scrollRef.current?.querySelector<HTMLElement>(".model-row-line");
		const measured = line?.offsetHeight ?? 0;
		if (measured > 0 && measured !== rowHeight) {
			setRowHeight(measured);
		}
	});

	// Publish this scrollport's distance from the top of the page (its height budget's
	// input). Document-relative, not viewport-relative: a viewport-relative top shrinks as
	// the reader scrolls, raising the cap, lengthening the page, allowing more scroll -
	// a feedback loop; document-relative names the same distance at every position, so the
	// budget has a fixed point. Measured before paint and re-measured on box changes (first
	// layout, breakpoints reflowing, panel shown - panels stay mounted, so this runs while
	// hidden); a zero box is skipped rather than published as top 0.
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
		// The pill row above wraps and unwraps as filters change, which MOVES
		// this scrollport without resizing it - and a pure position change fires
		// no ResizeObserver on the element itself. It does resize the parent the
		// two share, so the parent is observed too and the moved top republishes.
		if (element.parentElement !== null) {
			observer.observe(element.parentElement);
		}
		window.addEventListener("resize", publish, { passive: true });
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", publish);
		};
	}, []);

	// The open row's detail height, measured (a wrong number shifts every row under it). A
	// ref callback rather than an effect: the ELEMENT comes and goes for a reason no
	// dependency list names - the open row is itself windowed. Unmounting deliberately does
	// NOT clear the height: a detail scrolled out of the window is still part of the
	// list's height (its spacer carries it); the null arm stays although React 19 makes it
	// unreachable, because leaving the height alone is correct on either path.
	// path, which is a cheaper thing to guarantee than a version's semantics.
	const measureDetail = useCallback((element: HTMLDivElement | null) => {
		if (element === null) {
			return;
		}
		const measure = () => {
			const height = element.offsetHeight;
			setStripHeight((current) => (height > 0 && height !== current ? height : current));
		};
		measure();
		// The detail's own field grid rewraps with the panel width, which changes
		// its height without remounting it.
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
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

	// Three conditions compose AND in this order: scope, pills, text; the header's
	// "showing N of M" reads sorted.length over scoped.length. Memoized for identity, not
	// cost: pillOptions keys on this list, and every scroll event is a render.
	const scoped = useMemo(
		() => (scopeLabel === undefined ? models : models.filter((model) => model.serverLabel === scopeLabel)),
		[models, scopeLabel]
	);
	// Keyed to the server count, not distinct labels: two groups can share a label and must
	// stay attributable. Under the server chip the same question is asked of the scoped
	// list itself; a one-group scope drops the suffix that would only repeat the chip.
	const scopedServers = useMemo(() => new Set(scoped.map((model) => model.scopeKey)).size, [scoped]);
	const showServerColumn = scopeLabel === undefined ? serverCount > 1 : scopedServers > 1;
	// The Server sort key can leave the control while picked (a scope hides it; a push can
	// drop the fleet to one group). The PICKED state stays, but while hidden the list must
	// not follow an order the control cannot display, so it renders and reads unsorted.
	const effectiveSort = sort?.key === "server" && !showServerColumn ? undefined : sort;
	const filtered = filterModels(scoped, pills, filter);
	const sorted = effectiveSort === undefined ? filtered : [...filtered].sort(compareBy(effectiveSort));
	// Offered pills derive from the scoped list (other servers' families are dead toggles
	// in a scope) - never from the pill-filtered list, or OR-within-a-dimension would be
	// unreachable. Memoized: every scroll event re-renders, and the options walk the list.
	// whole scoped list.
	const pillOptions = useMemo(() => modelFilterOptions(scoped, pills), [scoped, pills]);
	const textActive = filter.trim().length > 0;
	// Both clear actions unmount the button that was just pressed, so focus
	// would fall to the body and take the keyboard user's place with it; the
	// filter input is where the cleared filters live on.
	const filterInputRef = useRef<HTMLInputElement>(null);
	const clearFilters = () => {
		setFilter("");
		setPills(EMPTY_MODEL_FILTER);
		filterInputRef.current?.focus();
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

	// Which row is open, as a position in the list being rendered. Absent means
	// no row is open OR the open row has been sorted or filtered away; both are
	// the same thing to everything below.
	const openIndex = openRow === undefined ? -1 : sorted.findIndex((model) => rowIdOf(model) === openRow);
	// One row can be taller than the others, and only one. That is the whole
	// concession this list makes to variable heights: the delta is a single
	// number the layout adds in one place, not a per-row height table.
	const delta = openIndex >= 0 ? stripHeight : 0;

	// The window over the sorted rows. Start clamps against the row count so
	// a filter that shrinks the list under a deep scroll position cannot leave
	// the window past the end.
	const windowed = sorted.length > WINDOW_THRESHOLD;
	const viewport = (() => {
		const height = scrollRef.current?.clientHeight ?? 0;
		return height > 0 ? height : FALLBACK_VIEWPORT;
	})();
	// Scroll position maps to a row index through the uniform row height, which the open
	// row's detail breaks; taking the delta back out restores the uniform grid. Clamped so
	// a position INSIDE the open row maps to it rather than past it.
	const openTop = openIndex >= 0 ? openIndex * rowHeight : 0;
	const gridScrollTop = openIndex >= 0 ? scrollTop - Math.min(delta, Math.max(0, scrollTop - openTop)) : scrollTop;
	// The open row's detail eats into the window's coverage, so the window
	// grows by what the detail costs; otherwise a tall detail could push the
	// last rows of the viewport out of the rendered slice.
	const windowSize = Math.ceil((viewport + delta) / rowHeight) + OVERSCAN * 2;
	const start = windowed
		? Math.max(0, Math.min(Math.floor(gridScrollTop / rowHeight) - OVERSCAN, sorted.length - windowSize))
		: 0;
	const end = windowed ? Math.min(sorted.length, start + windowSize) : sorted.length;
	const visible = sorted.slice(start, end);
	// The spacers stand in for the rows outside the window, and the delta rides
	// with whichever one hides the open row. When the open row is rendered, its
	// detail is really there and neither spacer accounts for it.
	const leadingHeight = start * rowHeight + (openIndex >= 0 && openIndex < start ? delta : 0);
	const trailingHeight = (sorted.length - end) * rowHeight + (openIndex >= end ? delta : 0);

	return (
		// The id anchors a server row's model-count link: it navigates here and
		// App moves focus onto this section, so the keyboard position follows the
		// reader across the destination change. Section owns the id, the tabIndex
		// and the scroll margin together.
		<Section
			id="models"
			title={l10n.t("Models")}
			help={helpModelsSection()}
			docs={{ href: DOCS_LINK_MODELS, label: l10n.t("Open the models guide") }}
			// The count belongs to the title, and only while pills or text narrow: "showing 64 of
			// 64" at rest is a tautology. The scope moves the denominator, so a scoped-but-
			// unfiltered list stays quiet too.
			meta={sorted.length === scoped.length ? undefined : l10n.t("showing {0} of {1}", sorted.length, scoped.length)}
			// The filter's one home is the header line (the Settings filter's slot): it governs the
			// whole page, and a box floating between header and rows read as belonging to nothing.
			// The rows carry no header to sort by, so the sort control shares the line.
			// are no models.
			actions={
				models.length === 0 ? undefined : (
					<>
						<Input
							type="text"
							ref={filterInputRef}
							className="w-[16rem] min-w-0 max-w-full shrink"
							placeholder={l10n.t("Filter by name, family, or server")}
							aria-label={l10n.t("Filter models")}
							value={filter}
							onChange={(event) => setFilter(event.currentTarget.value)}
						/>
						<SortControl sort={effectiveSort} showServer={showServerColumn} onChange={setSort} />
					</>
				)
			}
		>
			{models.length === 0 ? (
				<div className="empty-block">
					{/* Two different nothings: with no servers, telling the reader to sync would send them
					    to ask nobody - they need a server first. With servers, a sync is exactly right. */}
					{serverCount === 0 ? (
						<>
							<p>{l10n.t("No models yet.")}</p>
							<p className="hint">{l10n.t("Add a server under Servers.")}</p>
						</>
					) : (
						<>
							<p>{l10n.t("No models discovered yet.")}</p>
							<p className="hint">{l10n.t("Run Sync models to ask your servers.")}</p>
						</>
					)}
				</div>
			) : (
				<>
					{/* The active scope as its own quiet line under the header: the
					    filter input and the count moved onto the header line, but the
					    chip is a STATE, not an action - it narrows what the whole page
					    below it shows, so it stands where that narrowing starts. */}
					{scope !== undefined ? (
						<div className="filterbar">
							<span className="chip">
								<span className="chip-label" title={l10n.t("Server: {0}", scope.label)}>
									{l10n.t("Server: {0}", scope.label)}
								</span>
								<Button
									variant="secondary"
									size="compact"
									aria-label={l10n.t("Clear the server filter")}
									onClick={scope.onClear}
								>
									<IconClose />
								</Button>
							</span>
						</div>
					) : null}
					<FilterPills
						options={pillOptions}
						active={pills}
						showServers={showServerColumn}
						showClear={isFilterActive(pills) && sorted.length > 0}
						onChange={setPills}
						onClearAll={clearFilters}
					/>
					{/* When windowed, the scrollport is a focusable labelled region (keyboard scrolling) and
					    each row declares its true position in a list only a window of which is in the DOM.
					    Visiting every row by Tab is out of scope: off-window rows are reached by scrolling. */}
					<section
						className={windowed ? "table-scroll windowed" : "table-scroll"}
						ref={scrollRef}
						aria-label={l10n.t("Models list")}
						tabIndex={windowed ? 0 : undefined}
						onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
					>
						<ul className="model-list">
							{start > 0 ? (
								<li className="spacer" role="presentation" style={{ height: `${leadingHeight}px` }} />
							) : null}
							{visible.map((model, index) => {
								const position = start + index;
								const rowId = rowIdOf(model);
								const isOpen = openIndex === position;
								const detailId = `model-detail-${position}`;
								const priced = isPriced(model);
								const caps = capabilityList(model);
								return (
									<li
										key={position}
										className={isOpen ? "model-row is-open group/row" : "model-row group/row"}
										{...(windowed ? { "aria-setsize": sorted.length, "aria-posinset": position + 1 } : {})}
									>
										<div className="model-row-line">
											{/* The two lines are the disclosure; the row's other controls sit outside (a button
											    cannot contain a button). border-control-outline like the server rows': transparent
											    in ordinary themes, the contrast border in the bordered modes. */}
											<button
												type="button"
												className="model-disclosure rounded-sm border border-control-outline"
												aria-expanded={isOpen}
												{...(isOpen ? { "aria-controls": detailId } : {})}
												onClick={() => setOpenRow(isOpen ? undefined : rowId)}
											>
												{/* The row's state mark. Without it a row that opens looks
												    exactly like one that does not, and the only way to find
												    out is to click. */}
												<DisclosureChevron className="model-chevron" />
												<span className="model-line-1">
													{/* The stylesheet's ellipsis cap for pathological names; the
													    full name stays in the DOM, only its rendering trims. */}
													<span className="model-name-text">{model.name}</span>
													<span className="model-meta">{metaLine(model, showServerColumn)}</span>
												</span>
												<span className="model-line-2">
													<span className="model-limits">
														{l10n.t(
															"{0} context, {1} out",
															compactTokens(model.maxInputTokens),
															compactTokens(model.maxOutputTokens)
														)}
													</span>
													{/* A real separator element, not a CSS ::after: it is text a
													    screen reader should hear, and it has to disappear WITH the
													    segment it follows when a narrow pane drops one, which an
													    adjacent-sibling rule does and a dangling dash does not. */}
													<span className="model-sep"> - </span>
													<span className="model-cost">
														{priced ? (
															<>
																<span className="model-price">
																	<PriceParts model={model} currencySymbol={currencySymbol} />
																</span>
																<span className="price-per"> {l10n.t("per M")}</span>
															</>
														) : (
															l10n.t("price unknown")
														)}
													</span>
													{/* Only what the model CAN do. The negative answer is one
													    click away in the detail rather than a second clause
													    every row carries forever. */}
													{caps.length > 0 ? (
														<>
															<span className="model-sep"> - </span>
															<span className="model-caps">{caps.join(", ")}</span>
														</>
													) : null}
												</span>
											</button>
											<span className="model-row-actions">
												{/* The server label keeps the accessible name unique when one
												    raw ID is registered through several servers. */}
												<Reveal within="row">
													<Button
														variant="secondary"
														size="compact"
														aria-label={l10n.t("Copy model ID {0} from {1}", model.id, model.serverLabel)}
														onClick={() => copyId(model, rowId)}
													>
														{copied === rowId ? <IconCheck /> : <IconCopy />}
													</Button>
												</Reveal>
												{/* Visible at rest rather than inside the detail: it is the
												    inspector's only entry point on this row, and burying it
												    one disclosure deep would cost every reader a click to
												    reach the panel that explains where a value came from. */}
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
											</span>
										</div>
										{isOpen ? (
											<ModelDetail id={detailId} model={model} currencySymbol={currencySymbol} ref={measureDetail} />
										) : null}
									</li>
								);
							})}
							{end < sorted.length ? (
								<li className="spacer" role="presentation" style={{ height: `${trailingHeight}px` }} />
							) : null}
						</ul>
					</section>
					{sorted.length === 0 ? (
						<p className="empty">
							{l10n.t("No models match the filter.")}
							{/* The way back, beside the sentence that needs it. Only when this
							    section's own filters caused the nothing: an empty scope is the
							    server chip's to clear, not this button's. */}
							{textActive || isFilterActive(pills) ? (
								<>
									{" "}
									<Button variant="secondary" size="compact" onClick={clearFilters}>
										{l10n.t("Clear filters")}
									</Button>
								</>
							) : null}
						</p>
					) : null}
				</>
			)}
		</Section>
	);
}
