/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * Bearer-token credential for invoking a harness that is protected by an
 * inbound OAuth (JWT) authorizer.
 *
 * The token is held here, in the credential vault, rather than in a node input
 * field. n8n stores credential values encrypted and never renders them in the
 * node UI or the workflow execution log, so a JWT can't leak the way a node
 * parameter can. This is why the previous "Bearer Token" node field was
 * removed: any secret in node input risks exposure in execution data.
 *
 * The token is attached as an `Authorization: Bearer <token>` header on the
 * data-plane InvokeHarness call (see helpers/oauth.ts). This credential does
 * not carry AWS keys; SigV4 control-plane operations use the separate
 * `agentCoreApi` credential.
 */
export class AgentCoreBearerApi implements ICredentialType {
	name = 'agentCoreBearerApi';

	displayName = 'Amazon Bedrock AgentCore Bearer API';

	icon = 'file:agentcore.svg' as const;

	// eslint-disable-next-line n8n-nodes-base/cred-class-field-documentation-url-miscased
	documentationUrl = 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html';

	properties: INodeProperties[] = [
		{
			displayName: 'Bearer Token',
			name: 'bearerToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'JWT issued by your identity provider, used as the Bearer token on the InvokeHarness call. The harness must have an inbound OAuth authorizer configured. Stored encrypted in the credential vault and never shown in node input or execution logs.',
		},
	];
}
