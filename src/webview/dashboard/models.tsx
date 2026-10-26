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
import { trimHttpWhitespace } from "../../shared/util/headers";
import { compactTokenCount } from "../../shared/util/tokenCount";
import { DOCS_LINK_MODELS } from "./docsLinks";
import { helpModelsSection } from "./helpText";
import { IconArrowUp, IconCheck, IconClose, IconCopy } from "./icons";
import { tupleKey } from "./keys";
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
 * A cost per million tokens, trimmed to three significant digits (binary-fraction noise never renders). The symbol is
 * usage.currencySymbol verbatim; never converted.
 */
function formatCost(cost: number, currencySymbol: string): string {
	return `${currencySymbol}${Number(cost.toPrecision(3))}`;
}

/**
 * The row's price phrase as SEPARATE segments, so the floor tier can shed the output half whole with its own separator.
 * The output half is shedable only while the input half stands: an output-only price is the row's whole answer, and a
 * bare "per M" says nothing.
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
	// The output price steps down to secondary only beside an input price; alone, it is the whole figure.
	let outNode: React.ReactNode = null;
	if (outPart !== undefined) {
		outNode = inPart === undefined ? outPart : <span className="price-secondary">{outPart}</span>;
	}
	return (
		<>
			{inPart}
			{inPart !== undefined && outPart !== undefined ? <span className="price-sep"> / </span> : null}
			{outNode}
		</>
	);
}

/** The detail's cost fields, in the shared capability vocabulary: a field renamed in transit reads as another fact. */
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

function fieldLabel(name: string): string {
	return capabilityDisplayLabel(name) ?? name;
}

/**
 * The row's detail: its complete record AND the escape hatch for a clipped row - both lines end in an ellipsis, and
 * what they trim is exactly what a narrow pane loses first, so opening the row makes every field reachable without
 * pointing. `costs` reports whether any priced field made it in: the per-million note belongs to those.
 */
