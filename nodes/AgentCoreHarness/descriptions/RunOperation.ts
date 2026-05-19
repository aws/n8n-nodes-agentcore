/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { INodeProperties } from 'n8n-workflow';
import { toolsField } from './Common';

/**
 * Fields for the primary "Run Agent" operation. This is the operation the
 * vast majority of n8n users will use. The node auto-provisions a harness
 * on first run, reuses it thereafter, and updates it when configuration drifts.
 *
 * Power users can switch to "Invoke Existing Harness" to bring their own ARN.
 */
export const runOperationFields: INodeProperties[] = [
	{
		displayName: 'Agent Name',
		name: 'agentName',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { operation: ['run'] } },
		placeholder: 'my_research_agent',
		description:
			'A name for this agent. Letters, numbers, and underscores only. The harness is created automatically on the first run and reused thereafter.',
	},
	{
		displayName: 'Model ID',
		name: 'modelId',
		type: 'string',
		default: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
		required: true,
		displayOptions: { show: { operation: ['run'] } },
		description:
			'Bedrock model ID. For example, global.anthropic.claude-haiku-4-5-20251001-v1:0 or global.anthropic.claude-sonnet-4-5-20250514-v1:0.',
	},
	{
		displayName: 'System Prompt',
		name: 'systemPrompt',
		type: 'string',
		typeOptions: { rows: 4 },
		default: 'You are a helpful AI assistant.',
		displayOptions: { show: { operation: ['run'] } },
		description: 'Instructions that define how the agent behaves',
	},
	{
		displayName: 'Prompt',
		name: 'prompt',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		required: true,
		displayOptions: { show: { operation: ['run'] } },
		placeholder: '={{ $json.userMessage }}',
		description: 'The user message to send to the agent',
	},
	{
		...toolsField,
		displayOptions: { show: { operation: ['run'] } },
	},
	{
		displayName: 'Session ID',
		name: 'sessionId',
		type: 'string',
		default: '',
		displayOptions: { show: { operation: ['run'] } },
		placeholder: '={{ $execution.ID + $json.userId }}',
		description:
			'Optional. Pass the same session ID across multiple invocations to continue a conversation. Must be at least 33 characters. Auto-generated when blank.',
	},
	{
		displayName: 'Additional Options',
		name: 'additionalOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { operation: ['run'] } },
		options: [
			{
				displayName: 'Actor ID',
				name: 'actorId',
				type: 'string',
				default: '',
				description:
					'Identifier for the entity interacting with the agent (used for memory scoping). Recommended when Memory ARN is set.',
			},
			{
				displayName: 'Force Recreate',
				name: 'forceRecreate',
				type: 'boolean',
				default: false,
				description:
					'Whether to delete and recreate the harness instead of updating it. Use only when an update fails or the harness is in a stuck state.',
			},
			{
				displayName: 'Max Iterations',
				name: 'maxIterations',
				type: 'number',
				default: 50,
				description: 'Maximum think-act-observe cycles per invocation',
			},
			{
				displayName: 'Max Tokens',
				name: 'maxTokens',
				type: 'number',
				default: 4096,
				description: 'Maximum output tokens per invocation',
			},
			{
				displayName: 'Memory ARN (BYO)',
				name: 'memoryArn',
				type: 'string',
				default: '',
				placeholder: 'arn:aws:bedrock-agentcore:us-west-2:...:memory/...',
				description: 'Optional. Existing AgentCore Memory ARN. v1 does not auto-provision memory.',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeoutSeconds',
				type: 'number',
				default: 600,
				description: 'Wall-clock timeout for the entire invocation',
			},
		],
	},
];
