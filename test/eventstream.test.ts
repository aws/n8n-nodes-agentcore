/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { decodeEventStream } from '../nodes/AgentCoreHarness/helpers/eventstream';

/**
 * Builds a valid AWS event-stream frame with the given string headers and JSON
 * payload, computing the two CRC-32 checksums the format requires. Mirrors the
 * wire format the decoder parses, so we can feed it known-good and known-bad
 * bytes.
 */
const CRC_TABLE: number[] = (() => {
	const t: number[] = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(bytes: Uint8Array, start: number, end: number): number {
	let crc = 0xffffffff;
	for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function buildFrame(headers: Record<string, string>, payloadObj: unknown): Uint8Array {
	const enc = new TextEncoder();
	// Encode headers: [name-len:1][name][type:1=7][value-len:2][value]
	const headerChunks: number[] = [];
	for (const [name, value] of Object.entries(headers)) {
		const nameBytes = enc.encode(name);
		const valBytes = enc.encode(value);
		headerChunks.push(nameBytes.length);
		headerChunks.push(...nameBytes);
		headerChunks.push(7); // string type
		headerChunks.push((valBytes.length >> 8) & 0xff, valBytes.length & 0xff);
		headerChunks.push(...valBytes);
	}
	const headerBytes = Uint8Array.from(headerChunks);
	const payloadBytes = enc.encode(payloadObj === undefined ? '' : JSON.stringify(payloadObj));

	const totalLength = 4 + 4 + 4 + headerBytes.length + payloadBytes.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerBytes.length, false);
	view.setUint32(8, crc32(frame, 0, 8), false); // prelude CRC
	frame.set(headerBytes, 12);
	frame.set(payloadBytes, 12 + headerBytes.length);
	const msgCrc = crc32(frame, 0, totalLength - 4);
	view.setUint32(totalLength - 4, msgCrc, false);
	return frame;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) controller.enqueue(chunks[i++]);
			else controller.close();
		},
	});
}

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
		const b = buildFrame({ ':message-type': 'event', ':event-type': 'messageStop' }, { stopReason: 'end_turn' });
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
});
