#!/usr/bin/env pwsh
# Windows parity of scripts/setup-env.sh: initialize a freshly-created checkout or
# worktree by installing pinned project dependencies. Idempotent.
param(
	[switch]$Verify,
	[switch]$Full,
	[switch]$NoHooks
)

$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
	throw 'bun is required but not found. Install it from https://bun.sh, then re-run scripts/setup-env.ps1.'
}

if ($env:CI -eq 'true' -or $NoHooks) {
	$env:HUSKY = '0'
}

Write-Host 'Initializing litellm-vscode-chat: bun install --frozen-lockfile ...'
& bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) {
	throw 'bun install failed.'
}

if ($Verify -or $Full) {
	& bun run compile
	if ($LASTEXITCODE -ne 0) {
		throw 'compile failed.'
	}

	& bun run lint
	if ($LASTEXITCODE -ne 0) {
		throw 'lint failed.'
	}
}

if ($Full) {
	& bun run test
	if ($LASTEXITCODE -ne 0) {
		throw 'test failed.'
	}
}

Write-Host 'Done.'
