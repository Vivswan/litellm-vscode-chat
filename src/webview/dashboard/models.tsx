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
 * A cost per million tokens, trimmed to three significant digits: enough to
 * compare models at a glance, and binary-fraction noise never renders. The
 * symbol is the configured usage.currencySymbol, verbatim (empty renders the
 * bare number); amounts are never converted.
 */
function formatCost(cost: number, currencySymbol: string): string {
	return `${currencySymbol}${Number(cost.toPrecision(3))}`;
}

function formatPricing(model: DashboardModel, currencySymbol: string): string {
	if (model.inputCost === undefined && model.outputCost === undefined) {
		return "-";
	}
	const parts: string[] = [];
	if (model.inputCost !== undefined) {
		parts.push(
			l10n.t({
				message: "{0} in",
				args: [formatCost(model.inputCost, currencySymbol)],
				comment: ["price per million input tokens; {0} is a currency amount"],
			})
		);
	}
	if (model.outputCost !== undefined) {
		parts.push(
			l10n.t({
				message: "{0} out",
				args: [formatCost(model.outputCost, currencySymbol)],
				comment: ["price per million output tokens; {0} is a currency amount"],
			})
		);
	}
	return parts.join(" / ");
}

/**
 * The cost fields the detail can show, paired with the capability wire key
 * that names them. The names come from the shared capability vocabulary rather
 * than being minted here: the reader moves between this row and the inspector,
 * and a field that changed its name in transit would read as a different fact.
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
 * What the row's detail says. Two jobs, and the second is the reason it holds
 * facts the lines above it already show.
 *
 * It is the row's complete record: the cache and long-context prices used to
 * live in a hover tip on the price cell, reachable only by pointing at it, and
 * the exact token limits and the raw model ID had nowhere at all - the ID was
 * readable only from the copy button's accessible name.
 *
 * It is also the escape hatch for a clipped row. Both of the row's lines are
 * single-line and end in an ellipsis, and what sits at the end of them - the
 * server, the declared note, the price, the capabilities - is exactly what a
 * narrow pane trims away first. The old table answered that with a
 * hover-and-focus tip on the capabilities cell; opening the row answers it for
 * every field at once, so nothing is reachable only by pointing.
 *
 * `costs` reports whether any priced field made it in, because the per-million
 * note belongs to those fields: printed beside a detail that names no price it
 * would explain a unit nothing here uses.
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
 * Token counts at a glance: "128k", not "128,000". The row's second line is a
 * sentence to be skimmed, and four exact digits in the middle of one are read
 * rather than seen. The exact figure keeps a home in the row's detail, where
 * someone comparing limits is actually looking.
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
 * A row's identity, used for the copy flash and for the open row - both of
 * which have to survive the list being re-sorted or re-filtered under them, and
 * neither of which may land on a different row than the one clicked.
 *
 * The label alone is not an identity: two provider groups may carry the SAME
 * label (which is why the Server column keyed off the count rather than the
 * distinct labels), so two rows for one model ID would collide and open or
 * flash each other. scopeKey is the per-server handle that actually
 * distinguishes them; the label stays because it is what the reader sees.
 */
function rowIdOf(model: DashboardModel): string {
	return `${model.scopeKey}/${model.serverLabel}/${model.id}`;
}

