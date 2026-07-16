/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ControlClient } from '../nodes/AgentCoreHarness/helpers/controlClient';
import type { AwsCallerConfig } from '../nodes/AgentCoreHarness/helpers/httpClient';

const CONFIG: AwsCallerConfig = {
	region: 'us-west-2',
	credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
};

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubFetch(): { url: () => string } {
	let captured = '';
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			captured = url;
			return Promise.resolve(new Response('{}', { status: 200 }));
		}),
	);
	return { url: () => captured };
}

describe('ControlClient — path building and single-encoding (Issue #41)', () => {
	it('builds the expected path for a normal harness id', async () => {
		const f = stubFetch();
		await new ControlClient(CONFIG).getHarness('helloagent_v1-V7MYssFCOv');
		expect(f.url()).toBe(
			'https://bedrock-agentcore-control.us-west-2.amazonaws.com/harnesses/helloagent_v1-V7MYssFCOv',
		);
	});

	it('does not double-encode a segment containing special characters', async () => {
		// controlClient passes the id through raw; the SigV4 signer is the single
		// encoding point. A space must not become %2520 (double-encoded).
		const f = stubFetch();
		await new ControlClient(CONFIG).getHarness('weird id');
		// The fetched URL carries the raw segment (URL/fetch handles wire encoding);
		// critically it is not pre-encoded to %2520 anywhere.
		expect(f.url()).not.toContain('%2520');
		expect(f.url()).toContain('/harnesses/weird');
	});

	it('routes endpoint operations to the correct nested path', async () => {
		const f = stubFetch();
		await new ControlClient(CONFIG).getHarnessEndpoint('h-123', 'prod');
		expect(f.url()).toBe(
			'https://bedrock-agentcore-control.us-west-2.amazonaws.com/harnesses/h-123/endpoints/prod',
		);
	});

	it('passes deleteManagedMemory as a query param', async () => {
		const f = stubFetch();
		await new ControlClient(CONFIG).deleteHarness('h-123', false);
		expect(f.url()).toContain('/harnesses/h-123?deleteManagedMemory=false');
	});
});
