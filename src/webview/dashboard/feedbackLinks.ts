/**
 * Every external destination the Diagnostics feedback rows link to. Literal string
 * constants only (the docsLinks.ts rule), so link targets provably never carry server
 * data; diagnostics.test.tsx enforces the shape and derives the marketplace URL from
 * package.json, so a renamed publisher fails CI instead of serving a dead link.
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
