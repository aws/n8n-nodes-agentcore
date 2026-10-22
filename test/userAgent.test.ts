/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi } from 'vitest';
import { USER_AGENT, withUserAgent } from '../nodes/AgentCoreHarness/helpers/userAgent';
import {
	controlRequest,
	invokeHarnessStream,
	type AwsCallerConfig,
	type HttpRequestFn,
} from '../nodes/AgentCoreHarness/helpers/httpClient';
import { invokeWithBearer } from '../nodes/AgentCoreHarness/helpers/oauth';

/**
 * The node identifies itself on every AgentCore request so that harness usage
 * originating in n8n can be told apart from usage by the AWS SDK, the CLI, or
 * the console. These tests pin three things that are easy to regress:
 *
 *  1. both headers are present on all three request paths (control plane,
 *     SigV4 invoke, and Bearer invoke),
 *  2. the token is a fixed string carrying no workflow or user data, and
 *  3. `user-agent` is NOT part of the SigV4 signed header set, matching the AWS
 *     SDK, which lists it in `ALWAYS_UNSIGNABLE_HEADERS`.
 */

function mockHttp(impl: (options: any) => any): {
	httpRequest: HttpRequestFn;
	sent: () => any;
} {
	let lastOptions: any;
	const fn = vi.fn((options: any) => {
		lastOptions = options;
		return Promise.resolve(impl(options));
	});
	return { httpRequest: fn as unknown as HttpRequestFn, sent: () => lastOptions };
}

function configWith(httpRequest: HttpRequestFn): AwsCallerConfig {
	return {
		region: 'us-west-2',
		credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
		httpRequest,
	};
}

/** Pulls the `SignedHeaders=` list out of a SigV4 Authorization header. */
function signedHeaders(authorization: string): string[] {
	const match = /SignedHeaders=([^,]+)/.exec(authorization);
	if (!match) throw new Error(`no SignedHeaders in: ${authorization}`);
	return match[1].split(';');
}

describe('withUserAgent', () => {
	it('adds both identification headers', () => {
		expect(withUserAgent({})).toEqual({
			'User-Agent': USER_AGENT,
			'x-amz-user-agent': USER_AGENT,
		});
	});

	it('preserves existing headers and does not mutate the input', () => {
		const input = { 'content-type': 'application/json', Authorization: 'AWS4-HMAC-SHA256 ...' };
		const out = withUserAgent(input);
		expect(out['content-type']).toBe('application/json');
		expect(out['Authorization']).toBe('AWS4-HMAC-SHA256 ...');
		// The signed headers object handed to us must come back unchanged.
		expect(input).toEqual({
			'content-type': 'application/json',
			Authorization: 'AWS4-HMAC-SHA256 ...',
		});
	});

	it('is a fixed token with no interpolated data', () => {
		expect(USER_AGENT).toBe('n8n-nodes-agentcore');
	});
});

describe('user-agent on the control plane', () => {
	it('sends both identification headers', async () => {
		const { httpRequest, sent } = mockHttp(() => ({
			body: JSON.stringify({ harness: { harnessId: 'h1' } }),
			statusCode: 200,
		}));
		await controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses/h1' });
		expect(sent().headers['User-Agent']).toBe(USER_AGENT);
		expect(sent().headers['x-amz-user-agent']).toBe(USER_AGENT);
	});

	it('leaves user-agent out of the SigV4 signed header set', async () => {
		const { httpRequest, sent } = mockHttp(() => ({ body: '{}', statusCode: 200 }));
		await controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses/h1' });
		const signed = signedHeaders(sent().headers['Authorization']);
		expect(signed).not.toContain('user-agent');
		expect(signed).not.toContain('x-amz-user-agent');
		// Sanity: the headers that should be signed still are.
		expect(signed).toContain('host');
		expect(signed).toContain('x-amz-date');
	});

	it('re-adds the headers on a retried attempt', async () => {
		// The first attempt is a retryable 503, so the second attempt is signed
		// afresh; the identification headers must survive re-signing.
		let attempts = 0;
		const { httpRequest, sent } = mockHttp(() => {
			attempts += 1;
			return attempts === 1 ? { body: '', statusCode: 503 } : { body: '{}', statusCode: 200 };
		});
		await controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses/h1' });
		expect(attempts).toBe(2);
		expect(sent().headers['User-Agent']).toBe(USER_AGENT);
		expect(sent().headers['x-amz-user-agent']).toBe(USER_AGENT);
	});
});

describe('user-agent on the data plane', () => {
	it('sends both identification headers on the SigV4 invoke path', async () => {
		const { httpRequest, sent } = mockHttp(() => ({ body: {}, statusCode: 200 }));
		await invokeHarnessStream(configWith(httpRequest), {
			harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h1',
			runtimeSessionId: 'a'.repeat(40),
			body: { messages: [] },
		});
		expect(sent().headers['User-Agent']).toBe(USER_AGENT);
		expect(sent().headers['x-amz-user-agent']).toBe(USER_AGENT);
		// The session-id header and the signature are untouched.
		expect(sent().headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe('a'.repeat(40));
		expect(sent().headers['Authorization']).toContain('AWS4-HMAC-SHA256');
	});

	it('sends both identification headers on the Bearer invoke path', async () => {
		// A non-2xx keeps the test off the event-stream decoder while still
		// capturing the headers that went out.
		const { httpRequest, sent } = mockHttp(() => ({
			body: '{"message":"denied"}',
			statusCode: 403,
			statusMessage: 'Forbidden',
		}));
		await expect(
			invokeWithBearer({
				region: 'us-west-2',
				harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h1',
				bearerToken: 'jwt-token',
				runtimeSessionId: 'b'.repeat(40),
				body: {},
				httpRequest,
			}),
		).rejects.toThrow(/403/);
		expect(sent().headers['User-Agent']).toBe(USER_AGENT);
		expect(sent().headers['x-amz-user-agent']).toBe(USER_AGENT);
		// Bearer auth is not disturbed by the added headers.
		expect(sent().headers['Authorization']).toBe('Bearer jwt-token');
	});
});
