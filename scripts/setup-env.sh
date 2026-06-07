#!/usr/bin/env bash
# Initialize a freshly-created checkout or worktree by installing pinned project
# dependencies. Idempotent and safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."

usage() {
	cat <<'USAGE'
Usage: scripts/setup-env.sh [--verify] [--full] [--no-hooks]

Options:
  --verify    Install dependencies, then run compile and lint.
  --full      Install dependencies, then run compile, lint, and tests.
  --no-hooks  Disable Husky during dependency installation.

The default mode only installs pinned dependencies. Husky hooks are installed
for local checkouts, but are disabled automatically when CI=true.
USAGE
}

run_compile=0
run_lint=0
run_test=0
disable_hooks=0

for arg in "$@"; do
	case "$arg" in
		--verify)
			run_compile=1
			run_lint=1
			;;
		--full)
			run_compile=1
			run_lint=1
			run_test=1
			;;
		--no-hooks)
			disable_hooks=1
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "Unknown option: $arg" >&2
			usage >&2
			exit 2
			;;
	esac
done

if ! command -v bun >/dev/null 2>&1; then
	echo "Bun is required. Install Bun or run this from a workflow/devcontainer that provisions Bun first." >&2
	exit 1
fi

if [ "${CI:-}" = "true" ] || [ "$disable_hooks" -eq 1 ]; then
	export HUSKY=0
fi

echo "Initializing litellm-vscode-chat: bun install --frozen-lockfile ..."
bun install --frozen-lockfile

if [ "$run_compile" -eq 1 ]; then
	bun run compile
fi

if [ "$run_lint" -eq 1 ]; then
	bun run lint
fi

if [ "$run_test" -eq 1 ]; then
	bun run test
fi

echo "Done."
