#!/usr/bin/env bash
# Install the virtual display and Electron runtime libraries the extension-host
# test suites need on a headless Linux box; the devcontainer image ships
# neither, and CI provides them via the hosted runner image. Idempotent and a
# no-op where apt-get is absent.
set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
	echo "apt-get not found; skipping test runtime library install." >&2
	exit 0
fi

# The devcontainer image runs this as root; a plain checkout's user goes through sudo.
uid="$(id -u)"
SUDO="sudo"
if [ "$uid" -eq 0 ]; then
	SUDO=""
fi

$SUDO apt-get update
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
	libasound2 \
	libgbm1 \
	libgtk-3-0 \
	libnss3 \
	libsecret-1-0 \
	xauth \
	xvfb
$SUDO rm -rf /var/lib/apt/lists/*
