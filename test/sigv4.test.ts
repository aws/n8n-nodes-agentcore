/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { signRequest, type SigV4Credentials } from '../nodes/AgentCoreHarness/helpers/sigv4';

const TEST_CREDS: SigV4Credentials = {
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const REGION = 'us-west-2';
const SERVICE = 'bedrock-agentcore';
const AMZ_DATE = '20260715T120000Z';

function authOf(headers: Record<string, string>): string {
	return headers['Authorization'];
}

describe('sigv4 — canonical algorithm (get-vanilla inputs)', () => {
	// The AWS "get-vanilla" test vector signs only host + x-amz-date and yields
	// 5fa00fa3...; our signer additionally signs x-amz-content-sha256 (a superset,
	// which AWS accepts), so the literal signature differs by design. We assert
	// the algorithm is correct two ways: it is deterministic for identical input,
	// and — in the differential block below — it matches the AWS SDK's own signer
	// (which also signs the content hash) byte-for-byte.
	it('is deterministic for identical inputs', () => {
		const opts = {
			region: 'us-east-1',
			service: 'service',
			credentials: TEST_CREDS,
			overrideAmzDate: '20150830T123600Z',
		};
		const a = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '' }, opts);
		const b = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '' }, opts);
		expect(authOf(a)).toBe(authOf(b));
		expect(authOf(a)).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
		);
	});
});

describe('sigv4 — header shape', () => {
	it('emits the expected signing headers', () => {
		const headers = signRequest(
			{ method: 'GET', url: 'https://h.us-west-2.amazonaws.com/harnesses', headers: {}, body: '' },
			{ region: REGION, service: SERVICE, credentials: TEST_CREDS, overrideAmzDate: AMZ_DATE },
		);
		expect(headers['X-Amz-Date']).toBe(AMZ_DATE);
		expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
		expect(headers['Authorization']).toContain('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/');
		expect(headers['Authorization']).toContain('SignedHeaders=');
	});

	it('includes the session token header only when a session token is present', () => {
		const withToken = signRequest(
			{ method: 'GET', url: 'https://h.us-west-2.amazonaws.com/harnesses', headers: {}, body: '' },
			{
				region: REGION,
				service: SERVICE,
				credentials: { ...TEST_CREDS, sessionToken: 'TOKEN123' },
				overrideAmzDate: AMZ_DATE,
			},
		);
		expect(withToken['X-Amz-Security-Token']).toBe('TOKEN123');
		expect(withToken['Authorization']).toContain('x-amz-security-token');

		const withoutToken = signRequest(
			{ method: 'GET', url: 'https://h.us-west-2.amazonaws.com/harnesses', headers: {}, body: '' },
			{ region: REGION, service: SERVICE, credentials: TEST_CREDS, overrideAmzDate: AMZ_DATE },
		);
		expect(withoutToken['X-Amz-Security-Token']).toBeUndefined();
	});

	it('never places the secret key in the signed output', () => {
		const headers = signRequest(
			{ method: 'POST', url: 'https://h.us-west-2.amazonaws.com/harnesses', headers: {}, body: '{"a":1}' },
			{ region: REGION, service: SERVICE, credentials: TEST_CREDS, overrideAmzDate: AMZ_DATE },
		);
		const serialized = JSON.stringify(headers);
		expect(serialized).not.toContain(TEST_CREDS.secretAccessKey);
	});
});

describe('sigv4 — differential parity with @smithy/signature-v4 (the SDK signer)', () => {
	const smithy = new SignatureV4({
		credentials: TEST_CREDS,
		region: REGION,
		service: SERVICE,
		sha256: Sha256,
		uriEscapePath: true,
		applyChecksum: true,
	});

	async function smithyAuth(
		method: string,
		urlStr: string,
		body: string,
		extraHeaders: Record<string, string> = {},
	): Promise<string> {
		const url = new URL(urlStr);
		const query: Record<string, string> = {};
		for (const [k, v] of url.searchParams.entries()) query[k] = v;
		const req = {
			method,
			protocol: url.protocol,
			hostname: url.hostname,
			path: url.pathname,
			query,
			headers: { host: url.hostname, 'content-type': 'application/json', ...extraHeaders },
			body: body || undefined,
		};
		const signed = (await smithy.sign(req as any, {
			signingDate: new Date('2026-07-15T12:00:00Z'),
		})) as unknown as { headers: Record<string, string> };
		return signed.headers['authorization'];
	}

	function ourAuth(
		method: string,
		urlStr: string,
		body: string,
		extraHeaders: Record<string, string> = {},
	): string {
		return authOf(
			signRequest(
				{
					method,
					url: urlStr,
					headers: { 'content-type': 'application/json', ...extraHeaders },
					body,
				},
				{ region: REGION, service: SERVICE, credentials: TEST_CREDS, overrideAmzDate: AMZ_DATE },
			),
		);
	}

	const host = 'bedrock-agentcore-control.us-west-2.amazonaws.com';
	const dataHost = 'bedrock-agentcore.us-west-2.amazonaws.com';

	const cases: Array<[string, string, string, string]> = [
		['GET simple', 'GET', `https://${host}/harnesses`, ''],
		['GET with id', 'GET', `https://${host}/harnesses/helloagent_v1-V7MYssFCOv`, ''],
		[
			'GET query maxResults+nextToken(encoded)',
			'GET',
			`https://${host}/harnesses?maxResults=100&nextToken=abc%2Fdef`,
			'',
		],
		['DELETE with query bool', 'DELETE', `https://${host}/harnesses/abc123?deleteManagedMemory=false`, ''],
		[
			'POST JSON body',
			'POST',
			`https://${host}/harnesses`,
			JSON.stringify({ harnessName: 'x', systemPrompt: [{ text: 'hi' }] }),
		],
		['PATCH JSON body', 'PATCH', `https://${host}/harnesses/abc123`, JSON.stringify({ maxIterations: 5 })],
		['path with encoded space', 'GET', `https://${host}/harnesses/name%20with%20spaces`, ''],
		['query with special chars', 'GET', `https://${host}/harnesses?namePrefix=a%2Bb%20c`, ''],
		['unicode body', 'POST', `https://${host}/harnesses`, JSON.stringify({ text: 'café 日本 🌴' })],
		[
			'data-plane invoke w/ ARN query',
			'POST',
			`https://${dataHost}/harnesses/invoke?harnessArn=arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A123%3Aharness%2Fx&qualifier=prod`,
			JSON.stringify({ messages: [] }),
		],
	];

	it.each(cases)('matches the SDK signer: %s', async (_name, method, url, body) => {
		const ours = ourAuth(method, url, body);
		const theirs = await smithyAuth(method, url, body);
		expect(ours).toBe(theirs);
	});
});
