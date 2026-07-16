/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { consumeStream } from '../nodes/AgentCoreHarness/helpers/stream';

async function* gen(events: any[]) {
	for (const e of events) yield e;
}

describe('consumeStream', () => {
	it('accumulates text deltas into the final response', async () => {
		const result = await consumeStream(
			gen([
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: ', world' } } },
				{ messageStop: { stopReason: 'end_turn' } },
			]),
		);
		expect(result.text).toBe('Hello, world');
		expect(result.stopReason).toBe('end_turn');
	});

	it('captures usage and latency metadata', async () => {
		const result = await consumeStream(
			gen([{ metadata: { usage: { inputTokens: 100, outputTokens: 20 }, metrics: { latencyMs: 1234 } } }]),
		);
		expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
		expect(result.latencyMs).toBe(1234);
	});

	it('reconstructs a tool use with streamed JSON input fragments', async () => {
		const result = await consumeStream(
			gen([
				{ contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { name: 'calc', toolUseId: 'tu_1' } } } },
				{ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"a":' } } } },
				{ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '5}' } } } },
				{ contentBlockStop: { contentBlockIndex: 1 } },
				{ messageStop: { stopReason: 'tool_use' } },
			]),
		);
		expect(result.toolUses).toHaveLength(1);
		expect(result.toolUses[0]).toMatchObject({ name: 'calc', toolUseId: 'tu_1', input: { a: 5 } });
	});

	it('throws on a validation exception event', async () => {
		await expect(
			consumeStream(gen([{ validationException: { message: 'bad model id' } }])),
		).rejects.toThrow(/validation error/i);
	});

	it('throws on a throttling exception event', async () => {
		await expect(consumeStream(gen([{ throttlingException: {} }]))).rejects.toThrow(/throttl/i);
	});
});
