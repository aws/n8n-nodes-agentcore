/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'crypto';
import { ApplicationError, type IDataObject } from 'n8n-workflow';

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
 *
 * Note: `agentcore_web_search` is described in the developer guide but is not yet
 * accepted by the Create/Update/Invoke Harness APIs (the service enum rejects it
 * with a ValidationException), so it is intentionally not offered here. Web
 * search can still be added today via a Remote MCP search server. Re-add the
 * managed type once the harness API enum includes it.
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

			case 'agentcore_gateway': {
				const gatewayArn = (uiTool.gatewayArn as string) || '';
				if (!gatewayArn) {
					throw new ApplicationError('Gateway tool requires a Gateway ARN');
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
					throw new ApplicationError('Remote MCP tool requires a URL');
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
					throw new ApplicationError('Inline function tool requires a Name (the function name).');
				}
				const description = (uiTool.description as string) || '';
				if (!description) {
					throw new ApplicationError(`Inline function "${name}" requires a Description.`);
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
				throw new ApplicationError(`Unsupported tool type: ${type}`);
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
				throw new ApplicationError(
					'Gateway OAuth outbound auth requires a Credential Provider Name.',
				);
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
	let parsed: unknown;
	try {
		parsed = JSON.parse(headersJson);
	} catch {
		parsed = undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new ApplicationError(
			'Headers must be valid JSON, for example: {"Authorization": "Bearer ..."}',
		);
	}
	return parsed as Record<string, string>;
}

function parseInputSchema(raw: string | undefined, toolName: string): IDataObject {
	if (!raw || raw.trim() === '') {
		throw new ApplicationError(
			`Inline function "${toolName}" requires an Input Schema (JSON Schema object).`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new ApplicationError(
			`Inline function "${toolName}" Input Schema must be a valid JSON Schema object, ` +
				'for example: {"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}',
		);
	}
	return parsed as IDataObject;
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
