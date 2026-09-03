/**
 * Per-test deadline for suites whose subject runs in child processes they
 * spawn. Each child is milliseconds in isolation; the cost is environmental.
 * Bun's startup reads every ancestor directory of its cwd, so a bun child
 * launched from a scratch directory under os.tmpdir() pays for the machine's
 * whole tmpdir population, I/O-bound and multiplied by load, and no project
 * marker in the scratch directory shortens that walk; a chain of a dozen git
 * spawns plus hook scripts crosses bun test's 5000 ms default under the same
 * load. The tests carrying this that launch from REPO_ROOT skip the tmpdir
 * term and take the same budget rather than a size of their own. Membership
 * is enforced, not remembered: childProcessTimeoutCoverage.test.ts fails on a
 * spawn-reaching test or hook without this deadline and on one carrying it
 * that spawns nothing.
 */
export const CHILD_PROCESS_TIMEOUT_MS = 60_000;
