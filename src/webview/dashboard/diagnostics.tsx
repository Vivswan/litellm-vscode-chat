/**
 * The Diagnostics tab: the connection summary, the Configuration diagnostics
 * the extension found in the settings, the Resolved-models view over the
 * precomputed resolution, and the feedback surfaces; litellm.showDiagnostics
 * deep-links here through the panel's focusSection message.
 *
 * The connection summary renders the protocol module's shared diagnostics
 * renderers (overallStatusText, serverOutcomeParts) over the same pushed
 * state the overview hero reads, so the tab and the hero cannot drift; Copy
 * diagnostics puts the same facts on the clipboard as plain English text.
 * The Resolved-models view is request/response-fed (readResolvedModels): it
 * scales with models x fields, re-requests on every state push while the tab
 * is visible, and is local to the dashboard by design - never part of issue
 * reports.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import { latestCheckedMs, overallStatusText, serverOutcomeParts, serverOutcomeText } from "../../dashboard/presenters";
import type {
	ConfigDiagnosticView,
	DashboardServer,
	RecordTreeNode,
	RecordTreeView,
	ResolvedCapCell,
	ResolvedModelRow,
	ResolvedParamCell,
} from "../../dashboard/viewModels";
import {
	COST_CAPABILITY_FIELDS,
	capabilityDisplayLabel,
	formatCostPerMillion,
	parameterCountText,
} from "../../shared/config/capabilityDisplay";
import type { RecordDiagnostic } from "../../shared/config/recordResolution";
import type { DocsUrl } from "./docsLinks";
import {
	DOCS_LINK_AUTHENTICATION,
	DOCS_LINK_GETTING_STARTED,
	DOCS_LINK_MODEL_MATCHING,
	DOCS_LINK_RESOLVED_MODELS,
	DOCS_LINK_SETTINGS_MIGRATION,
} from "./docsLinks";
import { FailureText } from "./failureText";
import type { FeedbackUrl } from "./feedbackLinks";
import { FEEDBACK_LINK_FEATURE_REQUEST, FEEDBACK_LINK_RATE, FEEDBACK_LINK_REPOSITORY } from "./feedbackLinks";
import { DocsLink, HoverTip } from "./help";
import { useRpc } from "./hooks";
import {
	IconBook,
	IconBug,
	IconCheck,
	IconCopy,
	IconLightbulb,
	IconLinkExternal,
	IconOutput,
	IconPlug,
	IconRepo,
	IconStar,
} from "./icons";
import type { InspectorSection } from "./modelInspector";
import { relativeTime } from "./time";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { sendRequest } from "./vscodeApi";

/** One feedback row: the action (an anchor or a button) with its muted one-liner. */
function FeedbackRow({ action, hint }: { action: ReactNode; hint: string }) {
	return (
		<li>
			{action}
			<span className="hint">{hint}</span>
		</li>
	);
}

function ExternalRow({ href, icon, label, hint }: { href: FeedbackUrl; icon: ReactNode; label: string; hint: string }) {
	return (
		<FeedbackRow
			action={
				<a className="docs-link" href={href}>
					{icon}
					{label}
					<IconLinkExternal />
				</a>
			}
			hint={hint}
		/>
	);
}

/** The overall last-checked reading: the absolute time with its relative echo, as the facts list renders it. */
function lastCheckedText(servers: readonly DashboardServer[], now: number): string {
	const checkedMs = latestCheckedMs(servers);
	if (checkedMs === undefined) {
		return l10n.t("Never");
	}
	const absolute = new Date(checkedMs).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
	const ago = relativeTime(new Date(checkedMs).toISOString(), now);
	return ago === undefined ? absolute : `${absolute} (${ago})`;
}

/**
 * The whole connection block as plain text, for the Copy diagnostics action:
 * the verdict, the facts list, and one outcome line per server - exactly the
 * facts the tab renders, composed from pushed state only (which carries no
 * secret values by construction; see the storage invariants). Per-server
 * lines go through serverOutcomeText, the same shared renderer the grid
 * decomposes, so the copied wording cannot drift from the rendered one -
 * except that a row carrying an English error mirror (errorEnglish, the
 * transport error's log-safe rendering) substitutes it here: the copied
 * block is destined for public issue reports, which stay English by policy,
 * while the on-screen grid keeps the localized error.
 */
function withEnglishError(server: DashboardServer): DashboardServer {
	if (server.state !== "unchecked" && server.errorEnglish !== undefined) {
		return { ...server, error: server.errorEnglish };
	}
	return server;
}

