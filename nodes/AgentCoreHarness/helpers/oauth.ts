/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { IDataObject } from 'n8n-workflow';
import { consumeStream, type InvokeResult } from './stream';

/**
 * OAuth / Bearer-token invoke path.
 *
 * The AWS JS SDK cannot attach a Bearer token to InvokeHarness — it always
 * SigV4-signs. So when the user authenticates with an inbound-OAuth JWT we make
 * a raw HTTPS request to the data-plane endpoint and decode the AWS event-stream
 * response ourselves.
 *
 * The binary framing is decoded with `EventStreamCodec` from
 * `@smithy/core/event-streams` — the codec is a transitive dependency of
 * `@aws-sdk/client-bedrock-agentcore`, so no new production dependency is added.
 * (TODO(v0.2-question-7): the prompt referenced `@smithy/eventstream-codec`,
 * which is not installed; the real module is `@smithy/core/event-streams`.)
 *
 * Each decoded frame carries smithy event-stream headers; the payload JSON
 * matches the SDK's stream event types, so we hand the reconstructed events to
 * the same `consumeStream` accumulator used by the SigV4 path.
 */

export interface OAuthInvokeInput {
	region: string;
	harnessArn: string;
	bearerToken: string;
	runtimeSessionId: string;
	/** Optional endpoint name (maps to the ?qualifier= query param). */
	qualifier?: string;
	/** Optional end-user id (X-Amzn-Bedrock-AgentCore-Runtime-User-Id header). */
	runtimeUserId?: string;
	/** The same JSON body the SDK would send (messages, model, tools, …), minus path/header params. */
	body: IDataObject;
}

export async function invokeWithBearer(input: OAuthInvokeInput): Promise<InvokeResult> {
	const token = (input.bearerToken || '').trim();
	if (!token) {
		throw new Error('OAuth Bearer authentication selected but no Bearer Token was provided.');
	}

	const host = `bedrock-agentcore.${input.region}.amazonaws.com`;
	const params = new URLSearchParams({ harnessArn: input.harnessArn });
	if (input.qualifier) params.set('qualifier', input.qualifier);
	const url = `https://${host}/harnesses/invoke?${params.toString()}`;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json',
		Accept: 'application/vnd.amazon.eventstream',
		'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': input.runtimeSessionId,
	};
	if (input.runtimeUserId) {
		headers['X-Amzn-Bedrock-AgentCore-Runtime-User-Id'] = input.runtimeUserId;
	}

	const response = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(input.body),
	});

	if (!response.ok || !response.body) {
		// Surface the service error body to the user (it is JSON, not an event stream).
		let detail = '';
		try {
			detail = await response.text();
		} catch {
			/* ignore */
		}
		throw new Error(
			`OAuth InvokeHarness failed with HTTP ${response.status} ${response.statusText}` +
				(detail ? `: ${detail}` : ''),
		);
	}

	const events = decodeEventStream(response.body);
	return consumeStream(events);
}

/**
 * Decodes a binary AWS event-stream (Web ReadableStream of Uint8Array) into an
 * async iterable of the SDK-shaped event objects that `consumeStream` expects.
 *
 * Smithy frames put the member name (e.g. "contentBlockDelta") in the
 * `:event-type` header and the payload JSON in the body. Exception frames use
 * `:message-type: exception` with `:exception-type` naming the member. We
 * rebuild `{ [memberName]: payload }` so the downstream accumulator — which
 * keys off `event.contentBlockDelta`, `event.messageStop`, etc. — works
 * unchanged for both the SigV4 and OAuth paths.
 */
async function* decodeEventStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<IDataObject, void, unknown> {
	const { EventStreamCodec } = await import('@smithy/core/event-streams');
	const { fromUtf8, toUtf8 } = await import('@smithy/util-utf8');
	const codec = new EventStreamCodec(toUtf8, fromUtf8);

	const reader = body.getReader();
	try {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.length === 0) continue;

			codec.feed(value);
			let available = codec.getAvailableMessages();
			for (const message of available.getMessages()) {
				const event = frameToEvent(message, toUtf8);
				if (event) yield event;
			}
		}
		codec.endOfStream();
		const tail = codec.getAvailableMessages();
		for (const message of tail.getMessages()) {
			const event = frameToEvent(message, toUtf8);
			if (event) yield event;
		}
	} finally {
		reader.releaseLock();
	}
}

function frameToEvent(
	message: { headers: Record<string, { value: unknown }>; body: Uint8Array },
	toUtf8: (input: Uint8Array) => string,
): IDataObject | undefined {
	const headerValue = (name: string): string | undefined => {
		const h = message.headers[name];
		return h && typeof h.value === 'string' ? (h.value as string) : undefined;
	};

	const messageType = headerValue(':message-type');
	const eventType = headerValue(':event-type');
	const exceptionType = headerValue(':exception-type');
	const memberName = eventType ?? exceptionType;

	let payload: IDataObject = {};
	if (message.body && message.body.length > 0) {
		try {
			payload = JSON.parse(toUtf8(message.body)) as IDataObject;
		} catch {
			payload = {};
		}
	}

	if (messageType === 'exception' || exceptionType) {
		// Reshape into the same envelope consumeStream recognizes.
		const name = memberName ?? 'internalServerException';
		return { [name]: payload };
	}

	if (!memberName) return undefined;
	return { [memberName]: payload };
}
