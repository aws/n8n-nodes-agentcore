/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { INodeProperties } from 'n8n-workflow';
import { toolsField } from './Common';

/**
 * Fields for the BYO-ARN "Invoke Existing Harness" operation. For users who
 * deployed their harness via the AgentCore CLI, AWS console, CloudFormation,
 * or Terraform.
 */
export const invokeExistingOperationFields: INodeProperties[] = [
	{
		displayName: 'Harness ARN',
		name: 'harnessArn',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { operation: ['invokeExisting'] } },
		placeholder: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/MyAgent-abc123',
		description: 'ARN of an existing harness',
	},
	{
		displayName: 'Prompt',
		name: 'prompt',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		required: true,
		displayOptions: { show: { operation: ['invokeExisting'] } },
		description: 'The user message to send to the agent',
	},
	{
		displayName: 'Session ID',
		name: 'sessionId',
		type: 'string',
		default: '',
		displayOptions: { show: { operation: ['invokeExisting'] } },
		description:
			'Optional. Must be at least 33 characters. Auto-generated when blank.',
	},
	{
		displayName: 'Per-Invocation Overrides',
		name: 'overrides',
		type: 'collection',
		placeholder: 'Add Override',
		default: {},
		displayOptions: { show: { operation: ['invokeExisting'] } },
		description:
			'Optional. Override harness configuration for this invocation only. Useful for trying different models or tools without redeploying.',
		options: [
			{
				displayName: 'Model ID Override',
				name: 'modelId',
				type: 'string',
				default: '',
				description: 'Override the harness model for this invocation',
			},
			{
				displayName: 'System Prompt Override',
				name: 'systemPrompt',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				description: 'Override the harness system prompt for this invocation',
			},
			{
				...toolsField,
				displayName: 'Tools Override',
				name: 'tools',
				description: 'Override the harness tool list for this invocation',
			},
			{
				displayName: 'Actor ID',
				name: 'actorId',
				type: 'string',
				default: '',
				description: 'Override the actor ID for memory scoping',
			},
			{
				displayName: 'Max Iterations',
				name: 'maxIterations',
				type: 'number',
				default: 50,
			},
			{
				displayName: 'Max Tokens',
				name: 'maxTokens',
				type: 'number',
				default: 4096,
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeoutSeconds',
				type: 'number',
				default: 600,
			},
		],
	},
];
