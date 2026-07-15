/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * Minimal AWS Signature Version 4 signer.
 *
 * n8n's community-node scanner forbids third-party runtime dependencies and
 * bans most Node built-ins, but explicitly allows `node:crypto`. SigV4 needs
 * only HMAC-SHA256 and SHA-256, both of which `node:crypto` provides, so we
 * sign requests here instead of pulling in the AWS SDK or `@smithy/*`.
 *
 * This implements the AWS SigV4 algorithm for the `Authorization` header flow:
 *   https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 *
 * Scope is deliberately narrow: JSON/REST requests to a single region and
 * service, optional session token, no chunked/streaming request bodies
 * (AgentCore request bodies are small JSON documents; only the *response* is
 * streamed, which SigV4 does not cover). Query-string presigning is not needed.
 */
import { createHash, createHmac } from 'node:crypto';

export interface SigV4Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export interface SigV4Request {
	method: string;
	/** Full request URL, including query string. */
	url: string;
	/** Request headers. `host` is added automatically from the URL. */
	headers: Record<string, string>;
	/** Raw request body as sent on the wire (already-serialized JSON, or empty). */
	body?: string;
}

export interface SigV4Options {
	region: string;
	/** SigV4 signing service name, e.g. `bedrock-agentcore`. */
	service: string;
	credentials: SigV4Credentials;
	/**
	 * Signing timestamp as an ISO basic-format string `YYYYMMDDTHHMMSSZ`.
	 * Injected for testability; callers normally omit it and the current time
	 * is used.
	 */
	overrideAmzDate?: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

function sha256Hex(data: string): string {
	return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `2026-07-14T12:34:56.000Z` -> `20260714T123456Z`. */
function toAmzDate(iso: string): string {
	return iso.replace(/[:-]|\.\d{3}/g, '');
}

/**
 * RFC 3986 encoding for a single URI path segment or query component. AWS
 * requires each path segment to be encoded but the `/` separators preserved,
 * and `encodeURIComponent` leaves `!*'()` unescaped, so we fix those up.
 */
function uriEncode(input: string): string {
	return encodeURIComponent(input).replace(
		/[!*'()]/g,
		(c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
	);
}

/** Encode a path, preserving `/` between already-split segments. */
function encodePath(pathname: string): string {
	if (pathname === '' || pathname === '/') return '/';
	return pathname
		.split('/')
		.map((seg) => uriEncode(seg))
		.join('/');
}

/**
 * Build the canonical query string: params sorted by key, each key and value
 * URI-encoded, joined with `&`.
 */
function canonicalQuery(searchParams: URLSearchParams): string {
	const pairs: Array<[string, string]> = [];
	for (const [k, v] of searchParams.entries()) {
		pairs.push([uriEncode(k), uriEncode(v)]);
	}
	pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
	return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Signs `request` with SigV4 and returns the headers to send (the original
 * headers plus `Authorization`, `X-Amz-Date`, `x-amz-content-sha256`, and
 * `X-Amz-Security-Token` when a session token is present).
 */
export function signRequest(request: SigV4Request, options: SigV4Options): Record<string, string> {
	const url = new URL(request.url);
	const amzDate = options.overrideAmzDate ?? toAmzDate(new Date().toISOString());
	const dateStamp = amzDate.slice(0, 8); // YYYYMMDD
	const body = request.body ?? '';
	const payloadHash = sha256Hex(body);

	// Assemble the headers we sign. Header names are lower-cased for signing.
	const headersToSign: Record<string, string> = {};
	for (const [k, v] of Object.entries(request.headers)) {
		headersToSign[k.toLowerCase()] = String(v).trim();
	}
	headersToSign['host'] = url.host;
	headersToSign['x-amz-date'] = amzDate;
	headersToSign['x-amz-content-sha256'] = payloadHash;
	if (options.credentials.sessionToken) {
		headersToSign['x-amz-security-token'] = options.credentials.sessionToken;
	}

	const sortedHeaderNames = Object.keys(headersToSign).sort();
	const canonicalHeaders = sortedHeaderNames.map((n) => `${n}:${headersToSign[n]}\n`).join('');
	const signedHeaders = sortedHeaderNames.join(';');

	const canonicalRequest = [
		request.method.toUpperCase(),
		encodePath(url.pathname),
		canonicalQuery(url.searchParams),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join('\n');

	const credentialScope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
	const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join(
		'\n',
	);

	// Derive the signing key.
	const kDate = hmac(`AWS4${options.credentials.secretAccessKey}`, dateStamp);
	const kRegion = hmac(kDate, options.region);
	const kService = hmac(kRegion, options.service);
	const kSigning = hmac(kService, 'aws4_request');
	const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

	const authorization =
		`${ALGORITHM} Credential=${options.credentials.accessKeyId}/${credentialScope}, ` +
		`SignedHeaders=${signedHeaders}, Signature=${signature}`;

	// Return the wire headers: caller's originals plus the signing headers.
	const outHeaders: Record<string, string> = { ...request.headers };
	outHeaders['X-Amz-Date'] = amzDate;
	outHeaders['x-amz-content-sha256'] = payloadHash;
	outHeaders['Authorization'] = authorization;
	if (options.credentials.sessionToken) {
		outHeaders['X-Amz-Security-Token'] = options.credentials.sessionToken;
	}
	return outHeaders;
}
