/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi } from 'vitest';
import { ControlClient } from '../nodes/AgentCoreHarness/helpers/controlClient';
import type { AwsCallerConfig, HttpRequestFn } from '../nodes/AgentCoreHarness/helpers/httpClient';

/**
 * Injects a mock `httpRequest` that captures the URL it is called with and
 * returns an empty-object 200 response, so we can assert on path building.
 */
function configCapturingUrl(): { config: AwsCallerConfig; url: () => string } {
	let captured = '';
	const httpRequest = vi.fn((options: any) => {
		captured = options.url;
		return Promise.resolve({ body: '{}', statusCode: 200 });
	}) as unknown as HttpRequestFn;
	return {
		config: {
			region: 'us-west-2',
			credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
			httpRequest,
		},
		url: () => captured,
	};
}

describe('ControlClient — path building and single-encoding (Issue #41)', () => {
	it('builds the expected path for a normal harness id', async () => {
		const f = configCapturingUrl();
		await new ControlClient(f.config).getHarness('helloagent_v1-V7MYssFCOv');
		expect(f.url()).toBe(
			'https://bedrock-agentcore-control.us-west-2.amazonaws.com/harnesses/helloagent_v1-V7MYssFCOv',
		);
	});

	it('does not double-encode a segment containing special characters', async () => {
		// controlClient passes the id through raw; the SigV4 signer is the single
		// encoding point. A space must not become %2520 (double-encoded).
		const f = configCapturingUrl();
		await new ControlClient(f.config).getHarness('weird id');
		// The URL carries the raw segment (the HTTP layer handles wire encoding);
		// critically it is not pre-encoded to %2520 anywhere.
		expect(f.url()).not.toContain('%2520');
		expect(f.url()).toContain('/harnesses/weird');
	});

	it('routes endpoint operations to the correct nested path', async () => {
		const f = configCapturingUrl();
		await new ControlClient(f.config).getHarnessEndpoint('h-123', 'prod');
		expect(f.url()).toBe(
			'https://bedrock-agentcore-control.us-west-2.amazonaws.com/harnesses/h-123/endpoints/prod',
		);
	});

	it('passes deleteManagedMemory as a query param', async () => {
		const f = configCapturingUrl();
		await new ControlClient(f.config).deleteHarness('h-123', false);
		expect(f.url()).toContain('/harnesses/h-123?deleteManagedMemory=false');
	});
});
