/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { decodeEventStream } from '../nodes/AgentCoreHarness/helpers/eventstream';
import { buildFrame, streamOf } from './fixtures/eventStreamFrames';

async function collect(stream: ReadableStream<Uint8Array>): Promise<any[]> {
	const out: any[] = [];
	for await (const ev of decodeEventStream(stream)) out.push(ev);
	return out;
}

describe('eventstream — happy path', () => {
	it('decodes a text contentBlockDelta event', async () => {
		const frame = buildFrame(
			{ ':message-type': 'event', ':event-type': 'contentBlockDelta' },
			{ contentBlockIndex: 0, delta: { text: 'hello' } },
		);
		const events = await collect(streamOf(frame));
		expect(events).toHaveLength(1);
		expect(events[0].contentBlockDelta.delta.text).toBe('hello');
	});

	it('decodes multiple frames arriving in one chunk', async () => {
		const a = buildFrame(
			{ ':message-type': 'event', ':event-type': 'contentBlockDelta' },
			{ delta: { text: 'foo' } },
		);
		const b = buildFrame(
			{ ':message-type': 'event', ':event-type': 'messageStop' },
			{ stopReason: 'end_turn' },
		);
		const merged = new Uint8Array(a.length + b.length);
		merged.set(a, 0);
		merged.set(b, a.length);
		const events = await collect(streamOf(merged));
		expect(events).toHaveLength(2);
		expect(events[1].messageStop.stopReason).toBe('end_turn');
	});

	it('reassembles a frame split across chunk boundaries', async () => {
		const frame = buildFrame(
			{ ':message-type': 'event', ':event-type': 'contentBlockDelta' },
			{ delta: { text: 'split' } },
		);
		const mid = Math.floor(frame.length / 2);
		const events = await collect(streamOf(frame.subarray(0, mid), frame.subarray(mid)));
		expect(events).toHaveLength(1);
		expect(events[0].contentBlockDelta.delta.text).toBe('split');
	});

	it('shapes an exception frame into a named-member envelope', async () => {
		const frame = buildFrame(
			{ ':message-type': 'exception', ':exception-type': 'validationException' },
			{ message: 'bad input' },
		);
		const events = await collect(streamOf(frame));
		expect(events[0].validationException.message).toBe('bad input');
	});
});

describe('eventstream — malformed input is rejected safely (T-N8N-017)', () => {
	it('throws on a corrupted prelude CRC', async () => {
		const frame = buildFrame({ ':message-type': 'event', ':event-type': 'x' }, { a: 1 });
		frame[8] ^= 0xff; // corrupt prelude CRC
		await expect(collect(streamOf(frame))).rejects.toThrow(/prelude CRC/i);
	});

	it('throws on a corrupted message CRC / tampered payload', async () => {
		const frame = buildFrame({ ':message-type': 'event', ':event-type': 'x' }, { a: 1 });
		frame[frame.length - 6] ^= 0xff; // flip a payload byte, message CRC no longer matches
		await expect(collect(streamOf(frame))).rejects.toThrow(/message CRC/i);
	});

	it('throws on an implausible frame length (over the 16 MiB cap)', async () => {
		const bad = new Uint8Array(12);
		new DataView(bad.buffer).setUint32(0, 64 * 1024 * 1024, false); // 64 MiB declared length
		await expect(collect(streamOf(bad))).rejects.toThrow(/implausible frame length/i);
	});

	it('does not emit an event for an unrecognized frame with no member name', async () => {
		const frame = buildFrame({ ':message-type': 'event' }, { a: 1 }); // no :event-type
		const events = await collect(streamOf(frame));
		expect(events).toHaveLength(0);
	});

	it('throws on a truncated response (bytes left buffered at EOF)', async () => {
		// One full frame followed by a partial second frame: the stream ends mid-frame.
		const full = buildFrame(
			{ ':message-type': 'event', ':event-type': 'contentBlockDelta' },
			{ delta: { text: 'ok' } },
		);
		const partial = buildFrame(
			{ ':message-type': 'event', ':event-type': 'messageStop' },
			{ stopReason: 'end_turn' },
		).subarray(0, 20); // cut the second frame short
		const merged = new Uint8Array(full.length + partial.length);
		merged.set(full, 0);
		merged.set(partial, full.length);
		await expect(collect(streamOf(merged))).rejects.toThrow(/truncated response/i);
	});
});