/**
 * The copied block is fully English, timestamp included: where the on-screen
 * facts list renders the localized absolute-plus-relative reading, the copy
 * path emits "Never" or the plain ISO instant, so a pasted issue report never
 * carries translated text or a locale-shaped date.
 */
function diagnosticsReportText(
	servers: readonly DashboardServer[],
	modelCount: number,
	legacyServerCount: number
): string {
	const copyServers = servers.map(withEnglishError);
	const checkedMs = latestCheckedMs(copyServers);
	const lines = [
		overallStatusText(copyServers, modelCount, legacyServerCount),
		`Servers configured: ${copyServers.length}`,
		`Last checked: ${checkedMs === undefined ? "Never" : new Date(checkedMs).toISOString()}`,
	];
	if (legacyServerCount > 0) {
		lines.push(`Legacy registry servers: ${legacyServerCount}`);
	}
	for (const server of copyServers) {
		lines.push(`${server.label} (${server.baseUrl}): ${serverOutcomeText(server)}`);
	}
	return lines.join("\n");
}

/** A row's last-checked cell: relative ("is this fresh?"); the facts list above carries the precise overall time. */
function rowChecked(server: DashboardServer, now: number): string {
	if (server.lastChecked === undefined) {
		return l10n.t("Never");
	}
	return relativeTime(server.lastChecked, now) ?? "-";
}

/**
 * The per-server outcome grid. Each server is one compact row; a row's error
 * and its params-inactive warning span beneath it as their own lines, so the
 * columns stay scannable while the details stay selectable. Wording comes
 * from serverOutcomeParts, the decomposition serverOutcomeText itself
 * composes; only the layout lives here.
 */
function OutcomeGrid({ servers, now }: { servers: readonly DashboardServer[]; now: number }) {
	return (
		<table className="diag-grid">
			<thead>
				<tr>
					<th>{l10n.t("Server")}</th>
					<th>{l10n.t("Status")}</th>
					<th className="num">{l10n.t("Models")}</th>
					<th>{l10n.t("Last checked")}</th>
					<th>{l10n.t("URL")}</th>
				</tr>
			</thead>
			<tbody>
				{servers.map((server) => {
					const parts = serverOutcomeParts(server);
					const tone =
						parts.status === "Error" || parts.status === "Misconfigured"
							? server.expected === true
								? "tone-warn"
								: "tone-error"
							: parts.status === "OK"
								? "tone-ok"
								: "tone-muted";
					const notes: { kind: "error" | "warn"; text: string }[] = [];
					if (parts.error !== undefined) {
						// An expected failure already carries its English "(expected)"
						// annotation from serverOutcomeParts; the warn tone matches it.
						notes.push({ kind: server.expected === true ? "warn" : "error", text: parts.error });
					}
					for (const text of parts.notice) {
						notes.push({ kind: "warn", text });
					}
					return (
						<Fragment key={`${server.label} ${server.baseUrl}`}>
							{/* Rows followed by a note drop their rule so the group reads
							    as one server; the group's last row draws it. */}
							<tr className={notes.length > 0 ? "no-rule" : undefined}>
								<td>{server.label}</td>
								<td>
									<span className={`pill ${tone}`}>
										<span className="dot" />
										{parts.status}
									</span>
								</td>
								<td className="num">{server.modelCount}</td>
								<td>{rowChecked(server, now)}</td>
								<td className="diag-url">{server.baseUrl}</td>
							</tr>
							{notes.map((note, index) => (
								<tr
									// biome-ignore lint/suspicious/noArrayIndexKey: notes are positional within their server block; the list rebuilds wholesale on every push
									key={`${index}-${note.kind}`}
									className={index < notes.length - 1 ? `diag-note ${note.kind} no-rule` : `diag-note ${note.kind}`}
								>
									<td colSpan={5}>
										<FailureText message={note.text} />
									</td>
								</tr>
							))}
						</Fragment>
					);
				})}
			</tbody>
		</table>
	);
}

/** Where a record diagnostic sits, as one phrase: the setting, with the owning entry when it is entry-scoped. */
function recordWhere(diagnostic: Extract<ConfigDiagnosticView, { kind: "record" }>): string {
	return diagnostic.entryLabel !== undefined
		? l10n.t('server entry "{0}" - {1}', diagnostic.entryLabel, diagnostic.setting)
		: diagnostic.setting;
}

