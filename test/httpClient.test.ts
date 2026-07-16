/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { controlRequest, type AwsCallerConfig } from '../nodes/AgentCoreHarness/helpers/httpClient';

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

	it('falls back to HTTP status when the error body is not JSON', async () => {
		stubFetch(() => new Response('gateway boom', { status: 502, statusText: 'Bad Gateway' }));
		await expect(controlRequest(CONFIG, { method: 'GET', path: '/harnesses' })).rejects.toThrow(
			/HTTP 502 Bad Gateway/,
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
