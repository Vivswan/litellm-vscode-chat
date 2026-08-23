/**
 * The /models answer: provider snapshots rendered as one markdown document,
 * zero network. The snapshot shape is injected by the wiring (a label per
 * provider group plus each model's ID and a prebuilt capability summary), so
 * the module stays pure and the bun tree can pin its output byte for byte.
 */

import * as l10n from "@vscode/l10n";

/** One model as the snapshot reports it: the raw ID plus a one-line capability summary. */
export interface SnapshotModel {
	readonly id: string;
	readonly capabilities: string;
}

/** One provider group's last known models. */
export interface ProviderSnapshot {
	readonly label: string;
	readonly models: readonly SnapshotModel[];
}

/**
 * A table cell: backslashes escape first so a preexisting one cannot disarm
 * the pipe escape that follows, and every CR or LF flattens to a space, so a
 * value can never break the row grid.
 */
function cell(text: string): string {
	return text
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/[\r\n]+/g, " ");
}

/**
 * A model ID as a code span where one can hold it. Code-span content is
 * literal apart from the pipe (the one escape GFM processes even inside a
 * table cell's code span) - which also means a backslash adjacent to a pipe
 * is not representable there: the cell scanner has no code-span awareness,
 * so the raw backslash would pair with the pipe's escape and split the row.
 * Backslash-bearing IDs therefore give up the monospace styling and take the
 * plain cell() path, whose escaping is processed normally. Otherwise: line
 * breaks flatten to a space, the fence is one backtick longer than the ID's
 * longest backtick run, and backtick or space edges get padding (they would
 * merge with the fence or be stripped by CommonMark), so no ID can unbalance
 * the span or pair with a neighboring row's. A blank ID stays plain text -
 * CommonMark has no empty code span.
 */
function idCell(id: string): string {
	if (id.includes("\\")) {
		return cell(id);
	}
	const escaped = id.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
	if (escaped.trim() === "") {
		return escaped;
	}
	const longestRun = (escaped.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
	const fence = "`".repeat(longestRun + 1);
	const pad = /^[` ]|[` ]$/.test(escaped) ? " " : "";
	return `${fence}${pad}${escaped}${pad}${fence}`;
}

/** Code-unit comparison: deterministic across locales, unlike localeCompare. */
function byCodeUnit(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Render the snapshots as markdown: one section per server, one row per
 * model, servers and models sorted by code unit with full-content
 * tie-breakers, so the same snapshots always render the same document
 * whatever order they arrive in. No servers and no models are each a plain
 * sentence instead of an empty grid.
 */
export function modelsMarkdown(snapshots: readonly ProviderSnapshot[]): string {
	if (snapshots.length === 0) {
		return l10n.t("No LiteLLM servers are connected. Add one from the LiteLLM dashboard to see its models here.");
	}
	// The header cells go through the same escaping every value does: a
	// translation is user-supplied text as far as the row grid is concerned.
	const header = `| ${cell(l10n.t("Model"))} | ${cell(l10n.t("Capabilities"))} |`;
	const sections = snapshots.map((snapshot) => {
		const heading = `### ${cell(snapshot.label)}`;
		if (snapshot.models.length === 0) {
			return `${heading}\n\n${l10n.t("No models discovered.")}`;
		}
		const rows = [...snapshot.models]
			.sort((a, b) => byCodeUnit(a.id, b.id) || byCodeUnit(a.capabilities, b.capabilities))
			.map((model) => `| ${idCell(model.id)} | ${cell(model.capabilities)} |`);
		return [heading, "", header, "| --- | --- |", ...rows].join("\n");
	});
	return sections.sort(byCodeUnit).join("\n\n");
}
