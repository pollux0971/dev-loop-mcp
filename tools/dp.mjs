#!/usr/bin/env node
// Before 4.8.0 the CLI was tools/dp.mjs (the tool was called dp). This file only forwards to tools/dlm.mjs, so things
// set up before the rename keep working until they are updated: an MCP server still registered as dp
// (run `node tools/dlm.mjs mcp install` to replace it) and the hooks of a Claude Code session started before the upgrade
// (restart Claude Code). Safe to delete once both are done.
await import('./dlm.mjs');
