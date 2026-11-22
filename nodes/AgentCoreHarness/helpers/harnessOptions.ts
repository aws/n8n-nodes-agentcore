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

/** Built-in tools documented for the harness managed tool set (selector names). */
export const BUILT_IN_TOOLS = [
	'shell',
	'read',
	'write',
	'edit',
	'todo_write',
	'retrieve_context',
	'subagent',
	'web_fetch',
] as const;

/** Splits a comma- or newline-separated selector list, trimmed and de-duplicated. */
export function parseSelectors(raw: string | undefined): string[] {
	if (!raw) return [];
	return Array.from(
		new Set(
			raw
				.split(/[\n,]/)
				.map((s) => s.trim())
				.filter(Boolean),
		),
	);
}

export interface AllowedToolsInput {
	/**
	 * Built-in tools to allow. `undefined` means the option was not added, so the
	 * built-in set is not restricted. An empty array means "no built-in tools".
	 */
	builtIns?: string[];
	/** Extra selectors, for example `@my-mcp-server/read_*`. */
	extraSelectors?: string;
	/** Names of the tools configured for this invocation (node tools or harness tools). */
	configuredToolNames: string[];
}

/**
 * Builds the per-invocation `allowedTools` list, or `undefined` for "no
 * restriction" (the service then allows every configured tool plus the managed
 * built-in set).
 *
 * Any restricted list also disables every configured tool it does not match,
 * and a plain name only matches built-in tools. A configured tool is matched by
 * `@<tool name>` (verified against the live service: `code_interpreter` does
 * not re-enable a configured Code Interpreter, `@code_interpreter` does). Users
 * restrict built-ins here, not the tools they configured on purpose, so every
 * configured tool is added as `@<name>` unless an extra selector already scopes
 * it (`@<name>` or `@<name>/...`), which lets users narrow an MCP server or
 * Gateway to some of its tools.
 */
export function buildAllowedTools(input: AllowedToolsInput): string[] | undefined {
	const extras = parseSelectors(input.extraSelectors);
	if (input.builtIns === undefined && extras.length === 0) return undefined;

	const selectors = [...(input.builtIns ?? []), ...extras];
	for (const name of input.configuredToolNames) {
		const scoped = selectors.some((s) => s === `@${name}` || s.startsWith(`@${name}/`));
		if (!scoped) selectors.push(`@${name}`);
	}
	return Array.from(new Set(selectors));
}

export type TruncationStrategy = 'none' | 'sliding_window' | 'summarization';

/**
 * Builds the `truncation` configuration (HarnessTruncationConfiguration) from
 * the Truncation group in Provisioning Options:
 *   { strategy: 'none' }
 *   { strategy: 'sliding_window', config: { slidingWindow: { messagesCount? } } }
 *   { strategy: 'summarization', config: { summarization: { summaryRatio?,
 *       preserveRecentMessages?, summarizationSystemPrompt? } } }
 *
 * `group` is the fixedCollection value, `{ config: { strategy, ... } }`.
 * Returns `undefined` when the group was not added, so the field is omitted and
 * the harness applies its managed context-management policy.
 */
export function buildTruncation(group: IDataObject | undefined): IDataObject | undefined {
	const cfg = group?.config as IDataObject | undefined;
	if (!cfg) return undefined;
	const strategy = ((cfg.strategy as string) || 'sliding_window') as TruncationStrategy;
	switch (strategy) {
		case 'none':
			return { strategy: 'none' };
		case 'summarization': {
			const summarization: IDataObject = {};
			// Ranges are not documented in the API model, so the service validates them.
			const ratio = numberOrUndef(cfg.summaryRatio);
			if (ratio !== undefined) summarization.summaryRatio = ratio;
			const preserve = wholeNumber(cfg.preserveRecentMessages, 'Preserve Recent Messages');
			if (preserve !== undefined) summarization.preserveRecentMessages = preserve;
			const prompt = ((cfg.summarizationSystemPrompt as string) || '').trim();
			if (prompt) summarization.summarizationSystemPrompt = prompt;
			return { strategy: 'summarization', config: { summarization } };
		}
		case 'sliding_window':
		default: {
			const slidingWindow: IDataObject = {};
			const messagesCount = wholeNumber(cfg.messagesCount, 'Window Size');
			if (messagesCount !== undefined) slidingWindow.messagesCount = messagesCount;
			return { strategy: 'sliding_window', config: { slidingWindow } };
		}
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
	truncation?: IDataObject;
	tags?: Record<string, string>;
}

/**
 * Adds `truncation` and `tags` to a CreateHarness or UpdateHarness payload.
 * Returns a new object; `payload` is not mutated.
 *
 * Truncation is sent whenever configured. UpdateHarness has no value meaning
 * "back to the managed default", so removing it keeps the stored setting.
 * Tags go on CreateHarness only; later changes are applied with
 * TagResource / UntagResource (see `syncTags`), which needs no harness update.
 * Allowed tools are not set on the harness at all: they are sent on every
 * InvokeHarness instead, so changing them never triggers an update.
 */
export function withHarnessOptions(
	payload: IDataObject,
	options: HarnessOptions,
	mode: 'create' | 'update',
): IDataObject {
	const out: IDataObject = { ...payload };
	if (options.truncation) out.truncation = options.truncation;
	if (mode === 'create' && options.tags) out.tags = options.tags;
	return out;
}

export interface TagClient {
	tagResource(resourceArn: string, tags: Record<string, string>): Promise<unknown>;
	untagResource(resourceArn: string, tagKeys: string[]): Promise<unknown>;
}

/**
 * Brings the harness tags in line with the Tags field and returns the tags to
 * remember for next time.
 *
 * `stored` is what the node last applied. It is `undefined` for a harness the
 * node created before tag sync existed or adopted by name, in which case tags
 * are only added or overwritten, never removed, so tags set outside n8n are not
 * deleted. Tags copied to the managed runtime and memory at creation are not
 * changed; TagResource applies to the harness itself.
 */
export async function syncTags(
	client: TagClient,
	resourceArn: string,
	stored: Record<string, string> | undefined,
	desired: Record<string, string> | undefined,
): Promise<Record<string, string>> {
	const want = desired ?? {};
	const toSet: Record<string, string> = {};
	for (const [k, v] of Object.entries(want)) {
		if (stored?.[k] !== v) toSet[k] = v;
	}
	const toRemove = stored ? Object.keys(stored).filter((k) => !(k in want)) : [];
	if (Object.keys(toSet).length > 0) await client.tagResource(resourceArn, toSet);
	if (toRemove.length > 0) await client.untagResource(resourceArn, toRemove);
	return want;
}
