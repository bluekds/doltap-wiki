#!/usr/bin/env node
// Bootstrap: silence the node:sqlite ExperimentalWarning before any module that imports node:sqlite loads.
import "@bluekds/doltap-core/quiet";
await import("./cli.js");
