/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { controlRequest, type AwsCallerConfig } from '../nodes/AgentCoreHarness/helpers/httpClient';

// Make backoff instant so retry tests don't wait on real timers.
vi.mock('n8n-workflow', () => ({ sleep: () => Promise.resolve() }));

const CONFIG: AwsCallerConfig = {
	region: 'us-west-2',
	credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
};

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init: any) => Response) {
	vi.stubGlobal('fetch', vi.fn((url: string, init: any) => Promise.resolve(impl(url, init))));
}

describe('controlRequest', () => {
	it('signs the request (Authorization header) and parses a JSON response', async () => {
		let sentHeaders: Record<string, string> = {};
		stubFetch((_url, init) => {
			sentHeaders = init.headers;
			return new Response(JSON.stringify({ harness: { harnessId: 'h1' } }), { status: 200 });
		});
		const res = await controlRequest(CONFIG, { method: 'GET', path: '/harnesses/h1' });
		expect(res).toEqual({ harness: { harnessId: 'h1' } });
		expect(sentHeaders['Authorization']).toContain('AWS4-HMAC-SHA256');
		expect(sentHeaders['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
	});

	it('maps an AWS __type error body to a readable error', async () => {
		stubFetch(
			() =>
				new Response(
					JSON.stringify({ __type: 'com.amazon#ResourceNotFoundException', message: 'no such harness' }),
					{ status: 404, statusText: 'Not Found' },
				),
		);
		await expect(controlRequest(CONFIG, { method: 'GET', path: '/harnesses/missing' })).rejects.toThrow(
			/ResourceNotFoundException: no such harness/,
		);
	});

	it('reads the error type from the x-amzn-errortype header when the body omits it', async () => {
		// Common REST-JSON shape: type in the header, no __type in the body. The
		// endpoint upsert path depends on this to detect a missing resource.
		stubFetch(
			() =>
				new Response('', {
					status: 404,
					statusText: 'Not Found',
					headers: { 'x-amzn-errortype': 'ResourceNotFoundException:http://internal.amazon.com/' },
				}),
		);
		await expect(controlRequest(CONFIG, { method: 'GET', path: '/harnesses/x/endpoints/p' })).rejects.toThrow(
			/ResourceNotFoundException/,
		);
	});

	it('reads the error type from a body "code" field', async () => {
		stubFetch(
			() => new Response(JSON.stringify({ code: 'ThrottlingException', message: 'slow down' }), { status: 400 }),
		);
		await expect(controlRequest(CONFIG, { method: 'GET', path: '/harnesses' })).rejects.toThrow(
			/ThrottlingException: slow down/,
		);
	});

	it('falls back to HTTP status when the error body is not JSON', async () => {
		// 400 is not retryable, so this returns on the first attempt.
		stubFetch(() => new Response('bad request boom', { status: 400, statusText: 'Bad Request' }));
		await expect(controlRequest(CONFIG, { method: 'GET', path: '/harnesses' })).rejects.toThrow(
			/HTTP 400 Bad Request/,
		);
	});

	it('serializes a body and drops undefined query params', async () => {
		let sentUrl = '';
		let sentBody = '';
		stubFetch((url, init) => {
			sentUrl = url;
			sentBody = init.body;
			return new Response('{}', { status: 200 });
		});
		await controlRequest(CONFIG, {
			method: 'GET',
			path: '/harnesses',
			query: { maxResults: 100, nextToken: undefined },
			body: { a: 1 },
		});
		expect(sentUrl).toContain('maxResults=100');
		expect(sentUrl).not.toContain('nextToken');
		expect(sentBody).toBe('{"a":1}');
	});
});

describe('controlRequest — retries and idempotency', () => {
	it('retries a transient 503 and then succeeds', async () => {
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				calls += 1;
				if (calls < 3) return Promise.resolve(new Response('', { status: 503 }));
				return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
			}),
		);
		const res = await controlRequest(CONFIG, { method: 'GET', path: '/harnesses' });
		expect(res).toEqual({ ok: true });
		expect(calls).toBe(3);
	});

	it('does not retry a non-retryable 400', async () => {
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				calls += 1;
				return Promise.resolve(new Response(JSON.stringify({ __type: 'ValidationException' }), { status: 400 }));
			}),
		);
		await expect(controlRequest(CONFIG, { method: 'GET', path: '/harnesses' })).rejects.toThrow(
			/ValidationException/,
		);
		expect(calls).toBe(1);
	});

	it('gives up after the maximum number of attempts on a persistent 500', async () => {
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				calls += 1;
				return Promise.resolve(new Response('', { status: 500 }));
			}),
		);
		await expect(controlRequest(CONFIG, { method: 'GET', path: '/harnesses' })).rejects.toBeTruthy();
		expect(calls).toBe(4);
	});

	it('adds a clientToken to a mutating request and reuses it across retries', async () => {
		const tokens: unknown[] = [];
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init: any) => {
				calls += 1;
				tokens.push(JSON.parse(init.body).clientToken);
				if (calls < 2) return Promise.resolve(new Response('', { status: 503 }));
				return Promise.resolve(new Response('{}', { status: 200 }));
			}),
		);
		await controlRequest(CONFIG, { method: 'POST', path: '/harnesses', body: { harnessName: 'x' } });
		expect(calls).toBe(2);
		expect(typeof tokens[0]).toBe('string');
		// The retried write must carry the same token so it is idempotent server-side.
		expect(tokens[0]).toBe(tokens[1]);
	});

	it('does not add a clientToken to a GET', async () => {
		let sentBody: string | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init: any) => {
				sentBody = init.body;
				return Promise.resolve(new Response('{}', { status: 200 }));
			}),
		);
		await controlRequest(CONFIG, { method: 'GET', path: '/harnesses' });
		expect(sentBody).toBeUndefined();
	});
});
