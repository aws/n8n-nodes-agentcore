/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';
import type { ControlClient } from './controlClient';

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

export interface CredentialVpcConfig {
	networkMode: 'PUBLIC' | 'VPC';
	subnets: string[];
	securityGroups: string[];
}

/**
 * Reads the VPC fields off the credential. Returns undefined when network mode
 * is Public (the default), so the caller omits networkConfiguration entirely.
 */
export function getVpcConfig(
	creds: ICredentialDataDecryptedObject,
): CredentialVpcConfig | undefined {
	const networkMode = (creds.networkMode as string) === 'VPC' ? 'VPC' : 'PUBLIC';
	if (networkMode !== 'VPC') return undefined;
	return {
		networkMode: 'VPC',
		subnets: splitList(creds.subnetIds as string | undefined),
		securityGroups: splitList(creds.securityGroupIds as string | undefined),
	};
}

function splitList(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Polls GetHarness until READY or a terminal failure state.
 * Default timeout 600 seconds (10 min): public harnesses are ready in ~30s, but
 * VPC harnesses take materially longer — AWS provisions network interfaces in
 * your subnets and pulls the container from public.ecr.aws through your NAT,
 * which can exceed several minutes. A short timeout surfaced a misleading
 * "did not reach READY" error on VPC harnesses that were in fact still creating
 * (and did become READY shortly after).
 */
export async function waitForHarnessReady(
	controlClient: ControlClient,
	harnessId: string,
	timeoutMs: number = 600_000,
): Promise<{ status: string; failureReason?: string }> {
	const startedAt = Date.now();
	const pollInterval = 3_000;

	while (Date.now() - startedAt < timeoutMs) {
		const response = await controlClient.getHarness(harnessId);
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

		await sleep(pollInterval);
	}

	throw new Error(`Harness ${harnessId} did not reach READY within ${timeoutMs}ms`);
}
