/**
 * The docker-stack orchestrator's suite labels in canonical execution order,
 * shared by scripts/docker-test.ts (which runs them) and the drift guards
 * (which pin the CI shard lists in checks.yml to this set). The order is
 * load-bearing: docker-monkey stays last because its walks deliberately
 * dirty host state that no later suite should inherit, so any --only
 * selection replays this order rather than the flag's.
 */
export const DOCKER_TEST_LABELS = [
	"docker",
	"docker-usage",
	"docker-transport",
	"docker-serversync",
	"docker-resolution",
	"docker-fuzz",
	"docker-conversation",
	"docker-group-path",
	"host-fidelity",
	"host-fidelity-groups",
	"docker-monkey",
] as const;

export type DockerTestLabel = (typeof DOCKER_TEST_LABELS)[number];

/**
 * The orchestrator's --skip-* flag per skippable label, shared by
 * scripts/docker-test.ts (which parses them) and the nightly-fuzz drift
 * guard (which pins the workflow's unseeded leg to the complement of the
 * seeded labels through exactly these flags). The base `docker` label has no
 * skip flag on purpose: the default full run always includes it.
 */
export const DOCKER_SKIP_FLAGS: Readonly<Partial<Record<DockerTestLabel, string>>> = {
	"docker-usage": "--skip-usage",
	"docker-transport": "--skip-transport",
	"docker-serversync": "--skip-serversync",
	"docker-resolution": "--skip-resolution",
	"docker-fuzz": "--skip-fuzz",
	"docker-conversation": "--skip-conversation",
	"docker-group-path": "--skip-group-path",
	"host-fidelity": "--skip-host-fidelity",
	"host-fidelity-groups": "--skip-host-fidelity-groups",
	"docker-monkey": "--skip-monkey",
};

/**
 * Parse a --only value (comma-separated labels) into the selection to run,
 * deduplicated and in canonical order. Unknown and empty labels throw with
 * the known set spelled out: a renamed label must break a CI shard loudly,
 * never degrade it into running nothing.
 */
export function parseOnlyLabels(value: string): DockerTestLabel[] {
	const known: ReadonlySet<string> = new Set(DOCKER_TEST_LABELS);
	const requested = new Set<string>();
	for (const entry of value.split(",")) {
		const label = entry.trim();
		if (label === "" || !known.has(label)) {
			const problem = label === "" ? "empty label" : `unknown label "${label}"`;
			throw new Error(`${problem} in --only "${value}"; known labels: ${DOCKER_TEST_LABELS.join(", ")}`);
		}
		requested.add(label);
	}
	return DOCKER_TEST_LABELS.filter((label) => requested.has(label));
}
