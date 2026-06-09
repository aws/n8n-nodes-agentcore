/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { INodeProperties } from 'n8n-workflow';
import { toolsField } from './Common';

/**
 * Single-operation field set for the Amazon Bedrock AgentCore node.
 *
 * The **Harness ARN** field is the mode discriminator:
 *   - blank  -> Run Agent: ListHarnesses -> CreateHarness on miss ->
 *               UpdateHarness on drift -> InvokeHarness, keyed by Agent Name
 *               and cached in workflow static data. ~30s first run, ~3s after.
 *   - filled -> Invoke Existing: InvokeHarness directly against the given ARN.
 *               Every visible config field (Model, System Prompt, Tools, limits,
 *               Actor ID) is applied as a per-invocation override. ~3s.
 *
 * Fields that only make sense when the node owns the harness lifecycle
 * (Agent Name, Memory ARN, Force Recreate) are hidden once an ARN is present.
 */

// Visible only in Run Agent mode (Harness ARN blank).
const RUN_ONLY = { show: { harnessArn: [''] } };

export const harnessFields: INodeProperties[] = [
	{
		displayName: 'Harness ARN',
		name: 'harnessArn',
		type: 'string',
		default: '',
		placeholder: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/MyAgent-abc123',
		description:
			'Leave blank to run an agent the node provisions and reuses for you (keyed by Agent Name). Provide the ARN of a harness created outside n8n (CLI, console, CloudFormation, Terraform) to invoke it directly — in that case the Model, System Prompt, Tools, limits, and Actor ID fields below are applied as per-invocation overrides.',
	},
	{
		displayName: 'Agent Name',
		name: 'agentName',
		type: 'string',
		default: '',
		required: true,
		displayOptions: RUN_ONLY,
		placeholder: 'my_research_agent',
		description:
			'A name for this agent. Letters, numbers, and underscores only (max 40). The harness is created automatically on the first run and reused thereafter — this is the cache key, so renaming creates a new harness. Hidden when a harness ARN is provided.',
	},
	{
		displayName: 'Model ID',
		name: 'modelId',
		type: 'string',
		default: '',
		placeholder: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
		description:
			'Bedrock model ID, e.g. global.anthropic.claude-haiku-4-5-20251001-v1:0 or global.anthropic.claude-sonnet-4-5-20250514-v1:0. In Run Agent mode, defaults to Claude Haiku 4.5 when left blank. When a harness ARN is set, this overrides the harness model for this invocation only — leave blank to use the harness model as-is.',
	},
	{
		displayName: 'System Prompt',
		name: 'systemPrompt',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		description:
			'Instructions that define how the agent behaves. In Run Agent mode, defaults to a generic assistant prompt when left blank. When a harness ARN is set, this overrides the harness system prompt for this invocation only — leave blank to use the harness prompt as-is.',
	},
	{
		displayName: 'Prompt',
		name: 'prompt',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		required: true,
		placeholder: '={{ $json.userMessage }}',
		description: 'The user message to send to the agent',
	},
	{
		...toolsField,
		description:
			'Tools the agent can use. In Run Agent mode these are baked into the harness configuration. When a Harness ARN is set, they override the harness tool list for this invocation only.',
	},
	{
		displayName: 'Session ID',
		name: 'sessionId',
		type: 'string',
		default: '',
		placeholder: '={{ $execution.ID + $json.userId }}',
		description:
			'Optional. Pass the same session ID across invocations to continue a conversation. Must be at least 33 characters. Auto-generated when blank.',
	},
	{
		displayName: 'Additional Options',
		name: 'additionalOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Actor ID',
				name: 'actorId',
				type: 'string',
				default: '',
				description:
					'Identifier for the entity interacting with the agent (used for memory scoping). Recommended when a Memory ARN is set. When a harness ARN is provided, sent as a per-invocation override.',
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
				displayName: 'Timeout (Seconds)',
				name: 'timeoutSeconds',
				type: 'number',
				default: 600,
				description: 'Wall-clock timeout for the entire invocation',
			},
		],
	},
	{
		displayName: 'Provisioning Options',
		name: 'provisioningOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: RUN_ONLY,
		description:
			'Options that apply only when the node owns the harness lifecycle (Harness ARN blank)',
		options: [
			{
				displayName: 'Force Recreate',
				name: 'forceRecreate',
				type: 'boolean',
				default: false,
				description:
					'Whether to delete and recreate the harness instead of updating it. Use only when an update fails or the harness is stuck. Only meaningful when the node owns the lifecycle, so this is hidden when a Harness ARN is provided.',
			},
			{
				displayName: 'Memory ARN (BYO)',
				name: 'memoryArn',
				type: 'string',
				default: '',
				placeholder: 'arn:aws:bedrock-agentcore:us-west-2:...:memory/...',
				description:
					'Optional. Existing AgentCore Memory ARN. v0.1 does not auto-provision memory. Memory is a harness-level setting, not an invoke-time override, so this is hidden when a Harness ARN is provided.',
			},
		],
	},
];
