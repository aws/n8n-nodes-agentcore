/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi } from 'vitest';
import {
	buildAllowedTools,
	buildHooks,
	buildTruncation,
	parseSelectors,
	parseTags,
	syncTags,
	withHarnessOptions,
} from '../nodes/AgentCoreHarness/helpers/harnessOptions';

describe('parseSelectors', () => {
	it('splits on commas and newlines, trims, and de-duplicates', () => {
		expect(parseSelectors(undefined)).toEqual([]);
		expect(parseSelectors(' , \n ')).toEqual([]);
		expect(parseSelectors('@a/x, @b\n@a/x')).toEqual(['@a/x', '@b']);
	});
});

describe('buildAllowedTools', () => {
	const configured = ['code_interpreter', 'lookup_order'];

	it('is unrestricted (undefined) when neither option was added', () => {
		expect(buildAllowedTools({ configuredToolNames: configured })).toBeUndefined();
		expect(
			buildAllowedTools({ extraSelectors: ' ', configuredToolNames: configured }),
		).toBeUndefined();
	});

	it('keeps every configured tool available as @<name> when built-ins are restricted', () => {
		// Verified live: a restricted list disables configured tools, a plain name
		// does not re-enable them, and @<name> does.
		expect(buildAllowedTools({ builtIns: ['read'], configuredToolNames: configured })).toEqual([
			'read',
			'@code_interpreter',
			'@lookup_order',
		]);
	});

	it('allows only the configured tools when no built-ins are selected', () => {
		expect(buildAllowedTools({ builtIns: [], configuredToolNames: configured })).toEqual([
			'@code_interpreter',
			'@lookup_order',
		]);
	});

	it('returns an empty list, not undefined, for no built-ins and no configured tools', () => {
		// Verified live: allowedTools [] is accepted and means no tools at all.
		expect(buildAllowedTools({ builtIns: [], configuredToolNames: [] })).toEqual([]);
	});

	it('lets an extra selector narrow one configured tool without re-adding all of it', () => {
		expect(
			buildAllowedTools({
				builtIns: ['read'],
				extraSelectors: '@my-mcp/read_*',
				configuredToolNames: ['my-mcp', 'code_interpreter'],
			}),
		).toEqual(['read', '@my-mcp/read_*', '@code_interpreter']);
	});

	it('treats extra selectors alone as a restriction that still keeps configured tools', () => {
		expect(
			buildAllowedTools({
				extraSelectors: '@my-mcp/status',
				configuredToolNames: ['my-mcp', 'browser'],
			}),
		).toEqual(['@my-mcp/status', '@browser']);
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

	it('create: sends truncation and tags only when configured', () => {
		expect(withHarnessOptions(base, {}, 'create')).toEqual(base);
		expect(withHarnessOptions(base, { truncation, tags: { team: 'a' } }, 'create')).toEqual({
			...base,
			truncation,
			tags: { team: 'a' },
		});
	});

	it('update: sends truncation when set and never sends tags', () => {
		expect(withHarnessOptions(base, {}, 'update')).toEqual(base);
		expect(withHarnessOptions(base, { tags: { team: 'a' }, truncation }, 'update')).toEqual({
			...base,
			truncation,
		});
	});

	it('never sets allowedTools on the harness (it is per invocation)', () => {
		expect(withHarnessOptions(base, {}, 'update')).not.toHaveProperty('allowedTools');
		expect(withHarnessOptions(base, {}, 'create')).not.toHaveProperty('allowedTools');
	});

	it('does not mutate the input payload', () => {
		const input = { ...base };
		withHarnessOptions(input, { truncation }, 'create');
		expect(input).toEqual(base);
	});
});

describe('syncTags', () => {
	const arn = 'arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h1';
	const client = () => ({
		tagResource: vi.fn(() => Promise.resolve({})),
		untagResource: vi.fn(() => Promise.resolve({})),
	});

	it('makes no calls when nothing changed', async () => {
		const c = client();
		expect(await syncTags(c, arn, { team: 'a' }, { team: 'a' })).toEqual({ team: 'a' });
		expect(c.tagResource).not.toHaveBeenCalled();
		expect(c.untagResource).not.toHaveBeenCalled();
	});

	it('tags only new or changed keys and untags removed keys', async () => {
		const c = client();
		const result = await syncTags(c, arn, { team: 'a', old: 'x' }, { team: 'b', env: 'prod' });
		expect(c.tagResource).toHaveBeenCalledWith(arn, { team: 'b', env: 'prod' });
		expect(c.untagResource).toHaveBeenCalledWith(arn, ['old']);
		expect(result).toEqual({ team: 'b', env: 'prod' });
	});

	it('never removes tags when the previous state is unknown', async () => {
		// Harnesses recorded before tag sync, or adopted by name, may carry tags set
		// outside n8n; those must not be deleted.
		const c = client();
		await syncTags(c, arn, undefined, { team: 'a' });
		expect(c.tagResource).toHaveBeenCalledWith(arn, { team: 'a' });
		expect(c.untagResource).not.toHaveBeenCalled();

		const c2 = client();
		expect(await syncTags(c2, arn, undefined, undefined)).toEqual({});
		expect(c2.tagResource).not.toHaveBeenCalled();
		expect(c2.untagResource).not.toHaveBeenCalled();
	});

	it('removes every tag the node applied when the field is cleared', async () => {
		const c = client();
		await syncTags(c, arn, { team: 'a', env: 'prod' }, undefined);
		expect(c.untagResource).toHaveBeenCalledWith(arn, ['team', 'env']);
		expect(c.tagResource).not.toHaveBeenCalled();
	});
});

describe('buildHooks', () => {
	const LAMBDA = 'arn:aws:lambda:us-west-2:111122223333:function:policy';
	const TOPIC = 'arn:aws:sns:us-west-2:111122223333:events';
	const BUS = 'arn:aws:events:us-west-2:111122223333:event-bus/harness';
	const hooksOf = (...hook: Record<string, unknown>[]) => ({ hook });

	it('returns an empty list when no hooks are configured', () => {
		expect(buildHooks(undefined)).toEqual([]);
		expect(buildHooks({})).toEqual([]);
	});

	it('maps each event and target type to the API union', () => {
		expect(
			buildHooks(
				hooksOf(
					{
						event: 'before_invocation',
						name: 'gate',
						targetType: 'lambda',
						targetArn: LAMBDA,
						lambdaTimeoutSeconds: 5,
						failureMode: 'allow',
					},
					{ event: 'before_tool_call', name: 'policy', targetType: 'lambda', targetArn: LAMBDA },
					{ event: 'after_tool_call', name: 'notify', targetType: 'sns', targetArn: TOPIC },
					{ event: 'after_invocation', name: 'audit', targetType: 'eventBridge', targetArn: BUS },
				),
			),
		).toEqual([
			{
				beforeInvocation: {
					name: 'gate',
					target: { lambda: { arn: LAMBDA, timeoutSeconds: 5, failureMode: 'allow' } },
				},
			},
			{
				beforeToolCall: {
					name: 'policy',
					target: { lambda: { arn: LAMBDA, failureMode: 'deny' } },
				},
			},
			{ afterToolCall: { name: 'notify', target: { sns: { arn: TOPIC } } } },
			{ afterInvocation: { name: 'audit', target: { eventBridge: { arn: BUS } } } },
		]);
	});

	it('does not send Lambda-only settings for notification targets', () => {
		const [hook] = buildHooks(
			hooksOf({
				event: 'after_tool_call',
				name: 'n',
				targetType: 'sns',
				targetArn: TOPIC,
				lambdaTimeoutSeconds: 30,
				failureMode: 'allow',
			}),
		);
		expect(hook).toEqual({ afterToolCall: { name: 'n', target: { sns: { arn: TOPIC } } } });
	});

	it('rejects missing or duplicate names', () => {
		expect(() => buildHooks(hooksOf({ targetType: 'lambda', targetArn: LAMBDA }))).toThrow(
			/Name is required/,
		);
		expect(() =>
			buildHooks(
				hooksOf(
					{ name: 'dup', targetType: 'lambda', targetArn: LAMBDA },
					{ name: 'dup', targetType: 'sns', targetArn: TOPIC },
				),
			),
		).toThrow(/must be unique/);
	});

	it('rejects an ARN that does not match the target type', () => {
		expect(() =>
			buildHooks(hooksOf({ name: 'x', targetType: 'lambda', targetArn: TOPIC })),
		).toThrow(/not a valid lambda ARN/);
		expect(() =>
			buildHooks(hooksOf({ name: 'x', targetType: 'eventBridge', targetArn: LAMBDA })),
		).toThrow(/not a valid eventBridge ARN/);
	});

	it('enforces the documented Lambda timeout range and the 20-hook limit', () => {
		for (const bad of [0, 901, 2.5]) {
			expect(() =>
				buildHooks(
					hooksOf({
						name: 'x',
						targetType: 'lambda',
						targetArn: LAMBDA,
						lambdaTimeoutSeconds: bad,
					}),
				),
			).toThrow(/1 to 900 seconds/);
		}
		const many = Array.from({ length: 21 }, (_, i) => ({
			name: `h${i}`,
			targetType: 'sns',
			targetArn: TOPIC,
		}));
		expect(() => buildHooks({ hook: many })).toThrow(/at most 20/);
	});
});

describe('withHarnessOptions hooks', () => {
	const base = { systemPrompt: [{ text: 'x' }] };
	const hooks = [{ beforeToolCall: { name: 'p', target: { lambda: { arn: 'a' } } } }];

	it('sends configured hooks on create and update', () => {
		expect(withHarnessOptions(base, { hooks }, 'create').hooks).toEqual(hooks);
		expect(withHarnessOptions(base, { hooks }, 'update').hooks).toEqual(hooks);
	});

	it('clears hooks with [] only when the node set them before', () => {
		expect(withHarnessOptions(base, { hooks: [], managesHooks: true }, 'update').hooks).toEqual([]);
		// Hooks configured outside n8n are kept: the field is omitted.
		expect(withHarnessOptions(base, { hooks: [] }, 'update')).not.toHaveProperty('hooks');
		expect(
			withHarnessOptions(base, { hooks: [], managesHooks: true }, 'create'),
		).not.toHaveProperty('hooks');
	});
});
