/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * SDK-free HTTP client for the AgentCore control and data planes.
 *
 * n8n's verified-community-node scanner forbids third-party runtime
 * dependencies, so we cannot ship `@aws-sdk/*`. This module replaces the two
 * SDK clients with `fetch` + SigV4 signing (see `sigv4.ts`) and inline
 * event-stream decoding (see `eventstream.ts`). Only `node:crypto` (allowed by
 * the scanner) and the global `fetch` are used.
 *
 * The control plane speaks REST-JSON; helpers here return parsed JSON. The data
 * plane's InvokeHarness returns a binary event stream; `invokeHarnessStream`
 * returns the raw ReadableStream for the caller to decode.
 */
import { signRequest, type SigV4Credentials } from './sigv4';

const SERVICE = 'bedrock-agentcore';

export interface AwsCallerConfig {
	region: string;
	credentials: SigV4Credentials;
}

function controlHost(region: string): string {
	return `bedrock-agentcore-control.${region}.amazonaws.com`;
}

function dataHost(region: string): string {
	return `bedrock-agentcore.${region}.amazonaws.com`;
}

export interface ControlRequest {
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	/** Path with any labels already substituted, e.g. `/harnesses/abc123`. */
	path: string;
	/** Optional query params. Undefined/empty values are dropped. */
	query?: Record<string, string | number | undefined>;
	/** Optional request body object (serialized to JSON). */
	body?: unknown;
}

/**
 * Signs and sends a control-plane request, returning the parsed JSON response.
 * Throws a readable error on non-2xx, surfacing the AWS error type/message the
 * same way the SDK would (so existing error handling and the credential test
 * keep working).
 */
export async function controlRequest<T = any>(
	config: AwsCallerConfig,
	req: ControlRequest,
): Promise<T> {
	const host = controlHost(config.region);
	const search = buildQuery(req.query);
	const url = `https://${host}${req.path}${search}`;
	const bodyString = req.body === undefined ? '' : JSON.stringify(req.body);

	const headers = signRequest(
		{
			method: req.method,
			url,
			headers: { 'content-type': 'application/json' },
			body: bodyString,
		},
		{ region: config.region, service: SERVICE, credentials: config.credentials },
	);

	const res = await fetch(url, {
		method: req.method,
		headers,
		...(bodyString ? { body: bodyString } : {}),
	});

	const text = await res.text();
	if (!res.ok) {
		throw new Error(formatAwsError(res.status, res.statusText, text));
	}
	if (!text) return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		return {} as T;
	}
}

export interface InvokeStreamInput {
	harnessArn: string;
	runtimeSessionId: string;
	qualifier?: string;
	runtimeUserId?: string;
	/** The invoke body (messages, model, tools, …) minus path/header params. */
	body: Record<string, unknown>;
}

/**
 * Signs and sends InvokeHarness, returning the raw response stream for the
 * caller to decode with `decodeEventStream`. SigV4-signs the request the same
 * way the SDK does; the OAuth/Bearer path lives separately in `oauth.ts`.
 */
export async function invokeHarnessStream(
	config: AwsCallerConfig,
	input: InvokeStreamInput,
): Promise<ReadableStream<Uint8Array>> {
	const host = dataHost(config.region);
	const query: Record<string, string> = { harnessArn: input.harnessArn };
	if (input.qualifier) query.qualifier = input.qualifier;
	const url = `https://${host}/harnesses/invoke${buildQuery(query)}`;
	const bodyString = JSON.stringify(input.body);

	const baseHeaders: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/vnd.amazon.eventstream',
		'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': input.runtimeSessionId,
	};
	if (input.runtimeUserId) {
		baseHeaders['X-Amzn-Bedrock-AgentCore-Runtime-User-Id'] = input.runtimeUserId;
	}

	const headers = signRequest(
		{ method: 'POST', url, headers: baseHeaders, body: bodyString },
		{ region: config.region, service: SERVICE, credentials: config.credentials },
	);

	const res = await fetch(url, { method: 'POST', headers, body: bodyString });
	if (!res.ok || !res.body) {
		let detail = '';
		try {
			detail = await res.text();
		} catch {
			/* ignore */
		}
		throw new Error(formatAwsError(res.status, res.statusText, detail));
	}
	return res.body;
}

function buildQuery(query?: Record<string, string | number | undefined>): string {
	if (!query) return '';
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(query)) {
		if (v !== undefined && v !== '') params.set(k, String(v));
	}
	const s = params.toString();
	return s ? `?${s}` : '';
}

/**
 * Turns an AWS REST-JSON error response into a readable message. AWS returns
 * the error type in the `__type` field or an `x-amzn-errortype`-style body;
 * we surface both the type and message when present.
 */
function formatAwsError(status: number, statusText: string, bodyText: string): string {
	let type = '';
	let message = '';
	try {
		const parsed = JSON.parse(bodyText) as { __type?: string; message?: string; Message?: string };
		if (parsed.__type) type = parsed.__type.split('#').pop() ?? parsed.__type;
		message = parsed.message ?? parsed.Message ?? '';
	} catch {
		message = bodyText;
	}
	const prefix = type ? `${type}: ` : `HTTP ${status} ${statusText}: `;
	return `${prefix}${message || bodyText || statusText}`.trim();
}
