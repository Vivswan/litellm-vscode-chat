/**
 * Per-test deadline for suites that spawn child processes. The children are fast; bun's startup walks every ancestor
 * directory of its cwd, so under load a child launched from os.tmpdir() pays for the whole tmpdir population, and a
 * shell chain of hook scripts crosses bun test's 5000 ms default the same way.
 * childProcessTimeoutCoverage.test.ts enforces membership:
 *   spawning test without this deadline -> fails  |  non-spawning test carrying it -> fails
 */
export const CHILD_PROCESS_TIMEOUT_MS = 60_000;
