/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi } from 'vitest';
import {
	controlRequest,
	type AwsCallerConfig,
	type HttpRequestFn,
} from '../nodes/AgentCoreHarness/helpers/httpClient';

// Make backoff instant so retry tests don't wait on real timers.
vi.mock('n8n-workflow', () => ({ sleep: () => Promise.resolve() }));

/**
 * Builds a mock of n8n's `this.helpers.httpRequest` that returns the
 * full-response shape (`{ body, headers, statusCode }`) the transport layer
 * consumes. `impl` receives the same options object the code passes to the
 * helper, so tests can assert on the URL, headers, and body it sent.
 */
function mockHttp(
	impl: (options: any) => { body?: unknown; headers?: Record<string, unknown>; statusCode: number; statusMessage?: string },
): { httpRequest: HttpRequestFn; fn: ReturnType<typeof vi.fn> } {
	const fn = vi.fn((options: any) => Promise.resolve(impl(options)));
	return { httpRequest: fn as unknown as HttpRequestFn, fn };
}

function configWith(httpRequest: HttpRequestFn): AwsCallerConfig {
	return {
		region: 'us-west-2',
		credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
		httpRequest,
	};
}

describe('controlRequest', () => {
	it('signs the request (Authorization header) and parses a JSON response', async () => {
		let sentHeaders: Record<string, string> = {};
		const { httpRequest } = mockHttp((options) => {
			sentHeaders = options.headers;
			return { body: JSON.stringify({ harness: { harnessId: 'h1' } }), statusCode: 200 };
		});
		const res = await controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses/h1' });
		expect(res).toEqual({ harness: { harnessId: 'h1' } });
		expect(sentHeaders['Authorization']).toContain('AWS4-HMAC-SHA256');
		expect(sentHeaders['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
	});

	it('parses an already-parsed (object) JSON response body', async () => {
		// Some n8n versions parse the body even with json:false; handle both.
		const { httpRequest } = mockHttp(() => ({ body: { harness: { harnessId: 'h2' } }, statusCode: 200 }));
		const res = await controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses/h2' });
		expect(res).toEqual({ harness: { harnessId: 'h2' } });
	});

	it('maps an AWS __type error body to a readable error', async () => {
		const { httpRequest } = mockHttp(() => ({
			body: JSON.stringify({ __type: 'com.amazon#ResourceNotFoundException', message: 'no such harness' }),
			statusCode: 404,
			statusMessage: 'Not Found',
		}));
		await expect(
			controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses/missing' }),
		).rejects.toThrow(/ResourceNotFoundException: no such harness/);
	});

	it('reads the error type from the x-amzn-errortype header when the body omits it', async () => {
		// Common REST-JSON shape: type in the header, no __type in the body. The
		// endpoint upsert path depends on this to detect a missing resource.
		const { httpRequest } = mockHttp(() => ({
			body: '',
			statusCode: 404,
			statusMessage: 'Not Found',
			headers: { 'x-amzn-errortype': 'ResourceNotFoundException:http://internal.amazon.com/' },
		}));
		await expect(
			controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses/x/endpoints/p' }),
		).rejects.toThrow(/ResourceNotFoundException/);
	});

	it('reads the error type from a body "code" field', async () => {
		const { httpRequest } = mockHttp(() => ({
			body: JSON.stringify({ code: 'ThrottlingException', message: 'slow down' }),
			statusCode: 400,
		}));
		await expect(
			controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses' }),
		).rejects.toThrow(/ThrottlingException: slow down/);
	});

	it('falls back to HTTP status when the error body is not JSON', async () => {
		// 400 is not retryable, so this returns on the first attempt.
		const { httpRequest } = mockHttp(() => ({
			body: 'bad request boom',
			statusCode: 400,
			statusMessage: 'Bad Request',
		}));
		await expect(
			controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses' }),
		).rejects.toThrow(/HTTP 400 Bad Request/);
	});

	it('serializes a body and drops undefined query params', async () => {
		let sentUrl = '';
		let sentBody: unknown;
		const { httpRequest } = mockHttp((options) => {
			sentUrl = options.url;
			sentBody = options.body;
			return { body: '{}', statusCode: 200 };
		});
		await controlRequest(configWith(httpRequest), {
			method: 'GET',
			path: '/harnesses',
			query: { maxResults: 100, nextToken: undefined },
			body: { a: 1 },
		});
		expect(sentUrl).toContain('maxResults=100');
		expect(sentUrl).not.toContain('nextToken');
		// Body is sent as the exact pre-serialized string we signed, never an object.
		expect(sentBody).toBe('{"a":1}');
	});
});

describe('controlRequest — retries and idempotency', () => {
	it('retries a transient 503 and then succeeds', async () => {
		let calls = 0;
		const { httpRequest } = mockHttp(() => {
			calls += 1;
			if (calls < 3) return { body: '', statusCode: 503 };
			return { body: JSON.stringify({ ok: true }), statusCode: 200 };
		});
		const res = await controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses' });
		expect(res).toEqual({ ok: true });
		expect(calls).toBe(3);
	});

	it('does not retry a non-retryable 400', async () => {
		let calls = 0;
		const { httpRequest } = mockHttp(() => {
			calls += 1;
			return { body: JSON.stringify({ __type: 'ValidationException' }), statusCode: 400 };
		});
		await expect(
			controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses' }),
		).rejects.toThrow(/ValidationException/);
		expect(calls).toBe(1);
	});

	it('gives up after the maximum number of attempts on a persistent 500', async () => {
		let calls = 0;
		const { httpRequest } = mockHttp(() => {
			calls += 1;
			return { body: '', statusCode: 500 };
		});
		await expect(
			controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses' }),
		).rejects.toBeTruthy();
		expect(calls).toBe(4);
	});

	it('retries a network-level error (helper rejection) and then succeeds', async () => {
		let calls = 0;
		const fn = vi.fn(() => {
			calls += 1;
			if (calls < 2) return Promise.reject(new Error('ECONNRESET'));
			return Promise.resolve({ body: '{}', statusCode: 200 });
		});
		const res = await controlRequest(configWith(fn as unknown as HttpRequestFn), {
			method: 'GET',
			path: '/harnesses',
		});
		expect(res).toEqual({});
		expect(calls).toBe(2);
	});

	it('adds a clientToken to a mutating request and reuses it across retries', async () => {
		const tokens: unknown[] = [];
		let calls = 0;
		const { httpRequest } = mockHttp((options) => {
			calls += 1;
			tokens.push(JSON.parse(options.body).clientToken);
			if (calls < 2) return { body: '', statusCode: 503 };
			return { body: '{}', statusCode: 200 };
		});
		await controlRequest(configWith(httpRequest), {
			method: 'POST',
			path: '/harnesses',
			body: { harnessName: 'x' },
		});
		expect(calls).toBe(2);
		expect(typeof tokens[0]).toBe('string');
		// The retried write must carry the same token so it is idempotent server-side.
		expect(tokens[0]).toBe(tokens[1]);
	});

	it('does not add a clientToken to a GET', async () => {
		let sentBody: string | undefined;
		const { httpRequest } = mockHttp((options) => {
			sentBody = options.body;
			return { body: '{}', statusCode: 200 };
		});
		await controlRequest(configWith(httpRequest), { method: 'GET', path: '/harnesses' });
		expect(sentBody).toBeUndefined();
	});
});
