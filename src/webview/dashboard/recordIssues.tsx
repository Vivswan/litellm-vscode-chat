import * as l10n from "@vscode/l10n";
import type {
	CapabilityGroupIssues,
	GroupHints,
	GroupProblems,
	MatcherKind,
	PrefixGroup,
} from "../../dashboard/recordDraft";

export type RecordEditorKind = "params" | "caps";

export interface RowIssueView {
	readonly problem?: { readonly field: "name" | "value"; readonly message: string } | undefined;
	readonly hint?: string | undefined;
}

/** Row-aligned issue views for one group: the matcher's own problem plus one slot per field row. */
export interface GroupIssueView {
	readonly prefix: string | undefined;
	readonly rows: readonly RowIssueView[];
}

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

/**
 *   the rows carry no header row to name them -> The row list's accessible name
 */
export function recordListLabel(kind: RecordEditorKind): string {
	return kind === "params" ? l10n.t("Model parameter matchers") : l10n.t("Model capability matchers");
}

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
