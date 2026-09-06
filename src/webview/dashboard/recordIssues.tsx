/**
 * The record editors' shared issue vocabulary: the editor kind, the row and
 * group issue views, and the labels they render with.
 */
import * as l10n from "@vscode/l10n";
import type {
	CapabilityGroupIssues,
	GroupHints,
	GroupProblems,
	MatcherKind,
	PrefixGroup,
} from "../../dashboard/recordDraft";

export type RecordEditorKind = "params" | "caps";

/**
 * One row's issue view - the two parsers' problem/hint shapes normalized so
 * the shared matcher table renders either editor's verdicts. Field-level
 * problems keep their input alignment ("name" or "value") for the popover.
 */
export interface RowIssueView {
	readonly problem?: { readonly field: "name" | "value"; readonly message: string } | undefined;
	readonly hint?: string | undefined;
}

/** Row-aligned issue views for one group: the matcher's own problem plus one slot per field row. */

export interface GroupIssueView {
	readonly prefix: string | undefined;
	readonly rows: readonly RowIssueView[];
}

/** parseGroups' problems and hints folded into the table's issue views. */

export function paramIssueViews(
	groups: readonly PrefixGroup[],
	problems: readonly GroupProblems[],
	hints: readonly GroupHints[] | undefined
): GroupIssueView[] {
	return groups.map((group, index) => ({
		prefix: problems[index]?.prefix,
		rows: group.params.map((_, rowIndex) => ({
			problem: problems[index]?.params[rowIndex],
			hint: hints?.[index]?.params[rowIndex],
		})),
	}));
}

/** parseCapabilityGroups' issues folded into the table's issue views. */

export function capabilityIssueViews(
	groups: readonly PrefixGroup[],
	issues: readonly CapabilityGroupIssues[]
): GroupIssueView[] {
	return groups.map((group, index) => ({
		prefix: issues[index]?.prefix,
		rows: group.params.map((_, rowIndex) => ({
			problem: issues[index]?.rows[rowIndex]?.problem,
			hint: issues[index]?.rows[rowIndex]?.hint,
		})),
	}));
}

/** The open field popover's row as "groupIndex:rowIndex"; chip identity is the raw key plus its duplicate ordinal. */

export function recordListLabel(kind: RecordEditorKind): string {
	return kind === "params" ? l10n.t("Model parameter matchers") : l10n.t("Model capability matchers");
}

/** The matcher kind annotation beside each row's key, resolved at render time. */

export function matcherKindLabel(kind: MatcherKind): string {
	switch (kind) {
		case "catch-all":
			return l10n.t("matches all models");
		case "regex":
			return l10n.t("regex");
		case "glob":
			return l10n.t("prefix match");
		case "exact":
			return l10n.t("exact ID");
		case "invalid":
			return l10n.t("invalid matcher");
	}
}

/** The inherits column's cell chrome, one spelling for every branch below. */
