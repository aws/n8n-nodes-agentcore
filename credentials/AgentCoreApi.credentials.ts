/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class AgentCoreApi implements ICredentialType {
	name = 'agentCoreApi';

	displayName = 'Amazon Bedrock AgentCore API';

	// eslint-disable-next-line n8n-nodes-base/cred-class-field-documentation-url-miscased
	documentationUrl = 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html';

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
				'IAM role the harness assumes when running. Must trust the bedrock-agentcore.amazonaws.com service principal. See the README for the trust policy and minimum permissions.',
		},
		{
			displayName: 'Network Mode',
			name: 'networkMode',
			type: 'options',
			options: [
				{ name: 'Public (Default)', value: 'PUBLIC' },
				{ name: 'VPC', value: 'VPC' },
			],
			default: 'PUBLIC',
			description:
				'Network mode for harnesses this credential provisions. Public runs on the AgentCore-managed network. VPC runs the harness in your VPC — required for EFS / S3 Files mounts and private-resource access. Applies only to auto-provisioned harnesses (blank Harness ARN).',
		},
		{
			displayName: 'VPC Subnet IDs',
			name: 'subnetIds',
			type: 'string',
			default: '',
			placeholder: 'subnet-0abc123,subnet-0def456',
			displayOptions: { show: { networkMode: ['VPC'] } },
			description:
				'Comma-separated subnet IDs for VPC mode. The VPC must have a NAT gateway with an internet route (AgentCore pulls its container from public.ecr.aws, which does not support VPC endpoints).',
		},
		{
			displayName: 'VPC Security Group IDs',
			name: 'securityGroupIds',
			type: 'string',
			default: '',
			placeholder: 'sg-0abc123',
			displayOptions: { show: { networkMode: ['VPC'] } },
			description: 'Comma-separated security group IDs for VPC mode',
		},
	];
}
