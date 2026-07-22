/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { buildToolsArray, configHash } from '../nodes/AgentCoreHarness/helpers/tools';

describe('buildToolsArray', () => {
	it('returns an empty array when no tools are configured', () => {
		expect(buildToolsArray(undefined)).toEqual([]);
		expect(buildToolsArray({})).toEqual([]);
	});

	it('builds a code interpreter tool with a default name', () => {
		const tools = buildToolsArray({ tool: [{ type: 'agentcore_code_interpreter' }] });
		expect(tools).toEqual([{ type: 'agentcore_code_interpreter', name: 'code_interpreter' }]);
	});

	it('builds a browser tool honoring a custom name', () => {
		const tools = buildToolsArray({ tool: [{ type: 'agentcore_browser', name: 'my_browser' }] });
		expect(tools).toEqual([{ type: 'agentcore_browser', name: 'my_browser' }]);
	});

	it('builds a remote_mcp tool with url and parsed headers', () => {
		const tools = buildToolsArray({
			tool: [{ type: 'remote_mcp', url: 'https://mcp.example.com', headers: '{"Authorization":"Bearer x"}' }],
		});
		expect(tools[0]).toMatchObject({
			type: 'remote_mcp',
			config: { remoteMcp: { url: 'https://mcp.example.com', headers: { Authorization: 'Bearer x' } } },
		});
	});

	it('throws when remote_mcp is missing a url', () => {
		expect(() => buildToolsArray({ tool: [{ type: 'remote_mcp' }] })).toThrow(/requires a URL/);
	});

	it('throws when remote_mcp headers are not valid JSON', () => {
		expect(() =>
			buildToolsArray({ tool: [{ type: 'remote_mcp', url: 'https://x', headers: 'not json' }] }),
		).toThrow(/valid JSON/);
	});

	it('builds a gateway tool and omits outboundAuth for the SigV4 default', () => {
		const tools = buildToolsArray({
			tool: [{ type: 'agentcore_gateway', gatewayArn: 'arn:aws:...:gateway/g', outboundAuth: 'awsIam' }],
		});
		expect(tools[0].config).toEqual({ agentCoreGateway: { gatewayArn: 'arn:aws:...:gateway/g' } });
	});

	it('builds a gateway tool with OAuth outbound auth', () => {
		const tools = buildToolsArray({
			tool: [
				{
					type: 'agentcore_gateway',
					gatewayArn: 'arn:g',
					outboundAuth: 'oauth',
					oauthProviderName: 'prov',
					oauthScopes: 'a, b',
				},
			],
		});
		expect(tools[0].config).toEqual({
			agentCoreGateway: {
				gatewayArn: 'arn:g',
				outboundAuth: { oauth: { oauthCredentialProvider: { credentialProviderName: 'prov', scopes: ['a', 'b'] } } },
			},
		});
	});

	it('throws when gateway is missing an ARN', () => {
		expect(() => buildToolsArray({ tool: [{ type: 'agentcore_gateway' }] })).toThrow(/Gateway ARN/);
	});

	it('builds an inline_function tool from name, description, and schema', () => {
		const tools = buildToolsArray({
			tool: [
				{
					type: 'inline_function',
					name: 'lookup',
					description: 'Look something up',
					inputSchema: '{"type":"object","properties":{"q":{"type":"string"}}}',
				},
			],
		});
		expect(tools[0]).toMatchObject({
			type: 'inline_function',
			name: 'lookup',
			config: { inlineFunction: { description: 'Look something up' } },
		});
	});

	it('throws for inline_function missing a description or schema', () => {
		expect(() => buildToolsArray({ tool: [{ type: 'inline_function', name: 'x' }] })).toThrow(
			/requires a Description/,
		);
		expect(() =>
			buildToolsArray({ tool: [{ type: 'inline_function', name: 'x', description: 'd' }] }),
		).toThrow(/Input Schema/);
	});

	it('rejects an unsupported tool type (e.g. removed web search)', () => {
		expect(() => buildToolsArray({ tool: [{ type: 'agentcore_web_search' }] })).toThrow(
			/Unsupported tool type/,
		);
	});
});

describe('configHash', () => {
	const base = { systemPrompt: 'hi', tools: [] as any[] };

	it('is stable across calls with identical input', () => {
		expect(configHash(base)).toBe(configHash(base));
	});

	it('changes when the system prompt changes', () => {
		expect(configHash(base)).not.toBe(configHash({ ...base, systemPrompt: 'different' }));
	});

	it('is order-independent for tools (sorted by name before hashing)', () => {
		const a = configHash({ ...base, tools: [{ type: 't', name: 'a' }, { type: 't', name: 'b' }] });
		const b = configHash({ ...base, tools: [{ type: 't', name: 'b' }, { type: 't', name: 'a' }] });
		expect(a).toBe(b);
	});

	it('changes when the model config changes', () => {
		const a = configHash({ ...base, model: { bedrockModelConfig: { modelId: 'x' } } });
		const b = configHash({ ...base, model: { bedrockModelConfig: { modelId: 'y' } } });
		expect(a).not.toBe(b);
	});
});
