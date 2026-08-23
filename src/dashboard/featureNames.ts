/**
 * The features' one display-name registry, shared by the extension host and
 * the webview: both grammatical forms of every feature's name derive from the
 * single switch below, so the dashboard's headings and the features' error
 * sentences cannot drift into rival vocabularies. Two forms exist because
 * languages disagree on what a heading and a mid-sentence mention share: a
 * Title-case key lowercased at a call site is not l10n-safe, so each form is
 * its own l10n key. Pure presentation logic - no vscode, no DOM - and the
 * strings resolve at call time, never as module-level constants.
 */

import * as l10n from "@vscode/l10n";
import type { FeatureId } from "../shared/config/settingSpec";

/** "title" is the standalone heading form; "sentence" is the lowercase mid-sentence form. */
export type FeatureNameForm = "title" | "sentence";

/** One feature's names: both localized forms, the sentence form's English mirror, and its terse log tag. */
interface FeatureNameEntry {
	readonly title: string;
	readonly sentence: string;
	/** The sentence form's English mirror, for English-by-policy log surfaces. */
	readonly englishSentence: string;
	/** The PascalCase tag log classifications name the feature by; English by policy. */
	readonly logSurface: string;
}

function featureNameEntry(feature: FeatureId): FeatureNameEntry {
	switch (feature) {
		case "inlineCompletions":
			return {
				title: l10n.t("Inline completions"),
				sentence: l10n.t("inline completions"),
				englishSentence: "inline completions",
				logSurface: "InlineCompletions",
			};
		case "commitGeneration":
			return {
				title: l10n.t("Commit message generation"),
				sentence: l10n.t("commit generation"),
				englishSentence: "commit generation",
				logSurface: "CommitGeneration",
			};
		case "prGeneration":
			return {
				title: l10n.t("PR description generation"),
				sentence: l10n.t("PR generation"),
				englishSentence: "PR generation",
				logSurface: "PrGeneration",
			};
		case "consultTool":
			return {
				title: l10n.t("Consult tool"),
				sentence: l10n.t("consult tool"),
				englishSentence: "consult tool",
				logSurface: "ConsultTool",
			};
		case "quickFix":
			return {
				title: l10n.t("Quick fixes"),
				sentence: l10n.t("quick fix"),
				englishSentence: "quick fix",
				logSurface: "QuickFix",
			};
		case "reviewComments":
			return {
				title: l10n.t("Review comments"),
				sentence: l10n.t("review comments"),
				englishSentence: "review comments",
				logSurface: "ReviewComments",
			};
		case "chatParticipant":
			return {
				title: l10n.t("Chat participant (@litellm)"),
				sentence: l10n.t("chat participant"),
				englishSentence: "chat participant",
				logSurface: "ChatParticipant",
			};
	}
}

/** A feature's localized display name in the asked-for grammatical form. */
export function featureDisplayName(feature: FeatureId, form: FeatureNameForm): string {
	const entry = featureNameEntry(feature);
	return form === "title" ? entry.title : entry.sentence;
}

/** The sentence form's English mirror, for MirroredError English renderings and other English-by-policy surfaces. */
export function featureEnglishName(feature: FeatureId): string {
	return featureNameEntry(feature).englishSentence;
}

/** The terse PascalCase tag a log classification names the feature by. */
export function featureLogSurface(feature: FeatureId): string {
	return featureNameEntry(feature).logSurface;
}
