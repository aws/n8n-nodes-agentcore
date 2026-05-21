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
 * shape expected by the InvokeHarness API.
 *
 * Supported tool types in v1: agentcore_browser, agentcore_code_interpreter,
 * agentcore_gateway, remote_mcp.
 *
 * Inline functions (n8n nodes as tools) are not supported in v1 and will be
 * added in v0.2.
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
					throw new Error('Gateway tool requires a Gateway ARN');
				}
				tools.push({
					type: 'agentcore_gateway',
					name: (uiTool.name as string) || 'gateway',
					config: { gatewayArn },
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

			default:
				throw new Error(`Unsupported tool type: ${type}`);
		}
	}

	return tools;
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

/**
 * Computes a stable hash of the harness configuration. Used to detect drift
 * between the configured node values and the deployed harness, so the node
 * can call UpdateHarness when needed and skip the API call when not.
 */
export function configHash(input: {
	modelId: string;
	systemPrompt: string;
	tools: ToolConfig[];
	maxIterations?: number;
	maxTokens?: number;
	timeoutSeconds?: number;
}): string {
	const normalized = JSON.stringify({
		modelId: input.modelId,
		systemPrompt: input.systemPrompt,
		tools: input.tools.slice().sort((a, b) => a.name.localeCompare(b.name)),
		maxIterations: input.maxIterations ?? null,
		maxTokens: input.maxTokens ?? null,
		timeoutSeconds: input.timeoutSeconds ?? null,
	});
	return createHash('sha256').update(normalized).digest('hex');
}
