"use strict";
// `node --require ./test/vscode_shim/register.cjs test/adapter_x.mjs`
// Resolves the bare specifier "vscode" (required by the compiled adapters in
// out/) to the test shim. CJS-only on purpose: out/*.js is CommonJS.
const Module = require("node:module");
const path = require("node:path");

const shimPath = path.join(__dirname, "index.cjs");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithShim(request, ...rest) {
	if (request === "vscode") {
		return shimPath;
	}
	return originalResolve.call(this, request, ...rest);
};
