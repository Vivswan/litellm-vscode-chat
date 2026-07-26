#!/usr/bin/env bun
// scripts/compose.ts
//
// Thin CLI over the resolved compose runtime (Docker or Podman), so every
// package.json script works on either: `bun scripts/compose.ts up -d --wait`.

import { runCompose } from "./composeCommand";

process.exit(runCompose(process.argv.slice(2)));
