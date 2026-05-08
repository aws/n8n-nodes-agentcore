/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { INodeProperties } from 'n8n-workflow';

/**
 * Tool collection field. Used by both auto-provisioned and BYO-ARN modes.
 * v1 supports: AgentCore Browser, Code Interpreter, Gateway, Remote MCP.
 * Inline functions (n8n nodes as tools) come in v0.2.
 */
export const toolsField: INodeProperties = {
	displayName: 'Tools',
	name: 'tools',
	type: 'fixedCollection',
	placeholder: 'Add Tool',
	typeOptions: { multipleValues: true },
	default: {},
	options: [
		{
			name: 'tool',
			displayName: 'Tool',
			values: [
				{
					displayName: 'Type',
					name: 'type',
					type: 'options',
					default: 'agentcore_browser',
					options: [
						{ name: 'AgentCore Browser', value: 'agentcore_browser' },
						{ name: 'AgentCore Code Interpreter', value: 'agentcore_code_interpreter' },
						{ name: 'AgentCore Gateway', value: 'agentcore_gateway' },
						{ name: 'Remote MCP Server', value: 'remote_mcp' },
					],
				},
				{
					displayName: 'Name',
					name: 'name',
					type: 'string',
					default: '',
					description: 'Optional display name for this tool',
				},
				{
					displayName: 'Gateway ARN',
					name: 'gatewayArn',
					type: 'string',
					default: '',
					placeholder: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/my-gateway',
					displayOptions: { show: { type: ['agentcore_gateway'] } },
					description: 'ARN of the AgentCore Gateway to attach',
				},
				{
					displayName: 'MCP Server URL',
					name: 'url',
					type: 'string',
					default: '',
					placeholder: 'https://mcp.example.com/mcp',
					displayOptions: { show: { type: ['remote_mcp'] } },
					description: 'URL of the remote MCP server',
				},
				{
					displayName: 'MCP Headers (JSON)',
					name: 'headers',
					type: 'string',
					default: '',
					typeOptions: { rows: 3 },
					placeholder: '{"Authorization": "Bearer ..."}',
					displayOptions: { show: { type: ['remote_mcp'] } },
					description: 'Optional HTTP headers as a JSON object',
				},
			],
		},
	],
	description: 'Tools the harness agent can use during invocation',
};
