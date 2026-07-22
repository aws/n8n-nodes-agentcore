/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * Decoder for the AWS `application/vnd.amazon.eventstream` binary framing that
 * InvokeHarness returns.
 *
 * We decode it inline instead of pulling in `@smithy/core/event-streams`,
 * because n8n's community-node scanner forbids third-party runtime
 * dependencies. The wire format is documented and stable:
 *
 *   [total length : 4B big-endian]
 *   [headers length: 4B big-endian]
 *   [prelude CRC32 : 4B]              // CRC of the first 8 bytes
 *   [headers        : headers-length bytes]
 *   [payload        : total - headers-length - 16 bytes]
 *   [message CRC32  : 4B]             // CRC of everything before it
 *
 * Each header is: [name-len:1B][name][value-type:1B][value...]. We only read
 * string-typed headers (type 7: [len:2B][utf8]), which is what the harness uses
 * for `:event-type`, `:message-type`, and `:exception-type`.
 *
 * Frames arrive split across network chunks, so we buffer bytes and emit a
 * frame only once its full `total length` is present.
 */
import type { IDataObject } from 'n8n-workflow';

const decoder = new TextDecoder('utf-8');

/** Standard IEEE 802.3 CRC-32 (same polynomial the event-stream format uses). */
const CRC_TABLE: number[] = (() => {
	const table: number[] = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
	let crc = 0xffffffff;
	for (let i = start; i < end; i++) {
		crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Consumes a Web ReadableStream of bytes and yields one decoded event object
 * per frame, shaped as `{ [memberName]: payloadJson }` — exactly what
 * `consumeStream` keys off (`event.contentBlockDelta`, `event.messageStop`,
 * exception envelopes, etc.). This matches the SDK's decoded event shape, so
 * the SigV4 and OAuth invoke paths share one accumulator.
 */
export async function* decodeEventStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<IDataObject, void, unknown> {
	const reader = body.getReader();
	let buffer: Uint8Array = new Uint8Array(0);

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.length === 0) continue;

			buffer = concat(buffer, value);

			// Emit every complete frame currently buffered.
			for (;;) {
				if (buffer.length < 12) break; // need at least the prelude
				const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
				const totalLength = view.getUint32(0, false);
				if (totalLength < 16 || totalLength > 16 * 1024 * 1024) {
					throw new Error(`event-stream: implausible frame length ${totalLength}`);
				}
				if (buffer.length < totalLength) break; // frame not fully arrived yet

				const frame = buffer.subarray(0, totalLength);
				const event = decodeFrame(frame);
				if (event) yield event;

				buffer = buffer.subarray(totalLength);
			}
		}

		// A well-formed stream ends on a frame boundary. Leftover bytes mean the
		// response was truncated mid-frame; surface that as an error rather than
		// letting the caller treat a partial response as a complete result.
		if (buffer.length > 0) {
			throw new Error(
				`event-stream: truncated response, ${buffer.length} trailing byte(s) after the last complete frame`,
			);
		}
	} finally {
		reader.releaseLock();
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

function decodeFrame(frame: Uint8Array): IDataObject | undefined {
	const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
	const totalLength = view.getUint32(0, false);
	const headersLength = view.getUint32(4, false);
	const preludeCrc = view.getUint32(8, false);

	// Integrity: prelude CRC covers the first 8 bytes; message CRC covers
	// everything before the trailing 4 bytes. Guards against frame desync.
	if (crc32(frame, 0, 8) !== preludeCrc) {
		throw new Error('event-stream: prelude CRC mismatch');
	}
	const messageCrc = view.getUint32(totalLength - 4, false);
	if (crc32(frame, 0, totalLength - 4) !== messageCrc) {
		throw new Error('event-stream: message CRC mismatch');
	}

	const headersStart = 12;
	const headersEnd = headersStart + headersLength;
	const headers = parseHeaders(frame, headersStart, headersEnd);

	const payloadBytes = frame.subarray(headersEnd, totalLength - 4);
	let payload: IDataObject = {};
	if (payloadBytes.length > 0) {
		try {
			payload = JSON.parse(decoder.decode(payloadBytes)) as IDataObject;
		} catch {
			payload = {};
		}
	}

	const messageType = headers[':message-type'];
	const eventType = headers[':event-type'];
	const exceptionType = headers[':exception-type'];
	const memberName = eventType ?? exceptionType;

	if (messageType === 'exception' || exceptionType) {
		return { [exceptionType ?? memberName ?? 'internalServerException']: payload };
	}
	if (!memberName) return undefined;
	return { [memberName]: payload };
}

/** Parses string-typed (type 7) headers; ignores other types we don't need. */
function parseHeaders(frame: Uint8Array, start: number, end: number): Record<string, string> {
	const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
	const headers: Record<string, string> = {};
	let offset = start;
	while (offset < end) {
		const nameLen = frame[offset];
		offset += 1;
		const name = decoder.decode(frame.subarray(offset, offset + nameLen));
		offset += nameLen;
		const valueType = frame[offset];
		offset += 1;
		if (valueType === 7) {
			// string: [len:2B][utf8]
			const valueLen = view.getUint16(offset, false);
			offset += 2;
			headers[name] = decoder.decode(frame.subarray(offset, offset + valueLen));
			offset += valueLen;
		} else {
			// Skip value types we don't consume, advancing by their known widths.
			offset += skipHeaderValue(view, frame, offset, valueType);
		}
	}
	return headers;
}

/** Returns the byte width of a non-string header value so we can skip it. */
function skipHeaderValue(
	view: DataView,
	frame: Uint8Array,
	offset: number,
	valueType: number,
): number {
	switch (valueType) {
		case 0: // true
		case 1: // false
			return 0;
		case 2: // byte
			return 1;
		case 3: // short
			return 2;
		case 4: // integer
			return 4;
		case 5: // long
			return 8;
		case 6: {
			// byte array: [len:2B][bytes]
			const len = view.getUint16(offset, false);
			return 2 + len;
		}
		case 8: // timestamp (long millis)
			return 8;
		case 9: // uuid
			return 16;
		default:
			throw new Error(`event-stream: unknown header value type ${valueType}`);
	}
}
