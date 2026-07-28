/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import type { IDataObject } from 'n8n-workflow';
import { consumeStream, type InvokeResult } from './stream';
import { decodeEventStream, type ByteStream } from './eventstream';
import type { HttpRequestFn } from './httpClient';

/**
 * OAuth / Bearer-token invoke path.
 *
 * When the user authenticates with an inbound-OAuth JWT instead of SigV4, we
 * call the data-plane endpoint with a Bearer token and decode the AWS
 * event-stream response with our inline decoder (see `eventstream.ts`) — the
 * same decoder the SigV4 path uses. The request goes through n8n's
 * `this.helpers.httpRequest` (injected as `httpRequest`) rather than the global
 * `fetch`, so egress uses n8n's HTTP layer. Both paths funnel the reconstructed
 * events into `consumeStream`, so the output is identical.
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
	/** n8n's HTTP helper, bound from `this.helpers.httpRequest`. */
	httpRequest: HttpRequestFn;
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

	const response = await input.httpRequest({
		method: 'POST',
		url,
		headers,
		body: JSON.stringify(input.body),
		encoding: 'stream',
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		json: false,
	});

	if (response.statusCode < 200 || response.statusCode >= 300) {
		// Surface the service error body to the user (it is JSON, not an event stream).
		const detail = await drainToText(response.body);
		throw new Error(
			`OAuth InvokeHarness failed with HTTP ${response.statusCode} ${response.statusMessage ?? ''}`.trim() +
				(detail ? `: ${detail}` : ''),
		);
	}

	return consumeStream(decodeEventStream(response.body as ByteStream));
}

/** Drains an error response body (stream, string, or object) to a string. */
async function drainToText(body: unknown): Promise<string> {
	if (body === undefined || body === null) return '';
	if (typeof body === 'string') return body;

	const asWeb = body as ReadableStream<Uint8Array>;
	if (typeof asWeb.getReader === 'function') {
		const reader = asWeb.getReader();
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		return Buffer.concat(chunks).toString('utf8');
	}

	if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
		const chunks: Buffer[] = [];
		for await (const chunk of body as AsyncIterable<Uint8Array>) {
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks).toString('utf8');
	}

	try {
		return JSON.stringify(body);
	} catch {
		return '';
	}
}
