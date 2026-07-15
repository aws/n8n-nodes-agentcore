/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import type { IDataObject } from 'n8n-workflow';
import { consumeStream, type InvokeResult } from './stream';
import { decodeEventStream } from './eventstream';

/**
 * OAuth / Bearer-token invoke path.
 *
 * When the user authenticates with an inbound-OAuth JWT instead of SigV4, we
 * make a raw HTTPS request to the data-plane endpoint with a Bearer token and
 * decode the AWS event-stream response with our inline decoder (see
 * `eventstream.ts`) — the same decoder the SigV4 path uses. Both paths funnel
 * the reconstructed events into `consumeStream`, so the output is identical.
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

	return consumeStream(decodeEventStream(response.body));
}
