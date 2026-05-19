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
					displayName: 'Gateway ARN',
					name: 'gatewayArn',
					type: 'string',
					default: '',
					placeholder: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/my-gateway',
					description: 'ARN of the AgentCore Gateway to attach',
				},
				{
					displayName: 'MCP Headers (JSON)',
					name: 'headers',
					type: 'string',
					default: '',
					placeholder: '{\'Authorization\': \'Bearer	...\'}',
					description: 'Optional HTTP headers as a JSON object',
				},
				{
					displayName: 'MCP Server URL',
					name: 'url',
					type: 'string',
					default: '',
					placeholder: 'https://mcp.example.com/mcp',
					description: 'URL of the remote MCP server',
				},
				{
					displayName: 'Name',
					name: 'name',
					type: 'string',
					default: '',
					description: 'Optional display name for this tool',
				},
				{
					displayName: 'Type',
					name: 'type',
					type: 'options',
					default: 'agentcore_browser',
					options: [
						{
							name: 'AgentCore Browser',
							value: 'agentcore_browser',
						},
						{
							name: 'AgentCore Code Interpreter',
							value: 'agentcore_code_interpreter',
						},
						{
							name: 'AgentCore Gateway',
							value: 'agentcore_gateway',
						},
						{
							name: 'Remote MCP Server',
							value: 'remote_mcp',
						},
					]
				},
			],
		},
	],
	description: 'Tools the harness agent can use during invocation',
};
