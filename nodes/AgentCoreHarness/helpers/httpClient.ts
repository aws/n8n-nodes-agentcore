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
import { randomUUID } from 'node:crypto';
import { sleep } from 'n8n-workflow';
import { signRequest, type SigV4Credentials } from './sigv4';

const SERVICE = 'bedrock-agentcore';

/**
 * Bounded retry policy for transient failures. The AWS SDK retried these for us;
 * since we call `fetch` directly we reproduce a small equivalent: retry on 429,
 * 500, 502, 503, 504, and network errors, with exponential backoff. Mutating
 * requests carry a `clientToken` so a retried write is idempotent server-side.
 */
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 200;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

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

	// Mutating requests get a stable clientToken so that a retried write is
	// idempotent server-side. The token is fixed once per logical request, not
	// regenerated per attempt.
	const mutating = req.method !== 'GET';
	const body =
		mutating && req.body !== undefined
			? { clientToken: newClientToken(), ...(req.body as Record<string, unknown>) }
			: req.body;
	const bodyString = body === undefined ? '' : JSON.stringify(body);

	const res = await sendWithRetry(config, {
		method: req.method,
		url,
		bodyString,
		// A GET has no side effects, so it is always safe to retry; a mutating
		// request is safe to retry only because of the clientToken above.
		retrySafe: true,
	});

	const text = await res.text();
	if (!res.ok) {
		throw new Error(formatAwsError(res.status, res.statusText, text, res.headers));
	}
	if (!text) return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		return {} as T;
	}
}

interface SignedSend {
	method: string;
	url: string;
	bodyString: string;
	retrySafe: boolean;
}

/**
 * Signs and sends a request, retrying transient failures (retryable HTTP status
 * codes and network errors) with exponential backoff. Each attempt is re-signed
 * because SigV4 binds the timestamp into the signature. Non-retryable responses
 * (including 4xx other than 429) are returned to the caller on the first try.
 */
async function sendWithRetry(config: AwsCallerConfig, send: SignedSend): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const headers = signRequest(
			{
				method: send.method,
				url: send.url,
				headers: { 'content-type': 'application/json' },
				body: send.bodyString,
			},
			{ region: config.region, service: SERVICE, credentials: config.credentials },
		);
		try {
			const res = await fetch(send.url, {
				method: send.method,
				headers,
				...(send.bodyString ? { body: send.bodyString } : {}),
			});
			if (!send.retrySafe || !RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
				return res;
			}
			// Retryable status: fall through to backoff.
			lastError = new Error(`HTTP ${res.status}`);
		} catch (err) {
			// Network-level failure (DNS, connection reset, etc.).
			lastError = err;
			if (!send.retrySafe || attempt === MAX_ATTEMPTS) throw err;
		}
		await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
	}
	// Unreachable in practice: the loop returns or throws before exhausting.
	throw lastError instanceof Error ? lastError : new Error('request failed after retries');
}

function newClientToken(): string {
	// randomUUID is from node:crypto (allowed by the n8n scanner).
	return randomUUID();
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
		throw new Error(formatAwsError(res.status, res.statusText, detail, res.headers));
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
 * Turns an AWS REST-JSON error response into a readable message. AWS REST-JSON
 * services carry the error type in one of several places depending on the
 * operation: the `x-amzn-errortype` response header, a body `code` field, or a
 * body `__type` field. We check all three so the type is preserved, since
 * callers branch on it (for example, the endpoint upsert path treats a
 * `ResourceNotFoundException` as "create it" rather than a hard failure). The
 * header form is common and was previously dropped, turning a missing resource
 * into a generic 404.
 */
function formatAwsError(
	status: number,
	statusText: string,
	bodyText: string,
	headers?: Headers,
): string {
	let type = '';
	let message = '';

	const headerType = headers?.get('x-amzn-errortype') ?? '';
	if (headerType) {
		// The header value can be `Type:` or `Type:http://internal...`; keep the name.
		type = headerType.split(':')[0].split('#').pop() ?? headerType;
	}

	try {
		const parsed = JSON.parse(bodyText) as {
			__type?: string;
			code?: string;
			message?: string;
			Message?: string;
		};
		if (!type && parsed.code) type = parsed.code.split('#').pop() ?? parsed.code;
		if (!type && parsed.__type) type = parsed.__type.split('#').pop() ?? parsed.__type;
		message = parsed.message ?? parsed.Message ?? '';
	} catch {
		message = bodyText;
	}

	const prefix = type ? `${type}: ` : `HTTP ${status} ${statusText}: `;
	return `${prefix}${message || bodyText || statusText}`.trim();
}
