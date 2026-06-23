/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'crypto';
import type { IDataObject } from 'n8n-workflow';

export interface ToolConfig {
	type: string;
	name: string;
	config?: IDataObject;
}

/**
 * Converts the n8n collection-field tool configuration into the `tools` array
 * shape expected by the Create/Update/Invoke Harness APIs.
 *
 * Supported tool types (v0.2):
 *   - agentcore_browser
 *   - agentcore_code_interpreter
 *   - agentcore_gateway        (+ optional OAuth outbound auth)
 *   - remote_mcp
 *   - inline_function          (client-side execution; round-trips via toolResult)
 *   - agentcore_web_search     (managed; no config)
 *
 * NOTE (TODO(v0.2-question-5)): `agentcore_web_search` is documented in the GA
 * dev guide but is not yet in the SDK's HarnessToolType enum. The SDK schema
 * serializes `HarnessTool.type` as a plain string (verified in schemas_0.js),
 * so the raw value is sent verbatim and accepted by the service.
 */
export function buildToolsArray(toolsUi: IDataObject | undefined): ToolConfig[] {
	if (!toolsUi || !toolsUi.tool) {
		return [];
	}

	const uiTools = toolsUi.tool as IDataObject[];
	const tools: ToolConfig[] = [];

	for (const uiTool of uiTools) {
		const type = uiTool.type as string;

		switch (type) {
			case 'agentcore_browser':
				tools.push({
					type: 'agentcore_browser',
					name: (uiTool.name as string) || 'browser',
				});
				break;

			case 'agentcore_code_interpreter':
				tools.push({
					type: 'agentcore_code_interpreter',
					name: (uiTool.name as string) || 'code_interpreter',
				});
				break;

			case 'agentcore_web_search':
				// Managed web search via Gateway, no setup required. No config.
				tools.push({
					type: 'agentcore_web_search',
					name: (uiTool.name as string) || 'web_search',
				});
				break;

			case 'agentcore_gateway': {
				const gatewayArn = (uiTool.gatewayArn as string) || '';
				if (!gatewayArn) {
					throw new Error('Gateway tool requires a Gateway ARN');
				}
				const agentCoreGateway: IDataObject = { gatewayArn };
				const outboundAuth = buildGatewayOutboundAuth(uiTool);
				if (outboundAuth) agentCoreGateway.outboundAuth = outboundAuth;
				tools.push({
					type: 'agentcore_gateway',
					name: (uiTool.name as string) || 'gateway',
					config: { agentCoreGateway },
				});
				break;
			}

			case 'remote_mcp': {
				const url = (uiTool.url as string) || '';
				if (!url) {
					throw new Error('Remote MCP tool requires a URL');
				}
				const remoteMcp: IDataObject = { url };
				const headers = parseHeaders(uiTool.headers as string);
				if (Object.keys(headers).length > 0) {
					remoteMcp.headers = headers;
				}
				tools.push({
					type: 'remote_mcp',
					name: (uiTool.name as string) || 'remote_mcp',
					config: { remoteMcp },
				});
				break;
			}

			case 'inline_function': {
				const name = (uiTool.name as string) || '';
				if (!name) {
					throw new Error('Inline function tool requires a Name (the function name).');
				}
				const description = (uiTool.description as string) || '';
				if (!description) {
					throw new Error(`Inline function "${name}" requires a Description.`);
				}
				const inputSchema = parseInputSchema(uiTool.inputSchema as string, name);
				tools.push({
					type: 'inline_function',
					name,
					config: { inlineFunction: { description, inputSchema } },
				});
				break;
			}

			default:
				throw new Error(`Unsupported tool type: ${type}`);
		}
	}

	return tools;
}

/**
 * Builds the HarnessGatewayOutboundAuth union from the gateway tool fields.
 * Returns undefined when SigV4 (the service default) is selected, so the field
 * is omitted entirely.
 */
function buildGatewayOutboundAuth(uiTool: IDataObject): IDataObject | undefined {
	const mode = (uiTool.outboundAuth as string) || 'awsIam';
	switch (mode) {
		case 'none':
			return { none: {} };
		case 'oauth': {
			const providerName = (uiTool.oauthProviderName as string) || '';
			if (!providerName) {
				throw new Error('Gateway OAuth outbound auth requires a Credential Provider Name.');
			}
			const oauthCredentialProvider: IDataObject = { credentialProviderName: providerName };
			const scopes = splitScopes(uiTool.oauthScopes as string);
			if (scopes.length > 0) oauthCredentialProvider.scopes = scopes;
			return { oauth: { oauthCredentialProvider } };
		}
		case 'awsIam':
		default:
			// SigV4 is the default when omitted; don't send it.
			return undefined;
	}
}

function splitScopes(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseHeaders(headersJson: string | undefined): Record<string, string> {
	if (!headersJson || headersJson.trim() === '') {
		return {};
	}
	try {
		const parsed = JSON.parse(headersJson);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new Error('Headers must be a JSON object');
		}
		return parsed as Record<string, string>;
	} catch (err) {
		throw new Error('Headers must be valid JSON, for example: {"Authorization": "Bearer ..."}');
	}
}

function parseInputSchema(raw: string | undefined, toolName: string): IDataObject {
	if (!raw || raw.trim() === '') {
		throw new Error(`Inline function "${toolName}" requires an Input Schema (JSON Schema object).`);
	}
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new Error('not an object');
		}
		return parsed as IDataObject;
	} catch {
		throw new Error(
			`Inline function "${toolName}" Input Schema must be a valid JSON Schema object, ` +
				'for example: {"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}',
		);
	}
}

/**
 * Computes a stable hash of the harness configuration. Used to detect drift
 * between the configured node values and the deployed harness, so the node can
 * call UpdateHarness when needed and skip the API call when not.
 *
 * v0.2: extended to cover the new harness-level config surface (model union,
 * memory, skills, environment, container) so that changing any of them triggers
 * an UpdateHarness, and leaving them unchanged still hits the fast reuse path.
 */
export function configHash(input: {
	model?: IDataObject;
	systemPrompt: string;
	tools: ToolConfig[];
	skills?: IDataObject[];
	memory?: IDataObject;
	environment?: IDataObject;
	environmentArtifact?: IDataObject;
	maxIterations?: number;
	maxTokens?: number;
	timeoutSeconds?: number;
}): string {
	const normalized = JSON.stringify({
		model: input.model ?? null,
		systemPrompt: input.systemPrompt,
		tools: input.tools.slice().sort((a, b) => a.name.localeCompare(b.name)),
		skills: input.skills ?? null,
		memory: input.memory ?? null,
		environment: input.environment ?? null,
		environmentArtifact: input.environmentArtifact ?? null,
		maxIterations: input.maxIterations ?? null,
		maxTokens: input.maxTokens ?? null,
		timeoutSeconds: input.timeoutSeconds ?? null,
	});
	return createHash('sha256').update(normalized).digest('hex');
}
