import type { CancellationToken } from "vscode";
import { truncateKeepingHead } from "../../../shared/util/text";
import type { Branch, Change, Commit, Repository } from "../gitApi";
import { PATCHES_CHAR_LIMIT, type TitleAndDescriptionContext } from "./prompt";

/**
 * The generation context when the request is ours rather than the GitHub Pull Requests extension's. Pure over
 * the injected Repository so the whole walk tests without a git checkout, and shaped exactly like the context
 * that extension hands its provider, so one prompt assembly serves both entry points.
 */

/** How many changed files may contribute a patch block; a huge branch costs one git call per file. */
export const PR_PATCH_FILE_LIMIT = 100;

/** Fixed characters one assembled patch block adds beyond its header name: the "File: " lead, its newline, and the block separator. */
const PATCH_BLOCK_FIXED_OVERHEAD = "File: \n\n\n".length;

/** The marker a cut patch carries; charged against the budget like the text it replaces. */
const PATCH_TRUNCATION_MARKER = "\n[patch truncated]";

/** Which end of a commit-message list holds the most recent commit. */
export type CommitListOrder = "oldestFirst" | "newestFirst";

/**
 * The GitHub Pull Requests extension's own fork test compares the remote head with the local commit, which only
 * a network call can answer, so the stand-in is the tracking state git already knows. A caller that cannot
 * resolve the branch must NOT ask, since an unknown branch is not a branch without an upstream.
 *
 *   compare branch pushed, remote head matching -> GitHub compare API, oldest first
 *   anything else                               -> `git log`, newest first
 */
export function ghprCommitOrder(branch: Branch): CommitListOrder {
	if (branch.upstream === undefined) {
		return "newestFirst";
	}
	return (branch.ahead ?? 0) === 0 && (branch.behind ?? 0) === 0 ? "oldestFirst" : "newestFirst";
}

/** One commit-message list as oldest-first, the order the prompt's tail-truncation reads as recent. */
export function oldestFirstMessages(messages: readonly string[], order: CommitListOrder): string[] {
	return order === "oldestFirst" ? [...messages] : [...messages].reverse();
}

/**
 * The branch walk's result. Every non-collected variant is a legitimate state
 * of a local repository, mapped by the command to its own advice - none is an
 * error, so none reaches a log.
 */
export type BranchContextOutcome =
	| { readonly kind: "collected"; readonly context: TitleAndDescriptionContext }
	/** Detached HEAD or an unborn branch: there is no branch to describe. */
	| { readonly kind: "noBranch" }
	/** Nothing names a branch this one would be merged into, so there is nothing to compare against. */
	| { readonly kind: "noBase" }
	/** The base resolved to this branch's own upstream: the branch is being compared with itself. */
	| { readonly kind: "selfCompare" }
	/** The caller cancelled while the walk was still gathering; nothing may be sent. */
	| { readonly kind: "cancelled" }
	/** The branch and its base agree: no commits and no file changes to describe. */
	| { readonly kind: "noChanges" };

/**
 * How a base branch is addressed on the wire. `getBranchBase` answers with a
 * REMOTE-tracking branch - `remote` set, `name` without the prefix - and git
 * itself writes that pair back as "<remote>/<name>", so the prefix must be
 * rebuilt or the ref would name a LOCAL branch instead: one that may not exist
 * (a fresh clone that never checked the default branch out) or, worse, may
 * exist and be stale, silently comparing against work that is already merged.
 * The other two forms are fallbacks for shapes git does not currently produce.
 */
function baseRef(branch: Branch): string | undefined {
	if (branch.remote !== undefined && branch.name !== undefined) {
		return `${branch.remote}/${branch.name}`;
	}
	if (branch.upstream !== undefined) {
		return `${branch.upstream.remote}/${branch.upstream.name}`;
	}
	return branch.name;
}

/**
 * The messages of the branch's own commits, oldest first, with merge commits
 * dropped as PR noise. Deliberately NOT count-bounded here: the prompt thins an
 * over-long list from the middle so both ends survive, and cutting one end off
 * first would hand that decision back to whichever end this function trimmed.
 * The range already bounds the walk to the branch's own commits.
 */
function branchCommitMessages(commits: readonly Commit[]): string[] {
	return commits
		.filter((commit) => commit.parents.length <= 1)
		.map((commit) => commit.message.trim())
		.filter((message) => message !== "")
		.reverse();
}

/**
 * One patch block per changed file, in the shape the upstream provider's
 * object variant uses. Three bounds, because each file costs its own git call
 * AND a single generated file can carry megabytes: at most PR_PATCH_FILE_LIMIT
 * files, each patch cut to what is left of the prompt's whole patch budget,
 * and collection stopping once that budget is spent - so even the first file
 * cannot be unbounded. A file whose patch cannot be read (a binary blob, a
 * vanished path) is skipped rather than failing the whole walk.
 */
