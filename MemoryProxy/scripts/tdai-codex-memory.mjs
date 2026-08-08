#!/usr/bin/env node

import "tsx/esm";

const { runCodexBindingCli } = await import("../src/codex/cli.ts");
process.exitCode = await runCodexBindingCli(process.argv.slice(2));
