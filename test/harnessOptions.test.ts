/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import {
	buildTruncation,
	parseAllowedTools,
	parseTags,
	withHarnessOptions,
} from '../nodes/AgentCoreHarness/helpers/harnessOptions';

describe('parseAllowedTools', () => {
	it('returns undefined when blank, so the service default applies', () => {
		expect(parseAllowedTools(undefined)).toBeUndefined();
		expect(parseAllowedTools('')).toBeUndefined();
		expect(parseAllowedTools(' , \n ')).toBeUndefined();
	});

	it('splits on commas and newlines, trims, and de-duplicates', () => {
		expect(parseAllowedTools('read, shell\n@builtin/edit,read')).toEqual([
			'read',
			'shell',
			'@builtin/edit',
		]);
	});

	it('passes every documented selector form through unchanged', () => {
		const selectors = [
			'*',
			'shell',
			'file_*',
			'@builtin',
			'@builtin/shell',
			'@git',
			'@git/git_status',
			'@git/read_*',
			'@*-mcp/status',
		];
		expect(parseAllowedTools(selectors.join(','))).toEqual(selectors);
	});
});

describe('buildTruncation', () => {
	const group = (config: Record<string, unknown>) => ({ config });

	it('omits truncation when the group was not added', () => {
		expect(buildTruncation(undefined)).toBeUndefined();
		expect(buildTruncation({})).toBeUndefined();
	});

	it('builds none', () => {
		expect(buildTruncation(group({ strategy: 'none' }))).toEqual({ strategy: 'none' });
	});

	it('builds sliding_window with messagesCount, the default strategy', () => {
		expect(buildTruncation(group({ strategy: 'sliding_window', messagesCount: 12 }))).toEqual({
			strategy: 'sliding_window',
			config: { slidingWindow: { messagesCount: 12 } },
		});
		// The UI pre-fills the strategy; a missing one falls back to sliding_window.
		expect(buildTruncation(group({ messagesCount: 20 }))).toEqual({
			strategy: 'sliding_window',
			config: { slidingWindow: { messagesCount: 20 } },
		});
	});

	it('builds summarization with every option', () => {
		expect(
			buildTruncation(
				group({
					strategy: 'summarization',
					summaryRatio: 0.4,
					preserveRecentMessages: 6,
					summarizationSystemPrompt: '  Summarize tersely.  ',
				}),
			),
		).toEqual({
			strategy: 'summarization',
			config: {
				summarization: {
					summaryRatio: 0.4,
					preserveRecentMessages: 6,
					summarizationSystemPrompt: 'Summarize tersely.',
				},
			},
		});
	});

	it('ignores values that belong to a different strategy', () => {
		// n8n keeps hidden values in the group, so switching strategy must not leak them.
		expect(
			buildTruncation(group({ strategy: 'sliding_window', messagesCount: 8, summaryRatio: 0.4 })),
		).toEqual({ strategy: 'sliding_window', config: { slidingWindow: { messagesCount: 8 } } });
	});

	it('rejects a non-integer window size', () => {
		expect(() =>
			buildTruncation(group({ strategy: 'sliding_window', messagesCount: 2.5 })),
		).toThrow(/whole number/);
	});
});

describe('parseTags', () => {
	it('returns undefined when blank', () => {
		expect(parseTags('')).toBeUndefined();
		expect(parseTags(undefined)).toBeUndefined();
		expect(parseTags('{}')).toBeUndefined();
	});

	it('accepts a JSON string or an already-parsed object', () => {
		expect(parseTags('{"team":"support","cost-center":"1234"}')).toEqual({
			team: 'support',
			'cost-center': '1234',
		});
		expect(parseTags({ team: 'support' })).toEqual({ team: 'support' });
	});

	it('rejects non-object JSON and non-string values', () => {
		expect(() => parseTags('not json')).toThrow(/JSON object/);
		expect(() => parseTags('["a"]')).toThrow(/JSON object/);
		expect(() => parseTags('{"n": 1}')).toThrow(/must have a string value/);
	});
});

describe('withHarnessOptions', () => {
	const base = { systemPrompt: [{ text: 'x' }] };
	const truncation = { strategy: 'none' };

	it('create: sends each option only when configured', () => {
		expect(withHarnessOptions(base, {}, 'create')).toEqual(base);
		expect(
			withHarnessOptions(
				base,
				{ allowedTools: ['read'], truncation, tags: { team: 'a' } },
				'create',
			),
		).toEqual({ ...base, allowedTools: ['read'], truncation, tags: { team: 'a' } });
	});

	it('update: restores the default tool set when Allowed Tools is cleared', () => {
		// Omitting allowedTools on UpdateHarness would keep a stale restriction.
		expect(withHarnessOptions(base, {}, 'update')).toEqual({ ...base, allowedTools: ['*'] });
		expect(withHarnessOptions(base, { allowedTools: ['shell'] }, 'update')).toEqual({
			...base,
			allowedTools: ['shell'],
		});
	});

	it('update: never sends tags (create-only) and sends truncation when set', () => {
		expect(withHarnessOptions(base, { tags: { team: 'a' }, truncation }, 'update')).toEqual({
			...base,
			allowedTools: ['*'],
			truncation,
		});
	});

	it('does not mutate the input payload', () => {
		const input = { ...base };
		withHarnessOptions(input, { allowedTools: ['read'] }, 'create');
		expect(input).toEqual(base);
	});
});
