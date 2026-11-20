/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { ApplicationError, type IDataObject } from 'n8n-workflow';

/**
 * Builders for harness-level options that are not tools, skills, memory, or
 * environment: `allowedTools`, `truncation`, and `tags`.
 *
 * Shapes verified against @aws-sdk/client-bedrock-agentcore-control@3.1173.0
 * (CreateHarnessRequest, UpdateHarnessRequest, InvokeHarnessRequest) and the
 * harness tools / models documentation.
 */

/**
 * Parses the Allowed Tools field into the `allowedTools` selector list.
 *
 * Selectors are passed through unchanged so every documented pattern works:
 * plain built-in names (`shell`, `read`), `@builtin`, `@builtin/<name>`,
 * `@<server>`, `@<server>/<tool>`, and globs. Returns `undefined` when the
 * field is empty, so the service default applies (the current recommended
 * built-in tool set, equivalent to `["*"]`).
 */
export function parseAllowedTools(raw: string | undefined): string[] | undefined {
	if (!raw) return undefined;
	const selectors = raw
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (selectors.length === 0) return undefined;
	return Array.from(new Set(selectors));
}

export type TruncationStrategy = 'default' | 'none' | 'sliding_window' | 'summarization';

/**
 * Builds the `truncation` configuration (HarnessTruncationConfiguration):
 *   { strategy: 'none' }
 *   { strategy: 'sliding_window', config: { slidingWindow: { messagesCount? } } }
 *   { strategy: 'summarization', config: { summarization: { summaryRatio?,
 *       preserveRecentMessages?, summarizationSystemPrompt? } } }
 *
 * Returns `undefined` for the "service default" choice, so the field is
 * omitted and the harness applies its managed context-management policy
 * (documented as summarization, which can change over time).
 */
export function buildTruncation(opts: IDataObject): IDataObject | undefined {
	const strategy = ((opts.truncationStrategy as string) || 'default') as TruncationStrategy;
	switch (strategy) {
		case 'none':
			return { strategy: 'none' };
		case 'sliding_window': {
			const slidingWindow: IDataObject = {};
			const messagesCount = wholeNumber(opts.truncationMessagesCount, 'Truncation Window Size');
			if (messagesCount !== undefined) slidingWindow.messagesCount = messagesCount;
			return { strategy: 'sliding_window', config: { slidingWindow } };
		}
		case 'summarization': {
			const summarization: IDataObject = {};
			// Ranges are not documented in the API model, so the service validates them.
			const ratio = numberOrUndef(opts.truncationSummaryRatio);
			if (ratio !== undefined) summarization.summaryRatio = ratio;
			const preserve = wholeNumber(
				opts.truncationPreserveRecentMessages,
				'Truncation Preserve Recent Messages',
			);
			if (preserve !== undefined) summarization.preserveRecentMessages = preserve;
			const prompt = ((opts.truncationSummaryPrompt as string) || '').trim();
			if (prompt) summarization.summarizationSystemPrompt = prompt;
			return { strategy: 'summarization', config: { summarization } };
		}
		case 'default':
		default:
			return undefined;
	}
}

/**
 * Parses the Tags (JSON) field into a string-to-string map for CreateHarness.
 * Returns `undefined` when empty. Non-string values are rejected rather than
 * coerced, so a typo such as a nested object is reported instead of sent.
 */
export function parseTags(raw: unknown): Record<string, string> | undefined {
	if (raw === undefined || raw === null || raw === '') return undefined;
	let parsed: unknown = raw;
	if (typeof raw === 'string') {
		if (raw.trim() === '') return undefined;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// Reported below as "must be a JSON object", outside the catch clause.
			parsed = undefined;
		}
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ApplicationError('Tags must be a JSON object, for example {"team": "support"}.');
	}
	const tags: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value !== 'string') {
			throw new ApplicationError(`Tag "${key}" must have a string value.`);
		}
		tags[key] = value;
	}
	return Object.keys(tags).length > 0 ? tags : undefined;
}

function numberOrUndef(value: unknown): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const n = Number(value);
	return Number.isNaN(n) ? undefined : n;
}

function wholeNumber(value: unknown, label: string): number | undefined {
	const n = numberOrUndef(value);
	if (n === undefined) return undefined;
	if (!Number.isInteger(n) || n < 0) {
		throw new ApplicationError(`${label} must be a whole number, got ${n}.`);
	}
	return n;
}

export interface HarnessOptions {
	allowedTools?: string[];
	truncation?: IDataObject;
	tags?: Record<string, string>;
}

/**
 * Adds `allowedTools`, `truncation`, and `tags` to a CreateHarness or
 * UpdateHarness payload. Returns a new object; `payload` is not mutated.
 *
 * Create: each field is sent only when configured, so an unset field means
 * "use the service default".
 *
 * Update: an omitted field on UpdateHarness means "keep the stored value". The
 * node owns a Run Agent harness, so clearing Allowed Tools must restore the
 * default rather than leave a stale restriction in place; it is sent as `["*"]`,
 * which the service documents as equivalent to omitting it. Truncation has no
 * equivalent "default" value, so it is only sent when configured. Tags are
 * create-only (UpdateHarness has no tags field).
 */
export function withHarnessOptions(
	payload: IDataObject,
	options: HarnessOptions,
	mode: 'create' | 'update',
): IDataObject {
	const out: IDataObject = { ...payload };
	if (options.allowedTools && options.allowedTools.length > 0) {
		out.allowedTools = options.allowedTools;
	} else if (mode === 'update') {
		out.allowedTools = ['*'];
	}
	if (options.truncation) out.truncation = options.truncation;
	if (mode === 'create' && options.tags) out.tags = options.tags;
	return out;
}
