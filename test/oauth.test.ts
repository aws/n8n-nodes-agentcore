/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi } from 'vitest';
import { invokeWithBearer } from '../nodes/AgentCoreHarness/helpers/oauth';
import type { HttpRequestFn } from '../nodes/AgentCoreHarness/helpers/httpClient';

/**
 * The OAuth bearer invoke path goes through the same injected `httpRequest`
 * helper and the same event-stream decoder as the SigV4 path. These tests feed
 * canned event-stream frames through a mocked helper and assert that
 * `invokeWithBearer` sends the right request and returns the decoded result.
 *
 * We build real event-stream frames (with valid CRCs) so the decoder runs for
 * real, and we exercise BOTH stream shapes the helper's `encoding: 'stream'` can
 * hand back: a Web `ReadableStream` and a Node-style async-iterable.
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
	view.setUint32(totalLength - 4, crc32(frame, 0, totalLength - 4), false); // message CRC
	return frame;
}

function concatFrames(...frames: Uint8Array[]): Uint8Array {
	const total = frames.reduce((n, f) => n + f.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const f of frames) {
		out.set(f, offset);
		offset += f.length;
	}
	return out;
}

/** A canned agent turn: two text deltas, a messageStop, and usage metadata. */
function cannedTurnBytes(): Uint8Array {
	return concatFrames(
		buildFrame(
			{ ':message-type': 'event', ':event-type': 'contentBlockDelta' },
			{ contentBlockIndex: 0, delta: { text: 'Hello ' } },
		),
		buildFrame(
			{ ':message-type': 'event', ':event-type': 'contentBlockDelta' },
			{ contentBlockIndex: 0, delta: { text: 'world' } },
		),
		buildFrame({ ':message-type': 'event', ':event-type': 'messageStop' }, { stopReason: 'end_turn' }),
		buildFrame(
			{ ':message-type': 'event', ':event-type': 'metadata' },
			{ usage: { inputTokens: 10, outputTokens: 3 }, metrics: { latencyMs: 42 } },
		),
	);
}

function webStreamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	let sent = false;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!sent) {
				controller.enqueue(bytes);
				sent = true;
			} else {
				controller.close();
			}
		},
	});
}

/** A minimal Node-style async-iterable of Buffer chunks (what the helper yields). */
function nodeStreamOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			yield Buffer.from(bytes);
		},
	};
}

function mockHttp(
	impl: (options: any) => { body?: unknown; headers?: Record<string, unknown>; statusCode: number; statusMessage?: string },
): { httpRequest: HttpRequestFn; fn: ReturnType<typeof vi.fn> } {
	const fn = vi.fn((options: any) => Promise.resolve(impl(options)));
	return { httpRequest: fn as unknown as HttpRequestFn, fn };
}

const BASE_INPUT = {
	region: 'us-west-2',
	harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/agent-abc123',
	bearerToken: 'jwt-token-xyz',
	runtimeSessionId: 'session-0123456789012345678901234567890123',
	body: { messages: [{ role: 'user', content: [{ text: 'hi' }] }] },
};

describe('invokeWithBearer — request shape', () => {
	it('sends a Bearer Authorization header and streams to the invoke endpoint', async () => {
		let sent: any;
		const { httpRequest } = mockHttp((options) => {
			sent = options;
			return { body: webStreamOf(cannedTurnBytes()), statusCode: 200 };
		});

		await invokeWithBearer({ ...BASE_INPUT, httpRequest });

		expect(sent.method).toBe('POST');
		expect(sent.url).toContain('/harnesses/invoke');
		expect(sent.url).toContain(`harnessArn=${encodeURIComponent(BASE_INPUT.harnessArn)}`);
		expect(sent.headers.Authorization).toBe('Bearer jwt-token-xyz');
		expect(sent.headers.Accept).toBe('application/vnd.amazon.eventstream');
		expect(sent.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe(
			BASE_INPUT.runtimeSessionId,
		);
		// The request must ask for a raw stream so we can decode incrementally.
		expect(sent.encoding).toBe('stream');
		// No SigV4 Authorization on this path — auth is the bearer token only.
		expect(sent.headers.Authorization).not.toContain('AWS4-HMAC-SHA256');
	});

	it('adds the runtime user id header when provided, and the qualifier query param', async () => {
		let sent: any;
		const { httpRequest } = mockHttp((options) => {
			sent = options;
			return { body: webStreamOf(cannedTurnBytes()), statusCode: 200 };
		});

		await invokeWithBearer({
			...BASE_INPUT,
			qualifier: 'prod',
			runtimeUserId: 'user-42',
			httpRequest,
		});

		expect(sent.url).toContain('qualifier=prod');
		expect(sent.headers['X-Amzn-Bedrock-AgentCore-Runtime-User-Id']).toBe('user-42');
	});

	it('rejects before any request when the bearer token is empty', async () => {
		const { httpRequest, fn } = mockHttp(() => ({ body: '', statusCode: 200 }));
		await expect(
			invokeWithBearer({ ...BASE_INPUT, bearerToken: '   ', httpRequest }),
		).rejects.toThrow(/Bearer Token/i);
		expect(fn).not.toHaveBeenCalled();
	});
});

describe('invokeWithBearer — response decoding', () => {
	it('decodes a Web ReadableStream response into text, stop reason, and usage', async () => {
		const { httpRequest } = mockHttp(() => ({
			body: webStreamOf(cannedTurnBytes()),
			statusCode: 200,
		}));
		const result = await invokeWithBearer({ ...BASE_INPUT, httpRequest });
		expect(result.text).toBe('Hello world');
		expect(result.stopReason).toBe('end_turn');
		expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
		expect(result.latencyMs).toBe(42);
	});

	it('decodes a Node async-iterable response the same way (helper encoding:stream)', async () => {
		const { httpRequest } = mockHttp(() => ({
			body: nodeStreamOf(cannedTurnBytes()),
			statusCode: 200,
		}));
		const result = await invokeWithBearer({ ...BASE_INPUT, httpRequest });
		expect(result.text).toBe('Hello world');
		expect(result.stopReason).toBe('end_turn');
	});
});

describe('invokeWithBearer — error handling', () => {
	it('surfaces a non-2xx JSON error body (string) in the thrown message', async () => {
		const { httpRequest } = mockHttp(() => ({
			body: JSON.stringify({ message: 'token expired' }),
			statusCode: 403,
			statusMessage: 'Forbidden',
		}));
		await expect(invokeWithBearer({ ...BASE_INPUT, httpRequest })).rejects.toThrow(
			/HTTP 403.*token expired/s,
		);
	});

	it('surfaces a non-2xx error when the body is a stream', async () => {
		const errBytes = new TextEncoder().encode(JSON.stringify({ message: 'nope' }));
		const { httpRequest } = mockHttp(() => ({
			body: webStreamOf(errBytes),
			statusCode: 401,
			statusMessage: 'Unauthorized',
		}));
		await expect(invokeWithBearer({ ...BASE_INPUT, httpRequest })).rejects.toThrow(/HTTP 401.*nope/s);
	});
});
