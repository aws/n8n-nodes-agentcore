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
	it('omits truncation for the service default', () => {
		expect(buildTruncation({})).toBeUndefined();
		expect(
			buildTruncation({ truncationStrategy: 'default', truncationSummaryRatio: 0.5 }),
		).toBeUndefined();
	});

	it('builds none', () => {
		expect(buildTruncation({ truncationStrategy: 'none' })).toEqual({ strategy: 'none' });
	});

	it('builds sliding_window with messagesCount', () => {
		expect(
			buildTruncation({ truncationStrategy: 'sliding_window', truncationMessagesCount: 12 }),
		).toEqual({
			strategy: 'sliding_window',
			config: { slidingWindow: { messagesCount: 12 } },
		});
	});

	it('builds summarization with every option', () => {
		expect(
			buildTruncation({
				truncationStrategy: 'summarization',
				truncationSummaryRatio: 0.4,
				truncationPreserveRecentMessages: 6,
				truncationSummaryPrompt: '  Summarize tersely.  ',
			}),
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

	it('ignores options that belong to a different strategy', () => {
		expect(
			buildTruncation({ truncationStrategy: 'sliding_window', truncationSummaryRatio: 0.4 }),
		).toEqual({ strategy: 'sliding_window', config: { slidingWindow: {} } });
	});

	it('rejects a non-integer message count', () => {
		expect(() =>
			buildTruncation({ truncationStrategy: 'sliding_window', truncationMessagesCount: 2.5 }),
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
