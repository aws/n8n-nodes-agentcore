/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class AgentCoreApi implements ICredentialType {
	name = 'agentCoreApi';

	displayName = 'AWS Bedrock AgentCore API';

	documentationUrl = 'https://docs.aws.amazon.com/bedrock-agentcore/';

	properties: INodeProperties[] = [
		{
			displayName: 'Access Key ID',
			name: 'accessKeyId',
			type: 'string',
			default: '',
			required: true,
			description: 'AWS access key ID with permissions for Bedrock AgentCore',
		},
		{
			displayName: 'Secret Access Key',
			name: 'secretAccessKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'AWS secret access key',
		},
		{
			displayName: 'Session Token',
			name: 'sessionToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Optional. Required only when using temporary credentials (for example, from STS).',
		},
		{
			displayName: 'Region',
			name: 'region',
			type: 'options',
			options: [
				{ name: 'US East (N. Virginia) - us-east-1', value: 'us-east-1' },
				{ name: 'US West (Oregon) - us-west-2', value: 'us-west-2' },
				{ name: 'Asia Pacific (Sydney) - ap-southeast-2', value: 'ap-southeast-2' },
				{ name: 'Europe (Frankfurt) - eu-central-1', value: 'eu-central-1' },
			],
			default: 'us-west-2',
			required: true,
			description: 'AWS Region where Bedrock AgentCore is available',
		},
		{
			displayName: 'Execution Role ARN',
			name: 'executionRoleArn',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'arn:aws:iam::123456789012:role/HarnessExecutionRole',
			description:
				'IAM role the Harness assumes when running. Must trust the bedrock-agentcore.amazonaws.com service principal. See the README for the trust policy and minimum permissions.',
		},
		{
			displayName: 'Custom Endpoint URL (Advanced)',
			name: 'endpointUrl',
			type: 'string',
			default: '',
			placeholder: 'https://bedrock-agentcore.us-west-2.amazonaws.com',
			description:
				'Optional. Override the AgentCore data plane endpoint. Leave blank for standard AWS SDK resolution. Use this only for preview testing.',
		},
		{
			displayName: 'Custom Control Plane Endpoint URL (Advanced)',
			name: 'controlEndpointUrl',
			type: 'string',
			default: '',
			placeholder: 'https://bedrock-agentcore-control.us-west-2.amazonaws.com',
			description:
				'Optional. Override the AgentCore control plane endpoint. Leave blank for standard AWS SDK resolution. Use this only for preview testing.',
		},
	];
}