/**
 * The quiet half of the row's first line: what the model is, after its name.
 * The server joins it only when there is more than one to tell apart - the
 * same rule the Server column used - and a declared model says so here rather
 * than wearing a badge, because it is the same kind of fact as the family.
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
 * Sorting, once the rows stopped being a grid. Column headers carried both
 * halves of it - which key, and which direction - and a two-line row has no
 * header to carry them, so the control moves onto the section's header line
 * where the other destinations already keep their actions.
 *
 * A native select rather than a menu: the host's own dropdowns are native, its
 * popup is the platform's, and the sorted-by state reads out of a labelled
 * control without inventing a listbox. Direction is a separate toggle because
 * it is a separate question - folding it in would double the options and make
 * the reader scan six pairs to find one key.
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
			{/* Pressed is the descending state, so the control announces which way
			    the list runs rather than only what the click will do. Disabled
			    while unsorted: there is no direction to flip. text-foreground
			    steps the glyph up from secondary's muted tier (6.1:1 on the dark
			    editor background) to 10.3:1 dark / 11.2:1 light - at the muted
			    tier the ENABLED arrow read as its own disabled state, which is
			    dimmed twice below it (disabledForeground times opacity-60). */}
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
 * One filter pill: a toggle button in the chip vocabulary - outline at rest,
 * the soft chip fill when pressed - with aria-pressed carrying the state.
 * Free-text pills (family, server) pass `title` so a truncated label survives
 * on hover; the fixed-vocabulary pills leave it off, or every reader would be
 * fed a description repeating the name it just announced.
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
 * The structured filters, one wrapping row of toggle pills between the toolbar
 * and the list. The dimensions run in the columnar tier's column order -
 * family and server (the identity column's two facts), then price, then
 * capabilities - so the pills read as a legend for the rows under them.
 *
 * Which pills exist is the options' business (see modelFilterOptions); this
 * component only draws what it is handed, the clear-all action included
 * (showClear). The server group additionally follows the rows' own rule: one
 * server serving means no server names anywhere on this page.
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
	 * Whether this row carries the clear-all action. The parent decides, not
	 * isFilterActive alone: when the pressed pills empty the list, the empty
	 * state directly below renders its own "Clear filters" beside the sentence
	 * that needs it, and two identical controls a line apart read as two
	 * different actions.
	 */
	showClear: boolean;
	/**
	 * Takes an updater, never a computed state: two toggles in one React batch
	 * would otherwise both derive from the same stale `active` and the second
	 * would silently undo the first.
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
 * Windowing constants. The stylesheet's row height is only a minimum (a larger
 * host font grows the rows), so the arithmetic runs on the first rendered
 * row's measured height and DEFAULT_ROW_HEIGHT is the fallback while nothing
 * is measurable - which is permanently the case in the happy-dom suite, where
 * offsetHeight is always 0; the tests exercise the fallback path only. The
 * threshold keeps small fleets on the simple full-render path, and the
 * overscan hides the window edges while scrolling.
 */
const WINDOW_THRESHOLD = 50;
/** Exported so the tests measure against the component's own number instead of a copy that can drift. */
export const DEFAULT_ROW_HEIGHT = 46;
const OVERSCAN = 10;
/**
 * The scrollport's height before there is a scrollport to measure - the very
 * first render, where the ref is still null. Generous on purpose: too small
 * renders fewer rows than the viewport shows and leaves a blank strip under the
 * last one until the first scroll, while too large only costs a few extra rows
 * on one paint.
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
	const [pills, setPills] = useState<ModelFilter>(EMPTY_MODEL_FILTER);
	const [sort, setSort] = useState<Sort | undefined>(undefined);
	const [scrollTop, setScrollTop] = useState(0);
	const [copied, setCopied] = useState<string | undefined>(undefined);
	const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
	/**
	 * The one open row, held by row id rather than index: sorting and filtering
	 * both renumber the list, and an index would silently follow the position
	 * instead of the model. When the open row leaves the list entirely there is
	 * simply nothing to match, which is the right answer without a special case.
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

	// The open row's detail height. Measured, not assumed: the window arithmetic
	// below adds it to whichever spacer stands in for the open row, and a wrong
	// number there shifts every row under it.
	//
	// A ref callback rather than an effect, because the thing being watched is
	// the ELEMENT, and the element comes and goes for a reason no dependency
	// list names: the open row is itself windowed, so scrolling far enough
	// unmounts the detail and scrolling back mounts a fresh one. An effect keyed
	// on the open row would not re-run for that, leaving the observer bound to a
	// detached node and the height frozen at whatever it was when the row left.
	//
	// Unmounting deliberately does NOT clear the height. A detail scrolled out
	// of the window is still part of the list's height - the spacer standing in
	// for its row carries it - so zeroing it would make the list claim less than
	// it occupies and shift every row below. React 19 calls the returned cleanup
	// rather than re-invoking with null, so the null arm is unreachable there;
	// it stays because leaving the height alone is the correct answer on either
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

	// Three independent conditions compose AND, narrowing in this order: the
	// scope (the server chip), then the pills, then the text. The header's
	// "showing N of M" count reads sorted.length over scoped.length, so pills
	// and text both move N live while the scope moves M.
	// Memoized for identity, not for the filter's cost: pillOptions below keys
	// on this list, and a fresh array every render (every scroll event is one)
	// would make that memo a no-op whenever a scope is active.
	const scoped = useMemo(
		() => (scopeLabel === undefined ? models : models.filter((model) => model.serverLabel === scopeLabel)),
		[models, scopeLabel]
	);
	// Keyed to the server count, not the distinct labels: two groups can share
	// a label, and their models must stay attributable. Under the server chip
	// the same question is asked of the scoped list itself - a scope is a
	// LABEL, so two groups sharing it are both inside, and they keep their
	// server UI (the numbered pills are the only thing telling them apart) -
	// while a one-group scope drops the suffix that would only repeat the chip.
	const scopedServers = useMemo(() => new Set(scoped.map((model) => model.scopeKey)).size, [scoped]);
	const showServerColumn = scopeLabel === undefined ? serverCount > 1 : scopedServers > 1;
	// The Server sort key can leave the control while picked: scoping to one
	// server hides it, and a push can drop the fleet to one group. The PICKED
	// state stays - clearing the scope brings the sort back exactly as chosen -
	// but while the key is hidden the list must not follow an order the control
	// cannot display, so it renders and reads unsorted.
	const effectiveSort = sort?.key === "server" && !showServerColumn ? undefined : sort;
	const filtered = filterModels(scoped, pills, filter);
	const sorted = effectiveSort === undefined ? filtered : [...filtered].sort(compareBy(effectiveSort));
	// Offered pills derive from the scoped list: within a server scope the other
	// servers' families are dead toggles. Never from the pill-filtered list -
	// the unpressed pills of a dimension must stay visible while a sibling is
	// pressed, or OR-within-a-dimension would be unreachable. Memoized because
	// every scroll event re-renders this component, and the options walk the
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
	// Scroll position translates to a row index through the uniform row height,
	// which the open row's detail breaks: every row below it has been pushed
	// down by the delta. Taking that back out first restores the uniform grid
	// the division assumes. Clamped to the delta so a scroll position INSIDE
	// the open row maps to the open row rather than past it.
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
			// The count belongs to the title, not to a line of its own beside the
			// filter input - and only while the pills or the text are narrowing:
			// "showing 64 of 64" at rest is a tautology (the rule the Resolution
			// header already follows). The scope moves the denominator instead of
			// the numerator, so a scoped-but-unfiltered list stays quiet too.
			meta={sorted.length === scoped.length ? undefined : l10n.t("showing {0} of {1}", sorted.length, scoped.length)}
			// The filter's one home is the header line, the same slot the Settings
			// filter lives in: it governs the whole page the way the header's other
			// actions do, and a box floating between the header and the rows read
			// as belonging to nothing. The rows carry no header to sort by, so the
			// sort control shares the line. Nothing to filter or sort when there
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
					{/* Two different nothings. With no servers at all this destination
					    is reachable on a fresh install, and telling that reader to run
					    a sync would send them to ask nobody; the first thing they need
					    is a server. With servers configured, a sync is exactly the
					    right suggestion. */}
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
					{/* When windowed, the scrollport is a focusable, labelled region so
					    arrow/PageDown scrolling works from the keyboard, and each row
					    declares its true position in a list only a window of which
					    exists in the DOM. Visiting every row by Tab alone is out of
					    scope: off-window rows are reachable by scrolling, not by focus. */}
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
											{/* The two lines are the disclosure: the whole readable block
											    opens the detail, which is why the row's other controls sit
											    outside it - a button cannot contain a button.
											    border-control-outline like the server rows' disclosure:
											    transparent in the ordinary themes, the contrast border in
											    the bordered modes, where a borderless row stops reading as
											    clickable and the two lists wore two vocabularies. */}
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
																<span className="model-price">{formatPricing(model, currencySymbol)}</span>{" "}
																{l10n.t("per M")}
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