async function branchPatches(
	repo: Repository,
	mergeBase: string,
	changes: readonly Change[],
	token: CancellationToken | undefined
): Promise<{ patch: string; fileUri: string }[]> {
	const patches: { patch: string; fileUri: string }[] = [];
	// The prompt cuts the ASSEMBLED blocks at the same constant, and assembly
	// adds a "File: <name>" header and a separator per patch. Each block is
	// therefore charged its own real overhead - the URI is an upper bound on
	// the relativized name the header will carry - rather than a flat guess
	// that both over-reserves for one file and under-reserves for a hundred
	// long paths. Without it, a collection that believed it was within budget
	// would lose its tail files to that second cut.
	let remaining = PATCHES_CHAR_LIMIT;
	for (const change of changes.slice(0, PR_PATCH_FILE_LIMIT)) {
		// One git call per file: a cancelled request must stop paying for them
		// rather than run the whole list out before the send notices.
		if (remaining <= 0 || token?.isCancellationRequested === true) {
			break;
		}
		let patch: string;
		try {
			patch = await repo.diffWith(mergeBase, change.uri.fsPath);
		} catch {
			continue;
		}
		if (patch.trim() !== "") {
			const fileUri = change.uri.toString();
			const overhead = PATCH_BLOCK_FIXED_OVERHEAD + fileUri.length;
			const truncating = patch.length > remaining - overhead;
			// A truncated block also carries its marker, which the prompt's own
			// cut would otherwise have to pay for.
			const forPatch = remaining - overhead - (truncating ? PATCH_TRUNCATION_MARKER.length : 0);
			if (forPatch <= 0) {
				// No room left for anything worth reading: a header over an empty
				// body spends budget to tell the model nothing.
				break;
			}
			// The shared surrogate-safe cut, like every other model-bound
			// truncation: a lone surrogate in the JSON body is what a strict
			// gateway rejects.
			const kept = truncating ? `${truncateKeepingHead(patch, forPatch)}${PATCH_TRUNCATION_MARKER}` : patch;
			patches.push({ patch: kept, fileUri });
			remaining -= kept.length + overhead;
		}
	}
	return patches;
}

/**
 * Neither a PR template nor issue context rides along, because both are the GitHub extension's own enrichment
 * and inventing them locally would put text in the prompt the user never wrote.
 *
 *   compared from the merge base -> commits landing on the base meanwhile do not read as this branch's work
 *   working tree included        -> matches the upstream create view, so edits to TRACKED files count and untracked files do not
 */
export async function collectBranchContext(repo: Repository, token?: CancellationToken): Promise<BranchContextOutcome> {
	const head = repo.state.HEAD;
	const compareBranch = head?.name;
	if (compareBranch === undefined || compareBranch === "") {
		return { kind: "noBranch" };
	}
	// getBranchBase writes the resolved base back to git config, so it can
	// reject on a read-only repository; not knowing the base is the noBase
	// state, not an error worth a notification.
	let base: Branch | undefined;
	try {
		base = await repo.getBranchBase(compareBranch);
	} catch {
		return { kind: "noBase" };
	}
	const ref = base === undefined ? undefined : baseRef(base);
	if (ref === undefined || ref === "") {
		return { kind: "noBase" };
	}
	// The one shape that is genuinely a branch compared with ITSELF: the base
	// resolved to this branch's own upstream, where the diff would be only the
	// unpushed commits. A base whose leaf name merely matches - local "main"
	// based on "origin/main", the fork-from-main workflow - is a real
	// comparison and must not be refused.
	if (head?.upstream !== undefined && base?.remote === head.upstream.remote && base?.name === head.upstream.name) {
		return { kind: "selfCompare" };
	}
	const mergeBase = await repo.getMergeBase(ref, "HEAD");
	if (mergeBase === undefined || mergeBase === "") {
		// Unrelated histories: no common ancestor means no meaningful comparison.
		return { kind: "noBase" };
	}
	const [commits, changes] = await Promise.all([repo.log({ range: `${mergeBase}..HEAD` }), repo.diffWith(mergeBase)]);
	const commitMessages = branchCommitMessages(commits);
	const patches = await branchPatches(repo, mergeBase, changes, token);
	// A cancelled walk returns whatever it had gathered, which is neither a
	// complete context nor an empty branch: answering "noChanges" would be a
	// lie, and sending the partial gather would put repository content on the
	// wire after the user asked for it to stop.
	if (token?.isCancellationRequested === true) {
		return { kind: "cancelled" };
	}
	if (commitMessages.length === 0 && patches.length === 0) {
		return { kind: "noChanges" };
	}
	return { kind: "collected", context: { commitMessages, patches, compareBranch } };
}
