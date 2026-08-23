import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { CMD, prGenerationProviderTitle } from "../../../shared/config/commandIds";
import type { FeatureModelRef } from "../../../shared/config/settingSpec";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { getFeatureModelRef, isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { errorLabel } from "../../../shared/util/errorLabel";
import { featureChatSend } from "../featureChatSend";
import { resolveGitApi } from "../gitAccess";
import type { API, Branch } from "../gitApi";
import { withProbeToken } from "../probeToken";
import { ghprCommitOrder, oldestFirstMessages } from "./branchContext";
import { runGeneratePrDescription } from "./generatePrCommand";
import type { GitHubPullRequestsApi, TitleAndDescriptionProvider } from "./githubPullRequestsApi";
import type { TitleAndDescriptionContext } from "./prompt";
import { createTitleAndDescriptionProvider } from "./provider";

/**
 * PR generation wiring: the palette command is registered unconditionally (the
 * palette entry hides behind the enable when-clause, but executeCommand and
 * keybindings do not), while the GitHub Pull Requests integration is
 * registered ONLY while the feature is enabled AND a model is configured -
 * fail-closed by construction, so a half-configured feature never offers a
 * button in that extension's create view.
 *
 * The integration is deferred rather than one-shot: the GitHub extension may
 * be installed, enabled, or updated after this activation, so an
 * extensions.onDidChange listener re-runs the decision, as does a
 * configuration change. `oneShot` is the activation-shared client, so OAuth
 * tokens cache across invocations and across features and invalidate on 401
 * like the chat and usage paths.
 */

/** The GitHub Pull Requests extension's identifier, as published. */
const GHPR_EXTENSION_ID = "GitHub.vscode-pull-request-github";

/** Sends one assembled prompt to the configured model; the shared seam the command, the provider, and the probe run through. */
export type PrGenerationModelSend = (
	model: FeatureModelRef,
	prompt: string,
	token: vscode.CancellationToken
) => Promise<string>;

/**
 * The one PR-generation send pipeline: the features' shared send composition
 * (featureChatSend: connection resolution, the prGeneration error surface, the
 * chat timeout) over one user turn. models.parameters records deliberately do
 * NOT apply here - this is not the chat path.
 */
function createPrSend(
	secrets: vscode.SecretStorage,
	oneShot: Pick<OneShotClient, "completeChatOnce">,
	log: (message: string, data?: unknown) => void
): PrGenerationModelSend {
	return (model, prompt, token) =>
		featureChatSend("prGeneration", { oneShot, secrets }, model, [{ role: "user", content: prompt }], token, log);
}

/**
 * The dashboard's test-model probe: the shared send over a fixed sample branch,
 * through the same prompt assembly and the same lenient parse the real feature
 * runs, so a green probe proves the model can produce a parseable answer rather
 * than merely that it replied. The sample is a tiny two-commit branch with one
 * patch hunk; the probe returns the parsed title, so an unparseable reply
 * surfaces as the empty-answer warning instead of a false success.
 */
export function createPrProbe(send: PrGenerationModelSend): (model: FeatureModelRef) => Promise<string | undefined> {
	return (model) =>
		withProbeToken(async (token) => {
			const provider = createTitleAndDescriptionProvider((prompt, cancellation) => send(model, prompt, cancellation));
			const result = await provider.provideTitleAndDescription(PROBE_CONTEXT, token);
			return result?.title;
		});
}

/**
 * The probe's canned branch: two commit messages and one small patch, enough
 * for any model to produce a title and a sentence. Nothing here is read from
 * the user's repository - a probe must never send a real diff.
 */
const PROBE_CONTEXT: TitleAndDescriptionContext = {
	commitMessages: ["feat: add a retry to the upload path", "test: cover the upload retry"],
	patches: [
		[
			"File: upload.ts",
			"@@ -1,3 +1,6 @@",
			" export async function upload(body: string): Promise<void> {",
			"-\tawait send(body);",
			"+\tfor (let attempt = 0; attempt < 3; attempt++) {",
			"+\t\ttry { return await send(body); } catch { /* retry */ }",
			"+\t}",
			" }",
		].join("\n"),
	],
	compareBranch: "feature/upload-retry",
};

/**
 * The branch the upstream context names, looked up across the open
 * repositories. Undefined when nothing can name it - no git API, no repository
 * carrying the branch, or no branch name in the context at all.
 */
async function resolveCompareBranch(
	compareBranch: string | undefined,
	resolveGit: () => Promise<API | undefined>
): Promise<Branch | undefined> {
	if (compareBranch === undefined || compareBranch === "") {
		return undefined;
	}
	const git = await resolveGit();
	if (git === undefined) {
		return undefined;
	}
	// A multi-root workspace can carry the same branch name in several
	// repositories, and only the tracking state of the RIGHT one says anything
	// about the order. The repository standing on that branch is asked first;
	// the rest are a fallback, since the upstream context names no repository.
	const ordered = [...git.repositories].sort((left, right) => {
		const leftIsHead = left.state.HEAD?.name === compareBranch ? 0 : 1;
		const rightIsHead = right.state.HEAD?.name === compareBranch ? 0 : 1;
		return leftIsHead - rightIsHead;
	});
	for (const repo of ordered) {
		try {
			return await repo.getBranch(compareBranch);
		} catch {
			// Not this repository's branch; a multi-root workspace asks the rest.
		}
	}
	return undefined;
}

/**
 * The provider handed to the GitHub Pull Requests extension: the shared
 * pipeline behind one call-site normalization. That extension builds
 * `commitMessages` oldest-first or newest-first depending on how it collected
 * them, and the prompt reads the list's tail as the recent end, so the order is
 * settled here - before any prompt exists - rather than guessed downstream.
 */
export function createGhprProvider(
	send: PrGenerationModelSend,
	model: () => FeatureModelRef | undefined,
	log: (message: string, data?: unknown) => void,
	resolveGit: () => Promise<API | undefined> = resolveGitApi
): TitleAndDescriptionProvider {
	return {
		async provideTitleAndDescription(context, token) {
			// Re-read BOTH gates per call, not just the model: the registration is
			// torn down asynchronously, so a call can arrive after the user turned
			// the feature off, and no repository content may leave on that call.
			const ref = isFeatureEnabled("prGeneration") ? model() : undefined;
			if (ref === undefined) {
				// A settings change racing an in-flight call: answer "could not",
				// which is the upstream API's own value for it, never a request.
				return undefined;
			}
			try {
				const branch = await resolveCompareBranch(context.compareBranch, resolveGit);
				// An unresolvable branch is not a branch without an upstream: leave
				// the list exactly as it arrived rather than reversing on a guess.
				const order = branch === undefined ? "oldestFirst" : ghprCommitOrder(branch);
				const normalized: TitleAndDescriptionContext = {
					...context,
					commitMessages: oldestFirstMessages(context.commitMessages, order),
				};
				const provider = createTitleAndDescriptionProvider((prompt, cancellation) => send(ref, prompt, cancellation));
				return await provider.provideTitleAndDescription(normalized, token);
			} catch (error) {
				// This call arrived from ANOTHER extension, so it is its own logging
				// boundary: a thrown RequestError carries server-derived text in its
				// message, and letting it escape would hand that text to that
				// extension's logger. Only the classification is recorded, and the
				// upstream API's "could not" value goes back. Cancellation is never
				// logged.
				if (!(error instanceof vscode.CancellationError)) {
					log(`PR generation: the GitHub Pull Requests generation failed (${errorLabel(error)})`);
				}
				return undefined;
			}
		},
	};
}

/**
 * The GitHub Pull Requests extension's API, or undefined when it is absent,
 * disabled, or too old to take a provider. Activating it is deliberate and
 * only ever happens once the user has both enabled this feature and picked a
 * model: its exports are unreadable until it activates, and it is the
 * extension the user is asking us to integrate with.
 *
 * `reportActivationFailure` is the caller's channel-only advisory sink
 * (Logger.advisory): the decision reruns on every settings change and every
 * extension change, and the issue-report buffer is a small ring, so a broken
 * install must not evict real history from it - the channel keeps every
 * occurrence instead.
 */
async function resolveGhprApi(
	reportActivationFailure: (message: string) => void
): Promise<GitHubPullRequestsApi | undefined> {
	const extension = vscode.extensions.getExtension<GitHubPullRequestsApi>(GHPR_EXTENSION_ID);
	if (extension === undefined) {
		return undefined;
	}
	let api: GitHubPullRequestsApi;
	try {
		api = extension.isActive ? extension.exports : await extension.activate();
	} catch (error) {
		// Another extension failing to activate is its problem, not a failure of
		// ours: classification only, and the feature simply stays unregistered.
		reportActivationFailure(
			`PR generation: the GitHub Pull Requests extension failed to activate (${errorLabel(error)})`
		);
		return undefined;
	}
	// Feature detection, not version detection: builds predating the provider
	// API have no such member, and a future build could drop it again.
	return typeof api?.registerTitleAndDescriptionProvider === "function" ? api : undefined;
}

/**
 * The registration state machine, extracted from the wiring so it can be
 * driven directly: `apply` is re-entrant and re-runs the whole decision, which
 * is what makes it correct to bind to any number of change events. It owns
 * exactly one registration handle, keyed by the API object it was made
 * against - a reinstall of the other extension mints a new object, and the
 * stale handle must be released rather than reused.
 */
export interface GhprRegistrar {
	/** Re-decide the registration. Safe to call repeatedly and concurrently; the last call wins. */
	apply(): Promise<void>;
	dispose(): void;
}

export function createGhprRegistrar(deps: {
	/** Whether the feature currently wants to be registered at all (enabled AND configured). */
	readonly wanted: () => boolean;
	readonly resolveApi: () => Promise<GitHubPullRequestsApi | undefined>;
	readonly title: () => string;
	readonly provider: () => TitleAndDescriptionProvider;
	readonly log: (message: string, data?: unknown) => void;
}): GhprRegistrar {
	let registration: vscode.Disposable | undefined;
	/** The exact API object the live registration was made against. */
	let registeredApi: GitHubPullRequestsApi | undefined;
	/** Terminal: once disposed, no apply may register again whatever fires afterwards. */
	let disposed = false;
	// Every apply takes a ticket; a continuation whose ticket is stale lost the
	// race to a later decision and must not act on what it read before its await.
	let ticket = 0;
	const release = (): void => {
		registration?.dispose();
		registration = undefined;
		registeredApi = undefined;
	};
	/**
	 * Disposal must also invalidate every in-flight apply: one awaiting the
	 * other extension's activation would otherwise resume afterwards and
	 * register a provider nothing will ever dispose - and, since that extension
	 * hands an unqualified request to the FIRST registered provider, a dead one
	 * would answer for the rest of the window.
	 */
	const dispose = (): void => {
		disposed = true;
		ticket++;
		release();
	};
	return {
		async apply() {
			if (disposed) {
				return;
			}
			const mine = ++ticket;
			const api = deps.wanted() ? await deps.resolveApi() : undefined;
			if (mine !== ticket || disposed) {
				return;
			}
			if (registration !== undefined && registeredApi === api) {
				// Already registered against this exact API object; re-registering
				// would add a second provider to that extension's set.
				return;
			}
			// Anything else - disabled, model cleared, the extension uninstalled or
			// reactivated - invalidates the handle we hold.
			release();
			if (api?.registerTitleAndDescriptionProvider === undefined) {
				return;
			}
			try {
				registration = api.registerTitleAndDescriptionProvider(deps.title(), deps.provider());
				registeredApi = api;
			} catch (error) {
				// A registration refused by the other extension leaves the feature's
				// own command working; nothing here is worth failing activation over.
				deps.log(`PR generation: registering with the GitHub Pull Requests extension failed (${errorLabel(error)})`);
			}
		},
		dispose,
	};
}

/**
 * Wire the feature. Returns the send so the dashboard's test-model probe runs
 * the exact pipeline the command and the GitHub integration run (one pipeline,
 * one truth).
 */
export function wirePrGeneration(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: { readonly oneShot: OneShotClient; readonly outputChannel: vscode.OutputChannel }
): { readonly prSend: PrGenerationModelSend } {
	const log = (message: string, data?: unknown): void => {
		logger.log(message, data);
	};
	const prSend = createPrSend(context.secrets, deps.oneShot, log);

	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.generatePrDescription, (commandArg?: unknown) =>
			runGeneratePrDescription(prSend, { logger, outputChannel: deps.outputChannel }, commandArg)
		)
	);

	// Channel-only, not once-latched: see resolveGhprApi.
	const reportActivationFailure = (message: string): void => {
		logger.advisory(message);
	};
	const registrar = createGhprRegistrar({
		// The channel-only advisory sink, because this decision reruns on every
		// settings change and every extension change: a half-written model ref
		// stays visible in the output channel without evicting real history from
		// the 50-entry issue-report ring. A real invocation still reports the
		// same malformed setting with the buffer-logging sink attached - the
		// command and the provider both read it that way.
		wanted: () =>
			isFeatureEnabled("prGeneration") &&
			getFeatureModelRef("prGeneration", (message, data) => {
				logger.advisory(message, data);
			}) !== undefined,
		resolveApi: () => resolveGhprApi(reportActivationFailure),
		// Never a title containing "Copilot": that extension selects a provider by
		// case-insensitive substring, and that word is the search term of a slot
		// this extension has no business answering.
		title: prGenerationProviderTitle,
		// The model is read per call, so a model change needs no re-registration.
		provider: () => createGhprProvider(prSend, () => getFeatureModelRef("prGeneration", log), log),
		log,
	});
	/** Fire-and-forget with a floor: the decision is best-effort, and a rejection is a log line, never an unhandled one. */
	const scheduleRegistration = (): void => {
		void registrar.apply().catch((error: unknown) => {
			log(`PR generation: deciding the GitHub Pull Requests registration failed (${errorLabel(error)})`);
		});
	};
	scheduleRegistration();

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				scheduleRegistration();
			}
		}),
		// The GitHub extension can arrive, leave, or be re-enabled long after
		// activation; without this the integration would need a window reload.
		vscode.extensions.onDidChange(scheduleRegistration),
		new vscode.Disposable(() => {
			registrar.dispose();
		})
	);
	return { prSend };
}
