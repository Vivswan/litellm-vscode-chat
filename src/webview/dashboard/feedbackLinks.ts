/**
 * Every external destination the Diagnostics feedback rows link to. The marketplace listing and the repository are
 * whatever package.json publishes - its `publisher`, `name`, and `repository.url`, read at bundle time - so a
 * renamed publisher or a moved repository re-points the rows instead of leaving a dead link behind. Those manifest
 * fields are the only interpolation: nothing here reads server data.
 */

import { name, publisher, repository } from "../../../package.json";

declare const feedbackUrl: unique symbol;

/**
 * The only values a feedback anchor may carry; the DiagnosticsSection anchors are typed to it. A brand rather than a
 * union of literals, because the manifest fields arrive as plain strings.
 */
export type FeedbackUrl = string & { readonly [feedbackUrl]: true };

export const FEEDBACK_LINK_RATE =
	`https://marketplace.visualstudio.com/items?itemName=${publisher}.${name}&ssr=false#review-details` as FeedbackUrl;
export const FEEDBACK_LINK_FEATURE_REQUEST =
	`${repository.url}/issues/new?labels=enhancement&title=%5BFeature%5D+` as FeedbackUrl;
export const FEEDBACK_LINK_REPOSITORY = repository.url as FeedbackUrl;
