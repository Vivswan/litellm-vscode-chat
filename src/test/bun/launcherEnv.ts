/**
 * The two variables scripts/bun-test.ts writes into the environment of the bun process it starts, read here by
 * preload.ts (the marker) and hooksFailClosed.test.ts (the stashed index). The names are a contract between a script
 * and the test tree, so both sides import them rather than spelling them.
 */

/** Set by the launcher and by nothing else: its presence is what preload.ts admits a run on. */
export const BUN_TEST_LAUNCHER = "LVT_BUN_TEST_LAUNCHER";

/**
 * Where the launcher stashes the hook's GIT_INDEX_FILE before dropping every GIT_* variable. `git commit -a` and
 * `git commit <pathspec>` build the commit in a temporary index and point the hook at it, so a suite reading this
 * repository's staged tree needs the pointer back under a name no git reads.
 */
export const HOOK_GIT_INDEX_FILE = "LVT_HOOK_GIT_INDEX_FILE";
