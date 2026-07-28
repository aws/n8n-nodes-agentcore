/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * SDK-free HTTP client for the AgentCore control and data planes.
 *
 * n8n's verified-community-node scanner forbids third-party runtime
 * dependencies, so we cannot ship `@aws-sdk/*`. This module replaces the two
 * SDK clients with SigV4 signing (see `sigv4.ts`) + inline event-stream
 * decoding (see `eventstream.ts`).
 *
 * The request is put on the wire with n8n's own `this.helpers.httpRequest`
 * (injected as `config.httpRequest`) rather than the global `fetch`, so egress
 * goes through n8n's HTTP layer (proxy, logging, and audit support). We still
 * compute the SigV4 signature ourselves and hand the signed headers to the
 * helper; the signer is unchanged. Only `node:crypto` (allowed by the scanner)
 * is used for signing.
 *
 * The control plane speaks REST-JSON; helpers here return parsed JSON. The data
 * plane's InvokeHarness returns a binary event stream; `invokeHarnessStream`
 * returns the raw stream for the caller to decode.
 */
import { randomUUID } from 'node:crypto';
import { sleep, type IHttpRequestOptions } from 'n8n-workflow';
import { signRequest, type SigV4Credentials } from './sigv4';
import type { ByteStream } from './eventstream';

const SERVICE = 'bedrock-agentcore';

/**
 * n8n's `this.helpers.httpRequest`, injected so this SDK-free module never
 * touches the global `fetch`. We always call it with `returnFullResponse` so we
 * can read the status code and headers, and `ignoreHttpStatusErrors` so a non-2xx
 * response is returned (not thrown) and we can surface the AWS error ourselves.
 */
export type HttpRequestFn = (options: IHttpRequestOptions) => Promise<HttpFullResponse>;

interface HttpFullResponse {
	body: unknown;
	headers?: Record<string, unknown>;
	statusCode: number;
	statusMessage?: string;
}

/**
 * Bounded retry policy for transient failures. The AWS SDK retried these for us;
 * since we call the HTTP helper directly we reproduce a small equivalent: retry
 * on 429, 500, 502, 503, 504, and network errors, with exponential backoff.
 * Mutating requests carry a `clientToken` so a retried write is idempotent
 * server-side.
 */
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 200;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface AwsCallerConfig {
	region: string;
	credentials: SigV4Credentials;
	/** n8n's HTTP helper. Bound from `this.helpers.httpRequest` in the node. */
	httpRequest: HttpRequestFn;
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

	if (!isOk(res.statusCode)) {
		throw new Error(formatAwsError(res.statusCode, res.statusMessage ?? '', res.body, res.headers));
	}
	return parseJsonBody<T>(res.body);
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
async function sendWithRetry(config: AwsCallerConfig, send: SignedSend): Promise<HttpFullResponse> {
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
		let networkError: unknown;
		try {
			const res = await config.httpRequest(
				buildRequestOptions(send.method, send.url, headers, send.bodyString),
			);
			if (!send.retrySafe || !RETRYABLE_STATUS.has(res.statusCode) || attempt === MAX_ATTEMPTS) {
				return res;
			}
			// Retryable status: fall through to backoff.
			lastError = new Error(`HTTP ${res.statusCode}`);
		} catch (err) {
			// Network-level failure (DNS, connection reset, etc.). Record it and
			// decide outside the catch whether to give up or retry.
			networkError = err;
			lastError = err;
		}
		if (networkError !== undefined && (!send.retrySafe || attempt === MAX_ATTEMPTS)) {
			throw networkError;
		}
		await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
	}
	// Unreachable in practice: the loop returns or throws before exhausting.
	throw lastError instanceof Error ? lastError : new Error('request failed after retries');
}

/**
 * Builds the `httpRequest` options for a signed request. The body is passed as
 * the exact pre-serialized string the signature was computed over — never an
 * object — so the HTTP layer cannot re-serialize it and invalidate the SigV4
 * payload hash. `json: false` keeps the response body raw for us to parse.
 */
function buildRequestOptions(
	method: string,
	url: string,
	headers: Record<string, string>,
	bodyString: string,
): IHttpRequestOptions {
	const options: IHttpRequestOptions = {
		method: method as IHttpRequestOptions['method'],
		url,
		headers,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		json: false,
	};
	if (bodyString) options.body = bodyString;
	return options;
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
): Promise<ByteStream> {
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

	const res = await config.httpRequest({
		method: 'POST',
		url,
		headers,
		body: bodyString,
		encoding: 'stream',
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		json: false,
	});

	if (!isOk(res.statusCode)) {
		// The error body is JSON, not an event stream; drain it for the message.
		const detail = await collectStreamText(res.body);
		throw new Error(formatAwsError(res.statusCode, res.statusMessage ?? '', detail, res.headers));
	}
	return res.body as ByteStream;
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

function isOk(status: number): boolean {
	return status >= 200 && status < 300;
}

/**
 * Parses a control-plane response body. n8n's HTTP helper may hand us either the
 * raw JSON text (when `json: false`) or an already-parsed object (some versions
 * parse regardless); handle both, and treat an empty body as `{}`.
 */
function parseJsonBody<T>(body: unknown): T {
	if (body === undefined || body === null || body === '') return {} as T;
	if (typeof body === 'object') return body as T;
	if (typeof body === 'string') {
		try {
			return JSON.parse(body) as T;
		} catch {
			return {} as T;
		}
	}
	return {} as T;
}

/**
 * Drains a response body to a string. Handles the shapes n8n's HTTP helper can
 * return for an errored `encoding: 'stream'` request: a Node `Readable`, a Web
 * `ReadableStream`, an already-buffered string, or a parsed object.
 */
async function collectStreamText(body: unknown): Promise<string> {
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

	// Already-parsed object.
	try {
		return JSON.stringify(body);
	} catch {
		return '';
	}
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
	body: unknown,
	headers?: Record<string, unknown>,
): string {
	let type = '';
	let message = '';

	const headerType = String(headers?.['x-amzn-errortype'] ?? '');
	if (headerType) {
		// The header value can be `Type:` or `Type:http://internal...`; keep the name.
		type = headerType.split(':')[0].split('#').pop() ?? headerType;
	}

	// The body may be raw JSON text or an already-parsed object.
	let parsed: { __type?: string; code?: string; message?: string; Message?: string } | undefined;
	let bodyText = '';
	if (typeof body === 'string') {
		bodyText = body;
		try {
			parsed = JSON.parse(body);
		} catch {
			parsed = undefined;
		}
	} else if (body && typeof body === 'object') {
		parsed = body as typeof parsed;
		try {
			bodyText = JSON.stringify(body);
		} catch {
			bodyText = '';
		}
	}

	if (parsed) {
		if (!type && parsed.code) type = parsed.code.split('#').pop() ?? parsed.code;
		if (!type && parsed.__type) type = parsed.__type.split('#').pop() ?? parsed.__type;
		message = parsed.message ?? parsed.Message ?? '';
	} else {
		message = bodyText;
	}

	const prefix = type ? `${type}: ` : `HTTP ${status} ${statusText}: `;
	return `${prefix}${message || bodyText || statusText}`.trim();
}