/** One record diagnostic's sentence; classifications and structural keys only, never entered values. */
function recordDiagnosticText(where: string, diagnostic: RecordDiagnostic): string {
	switch (diagnostic.kind) {
		case "invalid-matcher":
			return l10n.t(
				'"{0}" is not a valid matcher key and never matches: use an exact ID, a trailing-* glob, /regex/, or "*" ({1})',
				diagnostic.recordKey,
				where
			);
		case "unforceable-key":
			return l10n.t(
				'"{0}" in record "{1}" cannot be forced: provider-owned fields and _ keys stay extension-owned ({2})',
				diagnostic.key,
				diagnostic.recordKey,
				where
			);
		case "unknown-inherit-key":
			return l10n.t(
				'record "{0}" inherits from "{1}", which does not exist; that name is skipped and the rest still applies ({2})',
				diagnostic.recordKey,
				diagnostic.key,
				where
			);
		case "wrong-record-type":
			return l10n.t(
				'"{0}" in record "{1}" belongs to the other record type and is ignored ({2})',
				diagnostic.key,
				diagnostic.recordKey,
				where
			);
		case "unrecognized-key":
			// Informational (the host marks these advisory): the field APPLIES
			// as-is - the open vocabulary keeps it - and the surviving hint only
			// says the observed /model/info evidence does not name the key.
			return l10n.t(
				'"{0}" in record "{1}" is not a field this extension knows; it is applied as an override as-is ({2})',
				diagnostic.key,
				diagnostic.recordKey,
				where
			);
		case "invalid-value":
			return l10n.t(
				'"{0}" in record "{1}" has an invalid value and is ignored ({2})',
				diagnostic.key,
				diagnostic.recordKey,
				where
			);
		case "invalid-directive":
			return l10n.t(
				'"{0}" in record "{1}" carries an invalid directive value; offending entries are ignored ({2})',
				diagnostic.key,
				diagnostic.recordKey,
				where
			);
	}
}

/** One configuration diagnostic as its sentence plus the fix's docs link. */
function diagnosticPresentation(diagnostic: ConfigDiagnosticView): { text: string; docs?: DocsUrl | undefined } {
	switch (diagnostic.kind) {
		case "record":
			return {
				text: recordDiagnosticText(recordWhere(diagnostic), diagnostic.diagnostic),
				docs: DOCS_LINK_MODEL_MATCHING,
			};
		case "entry": {
			const name = diagnostic.label !== undefined ? `"${diagnostic.label}"` : `#${diagnostic.position}`;
			return {
				text: diagnostic.misconfigured
					? l10n.t("Server entry {0} is misconfigured and not used: {1}", name, diagnostic.problems.join("; "))
					: l10n.t("Server entry {0}: {1}", name, diagnostic.problems.join("; ")),
				docs: diagnostic.misconfigured ? DOCS_LINK_AUTHENTICATION : undefined,
			};
		}
		case "legacy":
			switch (diagnostic.hint) {
				case "inert-url-scoped-key":
					return {
						text: l10n.t(
							'"{0}" in {1} still uses the removed server-scoped key grammar; it can never match a model ID. Move it into that server entry\'s own record.',
							diagnostic.oldKey,
							diagnostic.detail
						),
						docs: DOCS_LINK_SETTINGS_MIGRATION,
					};
				case "inert-global-headers":
					return {
						text: l10n.t(
							"The removed global headers setting still holds values and no server entry received them; add the headers to a server entry, then delete the old setting."
						),
						docs: DOCS_LINK_SETTINGS_MIGRATION,
					};
				case "parked-global-headers":
					return {
						text: l10n.t(
							"The removed global headers ({0}) no longer reach provider groups without a server entry; adopt the external group to restore them.",
							diagnostic.detail
						),
						docs: DOCS_LINK_SETTINGS_MIGRATION,
					};
			}
			break;
		case "thresholds":
			return {
				text:
					diagnostic.dropped === 1
						? l10n.t("1 usage.alertThresholds value is outside (0, 1] and was dropped.")
						: l10n.t("{0} usage.alertThresholds values are outside (0, 1] and were dropped.", diagnostic.dropped),
			};
		case "hidden-groups":
			return {
				text:
					diagnostic.labels.length === 1
						? l10n.t(
								'"{0}" is hidden by an explicit removal and serves no models. Unhide it from the hidden-groups line under Servers & Models.',
								diagnostic.labels[0] ?? ""
							)
						: l10n.t(
								"{0} groups are hidden by an explicit removal and serve no models ({1}). Unhide them from the hidden-groups line under Servers & Models.",
								diagnostic.labels.length,
								diagnostic.labels.join(", ")
							),
			};
	}
}

