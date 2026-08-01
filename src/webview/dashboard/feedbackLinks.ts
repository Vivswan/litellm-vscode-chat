/**
 * Every external destination the Diagnostics tab's feedback rows link to, in
 * one place. Literal string constants only - no template interpolation, not
 * even of other constants - so a read of this file proves link targets never
 * carry server data (the docsLinks.ts rule). diagnostics.test.tsx enforces
 * the literal-only shape at the source level and derives the expected
 * marketplace URL from package.json, so a renamed publisher or extension
 * fails CI instead of serving a dead review link.
 */

export const FEEDBACK_LINK_RATE =
	"https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat&ssr=false#review-details";
export const FEEDBACK_LINK_FEATURE_REQUEST =
	"https://github.com/Vivswan/litellm-vscode-chat/issues/new?labels=enhancement&title=%5BFeature%5D+";
export const FEEDBACK_LINK_REPOSITORY = "https://github.com/Vivswan/litellm-vscode-chat";

/** The only values a feedback anchor may carry; the DiagnosticsSection anchors are typed to it. */
export type FeedbackUrl =
	| typeof FEEDBACK_LINK_RATE
	| typeof FEEDBACK_LINK_FEATURE_REQUEST
	| typeof FEEDBACK_LINK_REPOSITORY;