function detailFields(
	model: DashboardModel,
	currencySymbol: string
): {
	readonly fields: readonly { label: string; value: string; mono?: boolean }[];
	readonly costs: boolean;
} {
	const fields: { label: string; value: string; mono?: boolean }[] = [
		// What a request's `model` field actually carries, which is not always what the row is titled with.
		{ label: l10n.t("Model ID"), value: model.rawId, mono: true },
		{ label: l10n.t("Family"), value: model.family },
		{ label: l10n.t("Server"), value: model.serverLabel },
		{ label: fieldLabel("max_input_tokens"), value: formatTokens(model.maxInputTokens), mono: true },
		{
			//   A limit the request default sits under is a guess the extension capped -> worth saying so where the
			//   number is read
			label: fieldLabel("max_output_tokens"),
			value:
				model.defaultMaxTokens < model.maxOutputTokens
					? l10n.t("{0} (assumed)", formatTokens(model.maxOutputTokens))
					: formatTokens(model.maxOutputTokens),
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
	// Every capability, answered.
	//
	//   The row above prints only what the model can do -> this is where the negative answer lives
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
 * Its height is measured by the list (the window arithmetic needs it exactly), so the ref has to reach the outer
 * box.
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
 * Two provider groups may carry the SAME label, so scopeKey distinguishes them; a joined string is no identity either,
 * since labels and IDs both carry "/":
 *   "prod"        + "openai/gpt-4" -> prod/openai/gpt-4
 *   "prod/openai" + "gpt-4"        -> prod/openai/gpt-4
 */
function rowIdOf(model: DashboardModel): string {
	return tupleKey(model.scopeKey, model.serverLabel, model.id);
}

/**
 * The server joins only when there is more than one to tell apart; a declared model says so here rather than wearing a
 * badge, because it is the same kind of fact as the family.
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

/** The price key is defined exactly where the row prints a price (isPriced), so the sort, the pill, and the row agree. */
const SORT_VALUES: Record<SortKey, (model: DashboardModel) => string | number | undefined> = {
	name: (model) => model.name.toLowerCase(),
	family: (model) => model.family.toLowerCase(),
	server: (model) => model.serverLabel.toLowerCase(),
	input: (model) => model.maxInputTokens,
	output: (model) => model.maxOutputTokens,
	price: (model) => (isPriced(model) ? (model.inputCost ?? 0) + (model.outputCost ?? 0) : undefined),
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

const SORT_LABELS: Record<SortKey, () => string> = {
	name: () => l10n.t("Model"),
	family: () => l10n.t("Family"),
	server: () => l10n.t("Server"),
	input: () => l10n.t("Input tokens"),
	output: () => l10n.t("Output tokens"),
	price: () => l10n.t("Price"),
};

const SORT_KEYS = Object.keys(SORT_LABELS) as readonly SortKey[];

const UNSORTED = "discovered";

/**
 * Sorting without column headers: the control moves onto the section's header line. A native select, matching the
 * host's own dropdowns; direction is a separate toggle because folding it in would double the options. The unsorted
 * state is a real choice, not the absence of one: it is the order the servers reported.
 */
function SortControl({
	sort,
	showServer,
	onChange,
}: {
	/** The current sort; undefined is the "As discovered" option, and it disables the direction toggle. */
	sort: Sort | undefined;

	/** One server means no Server key to sort by; the same rule that hides it from the rows. */
	showServer: boolean;

	/** A chosen key starts ascending; the toggle flips the direction on the same key; "As discovered" posts undefined. */
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
			{/* Pressed is the descending state, so the control announces which way the list runs. text-foreground steps
			    the glyph up out of secondary's resting tier - a bare direction arrow is not an action wearing the
			    accent, and at any quieter tier the ENABLED arrow read as its own disabled state, which is dimmed twice
			    below it. */}
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
 * Free-text pills pass `title` so a truncated label survives on hover; fixed-vocabulary pills leave it off, or every
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
 * The structured filters, one wrapping row of pills in the columnar tier's column order, so they read as a legend for
 * the rows.
 *
 *   Which pills exist -> is the options' business (modelFilterOptions)
 *   the server group  -> follows the rows' own rule
 *
 * onChange takes an updater because two toggles in one React batch would otherwise both derive from the same stale
 * `active`, and the second would silently undo the first.
 */
function FilterPills({
	options,
	active,
	showServers,
	showClear,
	onChange,
	onClearAll,
}: {
	/** Which pills exist, per group (modelFilterOptions); the server group is further gated by showServers. */
	options: ModelFilterOptions;

	/** The pressed pills; every pill reads its pressed state from here, none keeps its own. */
	active: ModelFilter;

	/** The rows' serverCount > 1 rule; the options' own two-server rule still applies under it. */
	showServers: boolean;

	/** Parent-decided: an emptied list renders its own "Clear filters", and two identical controls a line apart mislead. */
	showClear: boolean;

	/** An updater, never a computed state: two toggles in one batch would both derive from the same stale `active`. */
	onChange: (update: (filter: ModelFilter) => ModelFilter) => void;

	/** The section's clearFilters: pills and text together, with focus moved to the filter input the button leaves. */
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
			// When one server serves, dead server toggles hide with the rows' own rule - but a pill still PRESSED from
			// when there were two must stay visible, or the filter it applies would have no control to unpress.
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

/** Rows past which the list windows; the arithmetic runs on the first rendered row's measured height. */
const WINDOW_THRESHOLD = 50;

/** The row height until one is measured; exported so the tests measure against the component's own number. */
export const DEFAULT_ROW_HEIGHT = 46;

/** Rows rendered past each edge of the scrollport, so a fast scroll meets rows rather than blank. */
const OVERSCAN = 10;

/** The scrollport's height before measurement: too small blanks a strip until a scroll, too large costs rows once. */
const FALLBACK_VIEWPORT = 1000;

/** What the list's scrollport knows about itself: its element, scroll offset, one row's height, and its own height. */
interface Scrollport {
	readonly ref: React.RefObject<HTMLElement | null>;
	readonly scrollTop: number;
	readonly setScrollTop: (top: number) => void;
	readonly rowHeight: number;
	readonly viewport: number;
}

/** The open row's detail: its measured height and the ref callback that measures it. */
interface DetailStrip {
	readonly height: number;
	readonly measure: (element: HTMLDivElement | null) => void;
}

interface CopyFlash {
	readonly copied: string | undefined;
	readonly copy: (model: DashboardModel, rowId: string) => void;
}

/** The list after scope, filter, and sort, with what the controls may show for it. */
interface ModelListing {
	readonly scoped: readonly DashboardModel[];
	readonly sorted: readonly DashboardModel[];
	readonly pillOptions: ModelFilterOptions;
	readonly showServerColumn: boolean;
	readonly effectiveSort: Sort | undefined;
}

interface WindowInput {
	readonly count: number;
	readonly scrollTop: number;
	readonly rowHeight: number;
	readonly viewport: number;
	readonly openIndex: number;
	readonly delta: number;
}

/** The rendered slice of the list and the spacers standing in for the rest. */
interface ListWindow {
	readonly windowed: boolean;
	readonly start: number;
	readonly end: number;
	readonly leadingHeight: number;
	readonly trailingHeight: number;
}

/** The open row's index in the current order and the window around it. */
interface ListLayout {
	readonly openIndex: number;
	readonly slice: ListWindow;
}

interface ModelRowProps {
	readonly model: DashboardModel;
	readonly position: number;
	readonly open: boolean;
	readonly setsize: number | undefined;
	readonly showServer: boolean;
	readonly currencySymbol: string;
	readonly copied: boolean;
	readonly onToggle: () => void;
	readonly onCopy: () => void;
	readonly onInspect: () => void;
	readonly measureDetail: (element: HTMLDivElement | null) => void;
}

interface ModelRowLineProps {
	readonly model: DashboardModel;
	readonly showServer: boolean;
	readonly currencySymbol: string;
}

interface ModelRowActionsProps {
	readonly model: DashboardModel;
	readonly copied: boolean;
	readonly onCopy: () => void;
	readonly onInspect: () => void;
}

interface ModelListProps {
	readonly rows: readonly DashboardModel[];
	readonly scopeLabel: string | undefined;
	readonly showServer: boolean;
	readonly currencySymbol: string;
	readonly onInspect: (target: InspectTarget) => void;
}

/** The server scope narrowing the page, with the clear the chip offers; one object so a scope without a working clear cannot exist. */
interface ModelScope {
	readonly label: string;
	readonly onClear: () => void;
}

/** The row's full identity, since one snapshot can render under several labels. */
interface InspectTarget {
	scopeKey: string;
	rawId: string;
	serverLabel: string;
}

interface ModelsToolbarProps {
	readonly filter: string;
	readonly filterInputRef: React.RefObject<HTMLInputElement | null>;
	readonly onFilter: (next: string) => void;
	readonly listing: ModelListing;
	readonly onSort: (sort: Sort | undefined) => void;
}

interface EmptyModelsProps {
	readonly serverCount: number;
}

interface ScopeChipProps {
	readonly scope: ModelScope;
}

interface NoMatchProps {
	readonly canClear: boolean;
	readonly onClear: () => void;
}

/**
 * Publishes the scrollport's document-relative top as --models-scroll-top. Document-relative, not viewport-relative: a
 * viewport-relative top shrinks as the reader scrolls, raising the cap, lengthening the page, allowing more scroll - a
 * feedback loop; document-relative names the same distance at every position, so the budget has a fixed point.
 *
 * Measured before paint and re-measured on box changes (first layout, breakpoints reflowing, panel shown - panels stay
 * mounted, so this runs while hidden); a zero box is skipped rather than published as top 0.
 */
function useScrollTopVariable(ref: React.RefObject<HTMLElement | null>): void {
	useLayoutEffect(() => {
		const element = ref.current;
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
		// The pill row above wraps and unwraps as filters change, which MOVES this scrollport without resizing it - and
		// a pure position change fires no ResizeObserver on the element itself. It does resize the parent the two
		// share, so the parent is observed too and the moved top republishes.
		if (element.parentElement !== null) {
			observer.observe(element.parentElement);
		}
		window.addEventListener("resize", publish, { passive: true });
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", publish);
		};
	}, [ref]);
}

/**
 * The scrollport's own state. The row height is re-measured after every render: the guarded set makes this settle in
 * one extra pass when the theme's font size changes the real row height. The row's first line, not the whole row: an
 * open row is taller by its detail, and the uniform height the window arithmetic runs on is the line's.
 *
 * A new scope means a new list, so the scrollport rewinds: a scroll position inherited from the previous server would
 * drop the reader mid-list (the window clamp keeps it in range, but not at the top).
 */
function useScrollport(scopeLabel: string | undefined): Scrollport {
	const ref = useRef<HTMLElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
	useEffect(() => {
		const line = ref.current?.querySelector<HTMLElement>(".model-row-line");
		const measured = line?.offsetHeight ?? 0;
		if (measured > 0 && measured !== rowHeight) {
			setRowHeight(measured);
		}
	});
	useScrollTopVariable(ref);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scopeLabel is the deliberate rewind key (see above)
	useEffect(() => {
		if (ref.current !== null) {
			ref.current.scrollTop = 0;
		}
		setScrollTop(0);
	}, [scopeLabel]);
	const height = ref.current?.clientHeight ?? 0;
	return { ref, scrollTop, setScrollTop, rowHeight, viewport: height > 0 ? height : FALLBACK_VIEWPORT };
}

/**
 * A ref callback rather than an effect: the ELEMENT comes and goes for a reason no dependency list names - the open
 * row is itself windowed.
 *
 * Unmounting deliberately does NOT clear the height: a detail scrolled out of the window is still part of the list's
 * height (its spacer carries it); the null arm stays although React 19 makes it unreachable, because leaving the
 * height alone is correct on either path.
 */
function useDetailStrip(): DetailStrip {
	const [height, setHeight] = useState(0);
	const measure = useCallback((element: HTMLDivElement | null) => {
		if (element === null) {
			return;
		}
		const measureNow = () => {
			const measured = element.offsetHeight;
			setHeight((current) => (measured > 0 && measured !== current ? measured : current));
		};
		measureNow();
		// The detail's own field grid rewraps with the panel width, which changes its height without remounting it.
		const observer = new ResizeObserver(measureNow);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return { height, measure };
}

/** The copy button's check mark: shown on the row just copied, for a moment, and restarted by a second copy. */
function useCopyFlash(): CopyFlash {
	const [copied, setCopied] = useState<string | undefined>(undefined);
	const copySeq = useRef(0);
	const copy = (model: DashboardModel, rowId: string) => {
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
	return { copied, copy };
}

/**
 * The list under scope, filter, and sort. The Server sort key can leave the control while picked (a scope hides it; a
 * push can drop the fleet to one group). The PICKED state stays, but while hidden the list must not follow an order
 * the control cannot display, so it renders and reads unsorted.
 */
function useModelListing(
	models: readonly DashboardModel[],
	serverCount: number,
	scopeLabel: string | undefined,
	filter: string,
	pills: ModelFilter,
	sort: Sort | undefined
): ModelListing {
	// Memoized for identity, not cost: pillOptions keys on this list, and every scroll event is a render.
	const scoped = useMemo(
		() => (scopeLabel === undefined ? models : models.filter((model) => model.serverLabel === scopeLabel)),
		[models, scopeLabel]
	);
	// Keyed to the server count, not distinct labels: two groups can share a label and must stay attributable. Under
	// the server chip the same question is asked of the scoped list itself; a one-group scope drops the suffix that
	// would only repeat the chip.
	const scopedServers = useMemo(() => new Set(scoped.map((model) => model.scopeKey)).size, [scoped]);
	const showServerColumn = scopeLabel === undefined ? serverCount > 1 : scopedServers > 1;
	const effectiveSort = sort?.key === "server" && !showServerColumn ? undefined : sort;
	const filtered = filterModels(scoped, pills, filter);
	const sorted = effectiveSort === undefined ? filtered : [...filtered].sort(compareBy(effectiveSort));
	// Offered pills derive from the scoped list (other servers' families are dead toggles in a scope) - never from the
	// pill-filtered list, or OR-within-a-dimension would be unreachable. Memoized: every scroll event re-renders, and
	// the options walk the list.
	const pillOptions = useMemo(() => modelFilterOptions(scoped, pills), [scoped, pills]);
	return { scoped, sorted, pillOptions, showServerColumn, effectiveSort };
}

/**
 * Scroll position maps to a row index through the uniform row height, which the open row's detail breaks; taking the
 * delta back out restores the uniform grid, clamped so a position INSIDE the open row maps to it rather than past it.
 *
 * The detail eats into the window's coverage, so the window grows by what the detail costs; otherwise a tall detail
 * could push the last rows of the viewport out of the rendered slice. Start clamps against the row count so a filter
 * that shrinks the list under a deep scroll position cannot leave the window past the end.
 *
 * The spacers stand in for the rows outside the window, and the delta rides with whichever one hides the open row;
 * when the open row is rendered, its detail is really there and neither spacer accounts for it.
 */
function listWindow({ count, scrollTop, rowHeight, viewport, openIndex, delta }: WindowInput): ListWindow {
	const windowed = count > WINDOW_THRESHOLD;
	const openTop = openIndex >= 0 ? openIndex * rowHeight : 0;
	const gridScrollTop = openIndex >= 0 ? scrollTop - Math.min(delta, Math.max(0, scrollTop - openTop)) : scrollTop;
	const windowSize = Math.ceil((viewport + delta) / rowHeight) + OVERSCAN * 2;
	const start = windowed
		? Math.max(0, Math.min(Math.floor(gridScrollTop / rowHeight) - OVERSCAN, count - windowSize))
		: 0;
	const end = windowed ? Math.min(count, start + windowSize) : count;
	return {
		windowed,
		start,
		end,
		leadingHeight: start * rowHeight + (openIndex >= 0 && openIndex < start ? delta : 0),
		trailingHeight: (count - end) * rowHeight + (openIndex >= end ? delta : 0),
	};
}

/**
 * Where the open row sits and what the window renders. Absent (-1) means no row is open OR the open row has been sorted
 * or filtered away; both are the same thing to everything below. One row can be taller than the others, and only one:
 * the delta is a single number the layout adds in one place, not a per-row height table.
 */
function useListLayout(
	sorted: readonly DashboardModel[],
	openRow: string | undefined,
	scrollport: Scrollport,
	detail: DetailStrip
): ListLayout {
	const openIndex = openRow === undefined ? -1 : sorted.findIndex((model) => rowIdOf(model) === openRow);
	const slice = listWindow({
		count: sorted.length,
		scrollTop: scrollport.scrollTop,
		rowHeight: scrollport.rowHeight,
		viewport: scrollport.viewport,
		openIndex,
		delta: openIndex >= 0 ? detail.height : 0,
	});
	return { openIndex, slice };
}

/**
 * Two different nothings: with no servers, telling the reader to sync would send them to ask nobody - they need a
 * server first. With servers, a sync is exactly right.
 */
function EmptyModels({ serverCount }: EmptyModelsProps) {
	return (
		<div className="empty-block">
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
	);
}

/**
 * The active scope as its own quiet line under the header: the filter input and the count moved onto the header
 * line, but the chip is a STATE, not an action - it narrows what the whole page below it shows, so it stands where
 * that narrowing starts.
 */
function ScopeChip({ scope }: ScopeChipProps) {
	return (
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
	);
}

/** The two text lines of a row: the name with its meta, then limits, price, and capabilities. */
function ModelRowLine({ model, showServer, currencySymbol }: ModelRowLineProps) {
	const caps = capabilityList(model);
	const priced = isPriced(model);
	return (
		<>
			<span className="model-line-1">
				{/* The stylesheet's ellipsis cap for pathological names; the
				    full name stays in the DOM, only its rendering trims. */}
				<span className="model-name-text">{model.name}</span>
				<span className="model-meta">{metaLine(model, showServer)}</span>
			</span>
			<span className="model-line-2">
				<span className="model-limits">
					{l10n.t(
						"{0} context, {1} out",
						compactTokenCount(model.maxInputTokens),
						compactTokenCount(model.maxOutputTokens)
					)}
				</span>
				{/* A real separator element, not a CSS ::after: it is text a
				    screen reader should hear, and it has to disappear WITH the
				    segment it follows when a narrow pane drops one, which an
				    adjacent-sibling rule does and a dangling dash does not. */}
				{/* An unpriced model prints NOTHING here: the whole segment
				    stays out, separator included, rather than wording the
				    absence. The unpriced pill still names the class in words. */}
				{priced ? (
					<>
						<span className="model-sep"> - </span>
						<span className="model-cost">
							<span className="model-price">
								<PriceParts model={model} currencySymbol={currencySymbol} />
							</span>
							<span className="price-per"> {l10n.t("per M")}</span>
						</span>
					</>
				) : null}
				{/* Only what the model CAN do. The negative answer is one click
				    away in the detail rather than a second clause every row
				    carries forever. */}
				{caps.length > 0 ? (
					<>
						<span className="model-sep"> - </span>
						<span className="model-caps">{caps.join(", ")}</span>
					</>
				) : null}
			</span>
		</>
	);
}

/**
 * The row's two actions. The server label keeps the copy button's accessible name unique when one raw ID is
 * registered through several servers. Inspect is visible at rest rather than inside the detail: it is the inspector's
 * only entry point on this row, and burying it one disclosure deep would cost every reader a click to reach the panel
 * that explains where a value came from.
 */
function ModelRowActions({ model, copied, onCopy, onInspect }: ModelRowActionsProps) {
	return (
		<span className="model-row-actions">
			<Reveal within="row">
				<Button
					variant="secondary"
					size="compact"
					aria-label={l10n.t("Copy model ID {0} from {1}", model.id, model.serverLabel)}
					onClick={onCopy}
				>
					{copied ? <IconCheck /> : <IconCopy />}
				</Button>
			</Reveal>
			<Button
				variant="secondary"
				size="compact"
				className="params-action"
				aria-label={l10n.t("Inspect {0} on {1}", model.name, model.serverLabel)}
				onClick={onInspect}
			>
				{l10n.t("Inspect")}
			</Button>
		</span>
	);
}

/**
 * One row: the two lines are the disclosure; the row's other controls sit outside (a button cannot contain a button).
 * border-control-outline like the server rows': transparent in ordinary themes, the contrast border in the bordered
 * modes. `setsize` is the list's true length while windowed, since only a window of it is in the DOM.
 */
function ModelRow(props: ModelRowProps) {
	const { model, position, open, setsize, showServer, currencySymbol, copied, onToggle, onCopy, onInspect } = props;
	const detailId = `model-detail-${position}`;
	return (
		<li
			className={open ? "model-row is-open group/row" : "model-row group/row"}
			{...(setsize === undefined ? {} : { "aria-setsize": setsize, "aria-posinset": position + 1 })}
		>
			<div className="model-row-line">
				<button
					type="button"
					className="model-disclosure rounded-sm border border-control-outline"
					aria-expanded={open}
					{...(open ? { "aria-controls": detailId } : {})}
					onClick={onToggle}
				>
					{/* Without it a row that opens looks exactly like one that does
					    not, and the only way to find out is to click. */}
					<DisclosureChevron className="model-chevron" />
					<ModelRowLine model={model} showServer={showServer} currencySymbol={currencySymbol} />
				</button>
				<ModelRowActions model={model} copied={copied} onCopy={onCopy} onInspect={onInspect} />
			</div>
			{open ? (
				<ModelDetail id={detailId} model={model} currencySymbol={currencySymbol} ref={props.measureDetail} />
			) : null}
		</li>
	);
}

/**
 * When windowed, the scrollport is a focusable labelled region (keyboard scrolling) and each row declares its true
 * position in a list only a window of which is in the DOM. Visiting every row by Tab is out of scope: off-window rows
 * are reached by scrolling.
 */
function ModelList({ rows, scopeLabel, showServer, currencySymbol, onInspect }: ModelListProps) {
	// The one open row, held by row id rather than index: sorting and filtering renumber the list.
	const [openRow, setOpenRow] = useState<string | undefined>(undefined);
	const scrollport = useScrollport(scopeLabel);
	const detail = useDetailStrip();
	const copyFlash = useCopyFlash();
	const { openIndex, slice } = useListLayout(rows, openRow, scrollport, detail);
	const visible = rows.slice(slice.start, slice.end);
	return (
		<section
			className={slice.windowed ? "table-scroll windowed" : "table-scroll"}
			ref={scrollport.ref}
			aria-label={l10n.t("Models list")}
			tabIndex={slice.windowed ? 0 : undefined}
			onScroll={(event) => scrollport.setScrollTop(event.currentTarget.scrollTop)}
		>
			<ul className="model-list">
				{slice.start > 0 ? (
					<li className="spacer" role="presentation" style={{ height: `${slice.leadingHeight}px` }} />
				) : null}
				{visible.map((model, index) => {
					const position = slice.start + index;
					const rowId = rowIdOf(model);
					const open = openIndex === position;
					return (
						<ModelRow
							key={position}
							model={model}
							position={position}
							open={open}
							setsize={slice.windowed ? rows.length : undefined}
							showServer={showServer}
							currencySymbol={currencySymbol}
							copied={copyFlash.copied === rowId}
							onToggle={() => setOpenRow(open ? undefined : rowId)}
							onCopy={() => copyFlash.copy(model, rowId)}
							onInspect={() =>
								onInspect({ scopeKey: model.scopeKey, rawId: model.rawId, serverLabel: model.serverLabel })
							}
							measureDetail={detail.measure}
						/>
					);
				})}
				{slice.end < rows.length ? (
					<li className="spacer" role="presentation" style={{ height: `${slice.trailingHeight}px` }} />
				) : null}
			</ul>
		</section>
	);
}

/** The "nothing matches" line; its Clear button only when this section's own filters caused the nothing. */
function NoMatch({ canClear, onClear }: NoMatchProps) {
	return (
		<p className="empty">
			{l10n.t("No models match the filter.")}
			{/* Only when this section's own filters caused the nothing: an empty scope is the
			    server chip's to clear, not this button's. */}
			{canClear ? (
				<>
					{" "}
					<Button variant="secondary" size="compact" onClick={onClear}>
						{l10n.t("Clear filters")}
					</Button>
				</>
			) : null}
		</p>
	);
}

/** The filter box's ref and the clear both Clear buttons share. */
interface FilterReset {
	readonly inputRef: React.RefObject<HTMLInputElement | null>;
	readonly clearFilters: () => void;
}

/**
 * Both clear actions unmount the button that was just pressed, so focus would fall to the body and take the keyboard
 * user's place with it; the filter input is where the cleared filters live on.
 */
function useFilterReset(onFilter: (next: string) => void, onPills: (next: ModelFilter) => void): FilterReset {
	const inputRef = useRef<HTMLInputElement>(null);
	return {
		inputRef,
		clearFilters: () => {
			onFilter("");
			onPills(EMPTY_MODEL_FILTER);
			inputRef.current?.focus();
		},
	};
}

/**
 * The count belongs to the title, and only while pills or text narrow: "showing 64 of 64" at rest is a tautology. The
 * scope moves the denominator, so a scoped-but-unfiltered list stays quiet too.
 */
function showingMeta(listing: ModelListing): string | undefined {
	const shown = listing.sorted.length;
	const total = listing.scoped.length;
	return shown === total ? undefined : l10n.t("showing {0} of {1}", shown, total);
}

/**
 * The models toolbar on the header line. The filter's one home is the header line (the Settings filter's slot): it
 * governs the whole page, and a box floating between header and rows read as belonging to nothing. The rows carry no
 * header to sort by, so the sort control shares the line.
 */
function ModelsToolbar({ filter, filterInputRef, onFilter, listing, onSort }: ModelsToolbarProps) {
	return (
		<>
			<Input
				type="text"
				ref={filterInputRef}
				className="w-[16rem] min-w-0 max-w-full shrink"
				placeholder={l10n.t("Filter by name, family, or server")}
				aria-label={l10n.t("Filter models")}
				value={filter}
				onChange={(event) => onFilter(event.currentTarget.value)}
			/>
			<SortControl sort={listing.effectiveSort} showServer={listing.showServerColumn} onChange={onSort} />
		</>
	);
}

/**
 * The Models page: every discovered model across the servers, filtered, sorted, and windowed. The id anchors a server
 * row's model-count link: it navigates here and App moves focus onto this section, so the keyboard position follows
 * the reader across the destination change. Section owns the id, the tabIndex and the scroll margin together.
 *
 *   serverCount    -> the configured servers; unscoped, a single one hides the Server column, pill group, and sort key
 *                     alike
 *   currencySymbol -> the configured cost prefix (usage.currencySymbol); display only, never a conversion
 *   scope          -> one object so a scope without a working clear cannot be expressed
 *   onInspect      -> App owns the inspector; the full identity travels because one snapshot can render under several
 *                     labels
 */
export function ModelsSection({
	models,
	serverCount,
	currencySymbol,
	scope,
	onInspect,
}: {
	models: readonly DashboardModel[];
	serverCount: number;
	currencySymbol: string;
	scope?: ModelScope | undefined;
	onInspect: (target: InspectTarget) => void;
}) {
	const [filter, setFilter] = useState("");
	const [pills, setPills] = useState<ModelFilter>(EMPTY_MODEL_FILTER);
	const [sort, setSort] = useState<Sort | undefined>(undefined);
	const listing = useModelListing(models, serverCount, scope?.label, filter, pills, sort);
	const reset = useFilterReset(setFilter, setPills);
	const canClear = trimHttpWhitespace(filter).length > 0 || isFilterActive(pills);
	return (
		<Section
			id="models"
			title={l10n.t("Models")}
			help={helpModelsSection()}
			docs={{ href: DOCS_LINK_MODELS, label: l10n.t("Open the models guide") }}
			meta={showingMeta(listing)}
			actions={
				models.length === 0 ? undefined : (
					<ModelsToolbar
						filter={filter}
						filterInputRef={reset.inputRef}
						onFilter={setFilter}
						listing={listing}
						onSort={setSort}
					/>
				)
			}
		>
			{models.length === 0 ? (
				<EmptyModels serverCount={serverCount} />
			) : (
				<>
					{scope === undefined ? null : <ScopeChip scope={scope} />}
					<FilterPills
						options={listing.pillOptions}
						active={pills}
						showServers={listing.showServerColumn}
						showClear={isFilterActive(pills) && listing.sorted.length > 0}
						onChange={setPills}
						onClearAll={reset.clearFilters}
					/>
					<ModelList
						rows={listing.sorted}
						scopeLabel={scope?.label}
						showServer={listing.showServerColumn}
						currencySymbol={currencySymbol}
						onInspect={onInspect}
					/>
					{listing.sorted.length === 0 ? <NoMatch canClear={canClear} onClear={reset.clearFilters} /> : null}
				</>
			)}
		</Section>
	);
}
