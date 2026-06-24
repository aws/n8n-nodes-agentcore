/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { INodeProperties } from 'n8n-workflow';

/**
 * Tool collection field. Used by both auto-provisioned and BYO-ARN modes.
 * v0.2 supports: AgentCore Browser, Code Interpreter, Gateway (with optional
 * OAuth outbound auth), Remote MCP, and inline functions.
 *
 * Per-tool fields are shown/hidden by the selected Type so the form stays
 * legible across the tool types. Values are kept alphabetized by displayName to
 * satisfy eslint-plugin-n8n-nodes-base.
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
					displayName: 'Description',
					name: 'description',
					type: 'string',
					typeOptions: { rows: 2 },
					default: '',
					displayOptions: { show: { type: ['inline_function'] } },
					description: 'What the function does, up to 4096 characters. Provided to the model.',
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
					displayName: 'Input Schema (JSON)',
					name: 'inputSchema',
					type: 'json',
					default: '{}',
					displayOptions: { show: { type: ['inline_function'] } },
					description:
						'JSON Schema for the function input parameters. When the agent calls this function the invocation ends with stop reason tool_use; feed the result back via the Tool Results field on a downstream node.',
				},
				{
					displayName: 'MCP Headers (JSON)',
					name: 'headers',
					type: 'string',
					default: '',
					placeholder: '{ "Authorization": "Bearer xyz" }',
					displayOptions: { show: { type: ['remote_mcp'] } },
					description:
						'Optional HTTP headers as a JSON object. Reference an AgentCore Identity credential provider with an arn placeholder instead of inlining secrets.',
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
					displayName: 'Name',
					name: 'name',
					type: 'string',
					default: '',
					description:
						'Tool name. Optional for managed tools. For an inline function this is the function name the model calls, 1 to 64 characters of letters, numbers, underscores, and hyphens.',
				},
				{
					displayName: 'OAuth Credential Provider Name',
					name: 'oauthProviderName',
					type: 'string',
					default: '',
					displayOptions: { show: { type: ['agentcore_gateway'], outboundAuth: ['oauth'] } },
					description: 'Name of the AgentCore Identity OAuth credential provider',
				},
				{
					displayName: 'OAuth Scopes',
					name: 'oauthScopes',
					type: 'string',
					default: '',
					placeholder: 'read,write',
					displayOptions: { show: { type: ['agentcore_gateway'], outboundAuth: ['oauth'] } },
					description: 'Comma-separated OAuth scopes',
				},
				{
					displayName: 'Outbound Auth',
					name: 'outboundAuth',
					type: 'options',
					default: 'awsIam',
					displayOptions: { show: { type: ['agentcore_gateway'] } },
					options: [
						{ name: 'AWS IAM / SigV4 (Default)', value: 'awsIam' },
						{ name: 'OAuth', value: 'oauth' },
						{ name: 'None', value: 'none' },
					],
					description: 'How the harness authenticates outbound calls through the Gateway',
				},
				{
					displayName: 'Type',
					name: 'type',
					type: 'options',
					default: 'agentcore_browser',
					options: [
						{ name: 'AgentCore Browser', value: 'agentcore_browser' },
						{ name: 'AgentCore Code Interpreter', value: 'agentcore_code_interpreter' },
						{ name: 'AgentCore Gateway', value: 'agentcore_gateway' },
						{ name: 'Inline Function', value: 'inline_function' },
						{ name: 'Remote MCP Server', value: 'remote_mcp' },
					],
				},
			],
		},
	],
	description: 'Tools the harness agent can use during invocation',
};
