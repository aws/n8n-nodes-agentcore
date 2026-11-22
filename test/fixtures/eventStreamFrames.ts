/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
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

export function buildFrame(headers: Record<string, string>, payloadObj: unknown): Uint8Array {
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

export function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) controller.enqueue(chunks[i++]);
			else controller.close();
		},
	});
}
