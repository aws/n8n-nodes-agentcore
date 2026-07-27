/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { validateBearerToken } from '../nodes/AgentCoreHarness/AgentCoreHarness.node';

/**
 * Offline validation for the bearer credential's Test button. It should accept a
 * well-formed, unexpired JWT and reject empty, malformed, or expired tokens —
 * without any network call.
 */

function jwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	// Signature is opaque to offline validation; any non-empty segment is fine.
	return `${header}.${body}.c2lnbmF0dXJl`;
}

describe('validateBearerToken', () => {
	it('accepts a well-formed JWT with a far-future expiry', () => {
		const token = jwt({ sub: 'user-1', exp: 4102444800 }); // 2100-01-01
		const result = validateBearerToken(token);
		expect(result.status).toBe('OK');
	});

	it('accepts a well-formed JWT with no exp claim', () => {
		const token = jwt({ sub: 'user-1' });
		expect(validateBearerToken(token).status).toBe('OK');
	});

	it('rejects an empty token', () => {
		expect(validateBearerToken('').status).toBe('Error');
		expect(validateBearerToken('   ').status).toBe('Error');
	});

	it('rejects a token that is not three segments', () => {
		expect(validateBearerToken('not-a-jwt').status).toBe('Error');
		expect(validateBearerToken('only.two').status).toBe('Error');
		expect(validateBearerToken('a..c').status).toBe('Error'); // empty middle segment
	});

	it('rejects a token whose payload is not valid JSON', () => {
		const header = Buffer.from('{}').toString('base64url');
		const badBody = Buffer.from('not json at all').toString('base64url');
		const result = validateBearerToken(`${header}.${badBody}.sig`);
		expect(result.status).toBe('Error');
		expect(result.message).toMatch(/base64url/i);
	});

	it('rejects an expired token', () => {
		const token = jwt({ sub: 'user-1', exp: 1000000000 }); // 2001, long past
		const result = validateBearerToken(token);
		expect(result.status).toBe('Error');
		expect(result.message).toMatch(/expired/i);
	});

	it('does not leak the token value in the result message', () => {
		const token = jwt({ sub: 'secret-subject', exp: 1000000000 });
		const result = validateBearerToken(token);
		expect(result.message).not.toContain(token);
		expect(result.message ?? '').not.toContain('secret-subject');
	});
});
