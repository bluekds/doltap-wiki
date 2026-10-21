#!/usr/bin/env node
// Bootstrap: silence the node:sqlite ExperimentalWarning before any module that imports node:sqlite loads.
import "@doltap/core/quiet";
await import("./mcp-main.js");
