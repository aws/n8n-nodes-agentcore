/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

/**
 * Resolves AWS credentials from the n8n credential object into the
 * shape expected by the AWS SDK v3 clients.
 */
export function getAwsCredentials(creds: ICredentialDataDecryptedObject) {
	const sessionToken = creds.sessionToken as string | undefined;
	return {
		accessKeyId: creds.accessKeyId as string,
		secretAccessKey: creds.secretAccessKey as string,
		...(sessionToken ? { sessionToken } : {}),
	};
}

export function getRegion(creds: ICredentialDataDecryptedObject): string {
	return (creds.region as string) || 'us-west-2';
}

export function getExecutionRoleArn(creds: ICredentialDataDecryptedObject): string {
	return (creds.executionRoleArn as string) || '';
}

export function getDataEndpoint(creds: ICredentialDataDecryptedObject): string | undefined {
	const url = (creds.endpointUrl as string) || '';
	return url.trim() === '' ? undefined : url.trim();
}

export function getControlEndpoint(creds: ICredentialDataDecryptedObject): string | undefined {
	const url = (creds.controlEndpointUrl as string) || '';
	return url.trim() === '' ? undefined : url.trim();
}

/**
 * Polls GetHarness until READY or a terminal failure state.
 * Default timeout 180 seconds matches typical harness creation time.
 */
export async function waitForHarnessReady(
	controlClient: any,
	harnessId: string,
	timeoutMs: number = 180_000,
): Promise<{ status: string; failureReason?: string }> {
	const { GetHarnessCommand } = await import('@aws-sdk/client-bedrock-agentcore-control');
	const startedAt = Date.now();
	const pollInterval = 3_000;

	while (Date.now() - startedAt < timeoutMs) {
		const response = await controlClient.send(new GetHarnessCommand({ harnessId }));
		const harness = response.harness ?? {};
		const status = harness.status as string | undefined;

		if (status === 'READY') {
			return { status };
		}
		if (status === 'CREATE_FAILED' || status === 'UPDATE_FAILED' || status === 'DELETE_FAILED') {
			return {
				status,
				failureReason: harness.failureReason ?? 'no failure reason provided',
			};
		}

		await new Promise((resolve) => setTimeout(resolve, pollInterval));
	}

	throw new Error(`Harness ${harnessId} did not reach READY within ${timeoutMs}ms`);
}
