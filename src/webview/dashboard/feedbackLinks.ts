/**
 * Every external destination the Diagnostics feedback rows link to. The repository and the feature-request
 * issue come from shared/util/links.ts, the one owner the extension host reads too; the marketplace listing is
 * whatever package.json publishes - its `publisher` and `name`, read at bundle time - so a renamed publisher
 * re-points the row instead of leaving a dead link behind. Manifest fields are the only interpolation: nothing
 * here reads server data.
 */

import { name, publisher } from "../../../package.json";
import { GITHUB_FEATURE_REQUEST_URL, GITHUB_REPO_URL } from "../../shared/util/links";

declare const feedbackUrl: unique symbol;

/**
 * The only values a feedback anchor may carry; the DiagnosticsSection anchors are typed to it. A brand rather than a
 * union of literals, because the manifest fields arrive as plain strings.
 */
export type FeedbackUrl = string & { readonly [feedbackUrl]: true };

export const FEEDBACK_LINK_RATE =
	`https://marketplace.visualstudio.com/items?itemName=${publisher}.${name}&ssr=false#review-details` as FeedbackUrl;
export const FEEDBACK_LINK_FEATURE_REQUEST = GITHUB_FEATURE_REQUEST_URL as FeedbackUrl;
export const FEEDBACK_LINK_REPOSITORY = GITHUB_REPO_URL as FeedbackUrl;
