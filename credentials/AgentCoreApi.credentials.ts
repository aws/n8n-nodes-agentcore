/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';
import { signRequest } from '../nodes/AgentCoreHarness/helpers/sigv4';

export class AgentCoreApi implements ICredentialType {
	name = 'agentCoreApi';

	displayName = 'Amazon Bedrock AgentCore API';

	icon = 'file:agentcore.svg' as const;

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
			displayName: 'OAuth Bearer Token',
			name: 'bearerToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Optional. A JWT from your identity provider, used only when the node Authentication is set to OAuth Bearer Token, to invoke a harness protected by an inbound OAuth authorizer. Stored encrypted and never shown in node input or execution logs. Leave blank for AWS SigV4 authentication. The AWS keys above are still used for all control-plane operations.',
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
				'Comma-separated subnet IDs for VPC mode. The subnets do not need internet access: AgentCore pulls its managed container from a private Amazon ECR repository in the same Region. Create VPC endpoints for Amazon ECR and Amazon S3 (and Amazon Bedrock, if the agent calls it) so those calls resolve inside your VPC.',
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

	// SigV4 cannot be expressed as a static declarative request, so we sign the
	// outgoing request in an `authenticate` function using the same signer the
	// node uses. n8n applies this to both normal requests and the credential
	// test below, so the test request is properly signed (no 403).
	authenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		const region = (credentials.region as string) || 'us-west-2';
		const sessionToken = (credentials.sessionToken as string) || undefined;

		// Resolve the absolute URL n8n will call (baseURL + url).
		const base = (requestOptions.baseURL || '').replace(/\/$/, '');
		const path = requestOptions.url || '';
		const url = /^https?:\/\//.test(path) ? path : `${base}${path}`;

		const body =
			requestOptions.body === undefined
				? ''
				: typeof requestOptions.body === 'string'
					? requestOptions.body
					: JSON.stringify(requestOptions.body);

		const signedHeaders = signRequest(
			{
				method: (requestOptions.method as string) || 'GET',
				url,
				headers: {
					'content-type': 'application/json',
					...((requestOptions.headers as Record<string, string>) || {}),
				},
				body,
			},
			{
				region,
				service: 'bedrock-agentcore',
				credentials: {
					accessKeyId: credentials.accessKeyId as string,
					secretAccessKey: credentials.secretAccessKey as string,
					...(sessionToken ? { sessionToken } : {}),
				},
			},
		);

		requestOptions.headers = { ...(requestOptions.headers || {}), ...signedHeaders };
		// Send the exact bytes we signed. SigV4 binds a hash of the request body
		// into the signature, so the wire body must match the string we hashed
		// above — if we left an object here, the HTTP layer could re-serialize it
		// (key order, whitespace) and invalidate the signature. `json: false`
		// stops the HTTP layer from re-parsing/re-encoding it.
		if (body) {
			requestOptions.body = body;
			requestOptions.json = false;
		}
		return requestOptions;
	};

	// Signed by `authenticate` above; a reachable Region + valid credentials
	// returns 200. This is the credential test n8n runs when a user clicks Test.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '=https://bedrock-agentcore-control.{{$credentials.region}}.amazonaws.com',
			url: '/harnesses?maxResults=1',
			method: 'GET',
		},
	};
}
