/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { INodeProperties } from 'n8n-workflow';

export const runtimeFields: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Invoke Agent',
				value: 'invoke',
				description: 'Send a request to an AgentCore Runtime agent and receive a response',
				action: 'Invoke an agent core runtime agent',
			},
			{
				name: 'List Runtimes',
				value: 'listRuntimes',
				description: 'List all AgentCore Runtime agents in your account',
				action: 'List agent core runtime agents',
			},
			{
				name: 'Stop Session',
				value: 'stopSession',
				description: 'Stop a running session on an AgentCore Runtime agent',
				action: 'Stop an agent core runtime session',
			},
		],
		default: 'invoke',
	},

	// ── Invoke + Stop Session ─────────────────────────────────────────────────

	{
		displayName: 'Agent Runtime ARN or ID',
		name: 'agentRuntimeArn',
		type: 'string',
		displayOptions: { show: { operation: ['invoke', 'stopSession'] } },
		default: '',
		required: true,
		placeholder: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/myAgent-abc123',
		description:
			'Full ARN or short ID of the AgentCore Runtime agent. You can find this in the AWS console or via List Runtimes.',
	},

	{
		displayName: 'Endpoint Qualifier',
		name: 'qualifier',
		type: 'string',
		displayOptions: { show: { operation: ['invoke', 'stopSession'] } },
		default: 'DEFAULT',
		description:
			'Named endpoint qualifier. Leave as DEFAULT unless you have configured a custom endpoint for this runtime.',
	},

	// ── Invoke-only ───────────────────────────────────────────────────────────

	{
		displayName: 'Session Mode',
		name: 'sessionMode',
		type: 'options',
		displayOptions: { show: { operation: ['invoke'] } },
		options: [
			{
				name: 'Auto (Workflow-Scoped)',
				value: 'auto',
				description:
					'A session ID is generated on first invocation and reused for the life of this workflow. Suitable for single-agent workflows.',
			},
			{
				name: 'Provided',
				value: 'provided',
				description:
					'Use a session ID from an upstream node (e.g. {{ $JSON.sessionId }}). Use this to chain multiple Runtime nodes in one conversation.',
			},
			{
				name: 'New',
				value: 'new',
				description: 'Always start a fresh session. No session ID is persisted.',
			},
		],
		default: 'auto',
		description: 'Controls how the runtime session ID is managed for this invocation',
	},

	{
		displayName: 'Session ID',
		name: 'invokeSessionId',
		type: 'string',
		displayOptions: { show: { operation: ['invoke'], sessionMode: ['provided'] } },
		default: '',
		required: true,
		description:
			'Session ID passed from an upstream AgentCoreRuntime node. Use <code>{{ $JSON.sessionId }}</code> to chain nodes.',
	},

	{
		displayName: 'Payload',
		name: 'payload',
		type: 'json',
		displayOptions: { show: { operation: ['invoke'] } },
		default: '{}',
		description:
			'JSON payload sent to the runtime agent. Supports n8n expressions. Must be valid JSON.',
	},

	{
		displayName: 'Account ID',
		name: 'accountId',
		type: 'string',
		displayOptions: { show: { operation: ['invoke'] } },
		default: '',
		placeholder: '123456789012',
		description:
			'Optional. AWS account ID. Required only when using a short agent ID instead of the full ARN.',
	},

	// ── Stop Session-only ─────────────────────────────────────────────────────

	{
		displayName: 'Session ID',
		name: 'stopSessionId',
		type: 'string',
		displayOptions: { show: { operation: ['stopSession'] } },
		default: '',
		required: true,
		description: 'Session ID to stop. Use the sessionId output from an Invoke Agent node.',
	},
];
