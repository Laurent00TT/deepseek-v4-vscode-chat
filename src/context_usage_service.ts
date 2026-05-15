/**
 * Stateful wrapper around the pure helpers in `./context_usage.ts`.
 *
 * Holds the latest snapshot, dispatches change events, and exposes
 * the two write entry points (`updateEstimate` before request,
 * `updateFromApi` after the SSE final-usage chunk) that the provider
 * calls.
 *
 * Kept in its own file because importing `vscode` at module top
 * level breaks Node-ESM unit tests against the pure-helper module.
 */

import * as vscode from "vscode";
import {
	type ApiUsageInput,
	type ContextUsageSnapshot,
	type EstimateInput,
	snapshotFromApi,
	snapshotFromEstimate,
} from "./context_usage";

export class ContextUsageService {
	private _snapshot: ContextUsageSnapshot | undefined;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	getSnapshot(): ContextUsageSnapshot | undefined {
		return this._snapshot;
	}

	updateEstimate(input: EstimateInput): void {
		this._snapshot = snapshotFromEstimate(input, this._snapshot, Date.now());
		this._onDidChange.fire();
	}

	updateFromApi(input: ApiUsageInput): void {
		this._snapshot = snapshotFromApi(input, this._snapshot, Date.now());
		this._onDidChange.fire();
	}

	/** Reasons we clear: `clearSession` command, secrets.onDidChange
	 * (API key swap implies the account may have changed). The reason
	 * string is for OutputChannel logging at the caller. */
	clear(_reason: string): void {
		this._snapshot = undefined;
		this._onDidChange.fire();
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