/** The Configuration diagnostics list; absent entirely when the settings are clean. */
function ConfigDiagnostics({ diagnostics }: { diagnostics: readonly ConfigDiagnosticView[] }) {
	if (diagnostics.length === 0) {
		return null;
	}
	return (
		<section aria-labelledby="config-diagnostics-title">
			<h2 id="config-diagnostics-title">{l10n.t("Configuration diagnostics")}</h2>
			<p className="hint">
				{l10n.t("Problems the extension found in your settings; each also shows beside what it concerns.")}
			</p>
			<ul className="config-diagnostics">
				{diagnostics.map((diagnostic, index) => {
					const presentation = diagnosticPresentation(diagnostic);
					// Advisory rows render muted, warnings keep the warning tone;
					// the host decides the severity (every variant carries it).
					const advisory = diagnostic.severity === "advisory";
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: positional identity; the list rebuilds wholesale on every push
						<li key={index} className={advisory ? "hint" : "state-warn"}>
							{presentation.text}
							{presentation.docs !== undefined ? (
								<>
									{" "}
									<DocsLink href={presentation.docs} label={l10n.t("Open the matching guide section")}>
										{l10n.t("Learn more")}
									</DocsLink>
								</>
							) : null}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** One tree node's own-fields summary: "temperature 0.3 (inheritable, forced)". */
function nodeFieldText(field: RecordTreeNode["fields"][number]): string {
	const marks = [
		...(field.inheritable
			? [
					l10n.t({
						message: "inheritable",
						comment: ["Checkbox label on a record row; marks the field as inheritable by more specific records."],
					}),
				]
			: []),
		...(field.forced ? [l10n.t("forced")] : []),
		...(field.fallback
			? [
					l10n.t({
						message: "fallback",
						comment: ["Checkbox label on a capability row; applies the value only where the server reports none."],
					}),
				]
			: []),
	];
	return `${field.name} ${field.valueText}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`;
}

function TreeNode({ node }: { node: RecordTreeNode }) {
	return (
		<li className="tree-node">
			<span className="tree-key">
				<code>{node.key}</code>
			</span>
			{node.fields.length > 0 ? (
				<span className="tree-fields"> {node.fields.map(nodeFieldText).join(", ")}</span>
			) : (
				<span className="hint"> {l10n.t("(no own fields)")}</span>
			)}
			{node.barrier ? <span className="tree-barrier"> [{l10n.t("inheritance stops here")}]</span> : null}
			{!node.barrier && node.inheritFrom !== undefined ? (
				<span className="hint"> [{l10n.t("inherits from: {0}", node.inheritFrom)}]</span>
			) : null}
			{node.children.length > 0 || node.models.length > 0 ? (
				<ul>
					{node.children.map((child) => (
						<TreeNode key={child.key} node={child} />
					))}
					{node.models.map((model) => (
						<li key={model.id} className="tree-model">
							<span className="tree-model-id">{model.id}</span>
							{model.resolvedText.length > 0 ? (
								<span className="hint">
									{" "}
									{"->"} {model.resolvedText}
								</span>
							) : null}
						</li>
					))}
				</ul>
			) : node.models.length === 0 ? (
				<span className="hint"> {l10n.t("(matches no current model)")}</span>
			) : null}
		</li>
	);
}

/** One tree's heading: which record map it draws. */
function treeTitle(tree: RecordTreeView): string {
	if (tree.layer === "entry") {
		return tree.kind === "parameters"
			? l10n.t('Parameters - server entry "{0}"', tree.entryLabel ?? "")
			: l10n.t('Capabilities - server entry "{0}"', tree.entryLabel ?? "");
	}
	return tree.kind === "parameters" ? l10n.t("Parameters - Settings") : l10n.t("Capabilities - Settings");
}

function RecordTree({ tree }: { tree: RecordTreeView }) {
	return (
		<details className="record-tree" open>
			<summary>{treeTitle(tree)}</summary>
			<ul>
				{tree.roots.map((root) => (
					<TreeNode key={root.key} node={root} />
				))}
				{tree.unmatchedModelIds.length > 0 ? (
					<li className="tree-model">
						<span className="hint">
							{tree.unmatchedModelIds.length === 1
								? l10n.t("1 model matches no record here")
								: l10n.t("{0} models match no record here", tree.unmatchedModelIds.length)}
						</span>
					</li>
				) : null}
				{tree.invalidKeys.map((key) => (
					<li key={key} className="tree-model state-warn">
						{l10n.t('"{0}" is not a valid matcher key; it matches nothing', key)}
					</li>
				))}
			</ul>
		</details>
	);
}

/** A parameter cell's provenance, one compact phrase. */
function paramProvenance(cell: ResolvedParamCell): string {
	const base = cell.layer === "entry" ? l10n.t("entry {0}", cell.key) : l10n.t("settings {0}", cell.key);
	const marks = [
		...(cell.forced === true ? [l10n.t("forced")] : []),
		...(cell.inheritedFrom !== undefined ? [l10n.t("inherited from {0}", cell.inheritedFrom)] : []),
	];
	return marks.length > 0 ? `${base}; ${marks.join(", ")}` : base;
}

/** A capability cell's provenance, one compact phrase (the caps inspector's level names, shortened). */
function capProvenance(cell: ResolvedCapCell): string {
	const inherited = cell.inheritedFrom !== undefined ? `; ${l10n.t("inherited from {0}", cell.inheritedFrom)}` : "";
	switch (cell.level) {
		case "entry":
			return l10n.t("entry {0}", cell.key ?? "") + inherited;
		case "global":
			return l10n.t("settings {0}", cell.key ?? "") + inherited;
		case "directive":
			return l10n.t("catalog (directive {0})", cell.key ?? "");
		case "server":
			return l10n.t("server-reported");
		case "entry-fallback":
			return l10n.t("entry fallback {0}", cell.key ?? "") + inherited;
		case "global-fallback":
			return l10n.t("settings fallback {0}", cell.key ?? "") + inherited;
		case "catalog":
			return l10n.t("catalog match");
		case "derived":
			return l10n.t("derived");
		case "floor":
			return l10n.t("default");
	}
}

/**
 * One generic capability cell: the friendly label where the consumed
 * vocabulary has one (the value keeps the monospace register), the raw wire
 * key in code otherwise (for an open field the key IS the fact), each with
 * its provenance chip. A labeled cell keeps its wire identity one focusable
 * tip away - this is a debugging surface, and the wire key is what a reader
 * writes into a models.capabilities record.
 */
function CapabilityCell({ cell }: { cell: ResolvedCapCell }) {
	const label = capabilityDisplayLabel(cell.name);
	return (
		<span className="resolved-cell">
			{label !== undefined ? (
				<HoverTip focusable tip={`${cell.name} ${cell.valueText}`}>
					<span className="resolved-field">
						{label} <code>{cell.valueText}</code>
					</span>
				</HoverTip>
			) : (
				<code>
					{cell.name} {cell.valueText}
				</code>
			)}
			<span className="chip-prov">{capProvenance(cell)}</span>
		</span>
	);
}

/**
 * The supported-params list as its count, the full list one focusable tip
 * away (a 27-element JSON array printed inline made the whole table
 * unscannable). A cell whose value is not the validated string array falls
 * back to the generic rendering rather than miscounting.
 */
function ParamsListCell({ cell }: { cell: ResolvedCapCell }) {
	let list: readonly string[] | undefined;
	try {
		const parsed: unknown = JSON.parse(cell.valueText);
		if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
			list = parsed;
		}
	} catch {
		// Fall through to the generic cell: valueText was not JSON.
	}
	if (list === undefined) {
		return <CapabilityCell cell={cell} />;
	}
	return (
		<span className="resolved-cell">
			<span className="resolved-field">{capabilityDisplayLabel(cell.name) ?? cell.name}</span>
			{/* The tip carries the wire key and the EXACT wire value (the JSON
			    array), not a joined rendering: element boundaries must survive
			    on a debugging surface, and a comma inside one name would make a
			    join ambiguous. The empty list keeps the tip too - the wire key
			    must stay reachable on every rendering. */}
			<HoverTip focusable tip={`${cell.name} ${cell.valueText}`}>
				<span>{parameterCountText(list.length)}</span>
			</HoverTip>
			<span className="chip-prov">{capProvenance(cell)}</span>
		</span>
	);
}

/**
 * The capability cells of one resolved-model row, grouped for scanning: the
 * flag and token fields first (friendly labels where the vocabulary knows
 * them), then the eight cost fields collapsed into one $/M pricing line, then
 * the supported-params list as its count. Purely presentational regrouping:
 * every resolved field stays visible with its provenance - the pricing line
 * LEADS with the DOMINANT source's chip ("default: X, except where noted")
 * and badges only the parts that differ from it (one chip when uniform,
 * never eight chips saying the same thing), and its focusable tip keeps the
 * wire keys, exact per-token values, and per-field sources the $/M rendering
 * summarizes.
 */
function CapabilityCells({ cells }: { cells: readonly ResolvedCapCell[] }) {
	const pricing = COST_CAPABILITY_FIELDS.flatMap((name) => {
		const cell = cells.find((candidate) => candidate.name === name);
		if (cell === undefined) {
			return [];
		}
		// valueText is the JSON rendering of the resolved value, and a consumed
		// cost field is kind-validated to a finite number, so this parse is
		// exact; anything else keeps the generic rendering below.
		const perToken = Number(cell.valueText);
		return Number.isFinite(perToken) ? [{ cell, perToken }] : [];
	});
	const pricingNames = new Set(pricing.map((entry) => entry.cell.name));
	const params = cells.find((cell) => cell.name === "supported_openai_params");
	const rest = cells.filter((cell) => !pricingNames.has(cell.name) && cell !== params);
	// The most frequent provenance phrase wins the line's closing chip (first
	// seen wins ties); parts from any other source carry their own chip.
	const provenanceCounts = new Map<string, number>();
	for (const entry of pricing) {
		const provenance = capProvenance(entry.cell);
		provenanceCounts.set(provenance, (provenanceCounts.get(provenance) ?? 0) + 1);
	}
	let dominant = "";
	let dominantCount = -1;
	for (const [provenance, count] of provenanceCounts) {
		if (count > dominantCount) {
			dominant = provenance;
			dominantCount = count;
		}
	}
	return (
		<div className="resolved-cells">
			{rest.map((cell) => (
				<CapabilityCell key={cell.name} cell={cell} />
			))}
			{pricing.length > 0 ? (
				<span className="resolved-cell">
					{/* The tip pairs every wire key with its exact per-token value
					    and its source, so the dominant-chip scheme never asks the
					    reader to infer a source it cannot see. */}
					<HoverTip
						focusable
						tip={pricing
							.map((entry) => `${entry.cell.name} ${entry.cell.valueText} (${capProvenance(entry.cell)})`)
							.join(", ")}
					>
						<span className="resolved-field">{l10n.t("Pricing ($/M)")}</span>
					</HoverTip>
					{/* The dominant source's chip leads the line ("default: X,
					    except where noted"), so an unbadged part obviously reads
					    as the leading chip's source. */}
					<span className="chip-prov">{dominant}</span>
					{pricing.map((entry) => {
						const provenance = capProvenance(entry.cell);
						return (
							<span key={entry.cell.name} className="resolved-price-part">
								{capabilityDisplayLabel(entry.cell.name)} <code>{formatCostPerMillion(entry.perToken)}</code>
								{provenance === dominant ? null : <span className="chip-prov">{provenance}</span>}
							</span>
						);
					})}
				</span>
			) : null}
			{params !== undefined ? <ParamsListCell cell={params} /> : null}
		</div>
	);
}

function matchesResolvedFilter(row: ResolvedModelRow, needle: string): boolean {
	return (
		row.rawId.toLowerCase().includes(needle) ||
		row.serverLabel.toLowerCase().includes(needle) ||
		row.matchedKeys.some((key) => key.toLowerCase().includes(needle))
	);
}

/**
 * The Resolved-models view: the inheritance trees and the flat provenance
 * table, both reading the extension's shared resolution (readResolvedModels).
 */
function ResolvedModels({
	active,
	stateSeq,
	onInspect,
}: {
	active: boolean;
	stateSeq: number;
	/** Opens the merged model inspector anchored on the named section. */
	onInspect: (target: { scopeKey: string; rawId: string; serverLabel: string }, section: InspectorSection) => void;
}) {
	const resolved = useRpc("readResolvedModels");
	const [filter, setFilter] = useState("");
	// Request on first show and again on every push while visible: the view
	// must follow settings edits; hidden tabs stay quiet.
	const { send } = resolved;
	// biome-ignore lint/correctness/useExhaustiveDependencies: stateSeq is the deliberate re-request key (see above), not a read
	useEffect(() => {
		if (!active) {
			return;
		}
		send(null);
	}, [active, stateSeq, send]);

	const view = resolved.data?.view;
	const needle = filter.trim().toLowerCase();
	const rows =
		view === undefined
			? []
			: needle.length === 0
				? view.rows
				: view.rows.filter((row) => matchesResolvedFilter(row, needle));
	return (
		<section aria-labelledby="resolved-models-title">
			<h2 id="resolved-models-title">
				{l10n.t("Resolved models")}{" "}
				<DocsLink href={DOCS_LINK_RESOLVED_MODELS} label={l10n.t("Open the resolved-models guide")} />
			</h2>
			<p className="hint">
				{l10n.t(
					"The precomputed resolution behind every request: what each model ends up with and which record set it. Local to this dashboard; never part of issue reports."
				)}
			</p>
			{view === undefined ? (
				<p className="hint" role="status">
					{l10n.t("Resolving...")}
				</p>
			) : (
				<>
					{view.recordCount === 0 ? (
						<p className="hint">
							{l10n.t(
								"No matcher records configured; values come from the servers, the catalog, and the built-in defaults."
							)}
						</p>
					) : (
						// biome-ignore lint/suspicious/noArrayIndexKey: trees are positional; the view rebuilds wholesale on every response
						view.trees.map((tree, index) => <RecordTree key={index} tree={tree} />)
					)}
					{view.rows.length === 0 ? (
						<p className="empty">{l10n.t("No models discovered yet; the table fills once a server syncs.")}</p>
					) : (
						<>
							<div className="filterbar">
								<Input
									type="text"
									placeholder={l10n.t("Filter by model ID or matcher key, e.g. gpt-5*")}
									aria-label={l10n.t("Filter resolved models")}
									value={filter}
									onChange={(event) => setFilter(event.currentTarget.value)}
								/>
								<span className="hint">{l10n.t("showing {0} of {1}", rows.length, view.rows.length)}</span>
							</div>
							<div className="table-scroll">
								<table className="resolved-models">
									<thead>
										<tr>
											<th>{l10n.t("Model")}</th>
											<th>{l10n.t("Server")}</th>
											<th>{l10n.t("Parameters")}</th>
											<th>{l10n.t("Capabilities")}</th>
											<th>{/* actions */}</th>
										</tr>
									</thead>
									<tbody>
										{rows.map((row) => (
											<tr key={`${row.scopeKey}/${row.rawId}`}>
												<td className="resolved-id">
													{row.rawId}
													{/* The matcher keys that touched this model, as quiet
													    chips: they explain why a matcher-key filter (the
													    input above) keeps the row. */}
													{row.matchedKeys.length > 0 ? (
														<span className="resolved-matched">
															{row.matchedKeys.map((key) => (
																<code key={key} className="chip-matcher">
																	{key}
																</code>
															))}
														</span>
													) : null}
												</td>
												<td>{row.serverLabel}</td>
												<td className="resolved-col">
													{/* An inner flex div, never display:flex on the td itself:
													    a flexed td stops being a table cell and the column
													    layout collapses. */}
													<div className="resolved-cells">
														{row.parameters.length === 0 ? (
															<span className="hint">-</span>
														) : (
															row.parameters.map((cell) => (
																<span key={cell.name} className="resolved-cell">
																	<code>
																		{cell.name} {cell.valueText}
																	</code>
																	<span className="chip-prov">{paramProvenance(cell)}</span>
																</span>
															))
														)}
													</div>
												</td>
												<td className="resolved-col">
													<CapabilityCells cells={row.capabilities} />
												</td>
												<td className="actions">
													<Button
														variant="secondary"
														size="compact"
														className="params-action"
														aria-label={l10n.t("Inspect {0} on {1}", row.rawId, row.serverLabel)}
														onClick={() =>
															onInspect(
																{ scopeKey: row.scopeKey, rawId: row.rawId, serverLabel: row.serverLabel },
																"params"
															)
														}
													>
														{l10n.t("Inspect")}
													</Button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</>
					)}
				</>
			)}
		</section>
	);
}

export function DiagnosticsSection({
	servers,
	modelCount,
	legacyServerCount,
	diagnostics,
	active,
	stateSeq,
	onInspect,
	now,
}: {
	servers: readonly DashboardServer[];
	modelCount: number;
	legacyServerCount: number;
	diagnostics: readonly ConfigDiagnosticView[];
	/** Whether the Diagnostics tab is the visible one; the resolved view requests only while shown. */
	active: boolean;
	/** Bumped on every state push; the resolved view re-requests on it while visible. */
	stateSeq: number;
	/** Open a model's inspector overlay in place; App renders the merged panel over the active tab, scrolled to the section. */
	onInspect: (target: { scopeKey: string; rawId: string; serverLabel: string }, section: InspectorSection) => void;
	now: number;
}) {
	const [copied, setCopied] = useState(false);
	const copySeq = useRef(0);
	const copyDiagnostics = () => {
		// Clipboard write is fire-and-forget; the check mark is the only
		// feedback (the models table's copy action sets the precedent).
		navigator.clipboard?.writeText(diagnosticsReportText(servers, modelCount, legacyServerCount)).catch(() => {});
		setCopied(true);
		const seq = ++copySeq.current;
		setTimeout(() => {
			if (copySeq.current === seq) {
				setCopied(false);
			}
		}, 1500);
	};
	return (
		<>
			<section aria-labelledby="diagnostics-title">
				<h2 id="diagnostics-title">{l10n.t("Diagnostics")}</h2>
				<p className="diag-verdict">{overallStatusText(servers, modelCount, legacyServerCount)}</p>
				<ul className="diag-facts">
					<li>Servers configured: {servers.length}</li>
					{/* One literal string, not CSS-spaced fragments, so the line
					    selects and copies whole. Copy diagnostics emits its own English
					    rendering of the same fact (ISO timestamp, no relative echo);
					    only this on-screen line is localized. */}
					<li>Last checked: {lastCheckedText(servers, now)}</li>
					{/* The legacy registry (pre-migration installs and test mode)
					    holds servers no row lists; the count keeps the copyable block
					    honest about them. */}
					{legacyServerCount > 0 ? <li>Legacy registry servers: {legacyServerCount}</li> : null}
				</ul>
				{servers.length > 0 ? <OutcomeGrid servers={servers} now={now} /> : null}
				<div className="diag-actions">
					<Button
						variant="secondary"
						// Registry-only installs get no offer to test: the legacy
						// registry's serving path retires with this release train, so
						// with no server rows there is nothing this dashboard manages
						// that a connection test could durably reach.
						disabled={servers.length === 0}
						onClick={() => sendRequest("executeCommand", { command: "testConnection" })}
					>
						<IconPlug /> {l10n.t("Test connection")}
					</Button>
					<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "openOutput" })}>
						<IconOutput /> {l10n.t("Open output log")}
					</Button>
					<Button variant="secondary" onClick={copyDiagnostics}>
						{copied ? <IconCheck /> : <IconCopy />} {l10n.t("Copy diagnostics")}
					</Button>
				</div>
			</section>
			<ConfigDiagnostics diagnostics={diagnostics} />
			<ResolvedModels active={active} stateSeq={stateSeq} onInspect={onInspect} />
			<section aria-labelledby="diagnostics-feedback-title">
				<h2 id="diagnostics-feedback-title">{l10n.t("Feedback & links")}</h2>
				<ul className="feedback-links">
					<FeedbackRow
						action={
							<button
								type="button"
								className="linkish"
								onClick={() => sendRequest("executeCommand", { command: "reportIssue" })}
							>
								<IconBug /> {l10n.t("Report a bug")}
							</button>
						}
						hint={l10n.t("Opens a GitHub issue pre-filled with version, platform, and recent logs.")}
					/>
					<ExternalRow
						href={FEEDBACK_LINK_FEATURE_REQUEST}
						icon={<IconLightbulb />}
						label={l10n.t("Request a feature")}
						hint={l10n.t("Suggest an improvement as a GitHub issue.")}
					/>
					<ExternalRow
						href={FEEDBACK_LINK_RATE}
						icon={<IconStar />}
						label={l10n.t("Rate this extension")}
						hint={l10n.t("Leave a review on the Visual Studio Marketplace.")}
					/>
					<FeedbackRow
						action={
							<DocsLink href={DOCS_LINK_GETTING_STARTED} label={l10n.t("Documentation - the getting-started guide")}>
								<IconBook /> {l10n.t("Documentation")}
							</DocsLink>
						}
						hint={l10n.t("The getting-started guide, with the rest of the docs one click away.")}
					/>
					<ExternalRow
						href={FEEDBACK_LINK_REPOSITORY}
						icon={<IconRepo />}
						label={l10n.t("GitHub repository")}
						hint={l10n.t("Source code, releases, and issues.")}
					/>
				</ul>
			</section>
		</>
	);
}
