/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { IDataObject } from 'n8n-workflow';

/**
 * Thin wrappers around the harness versioning + endpoint control-plane APIs
 * (added to the SDK in 3.1071.0). These power the opt-in "Version & Endpoint"
 * actions on the run path, keeping the node's single-operation design intact.
 *
 * TODO(v0.2-question-9): exposed as opt-in toggles rather than a second
 * resource. See docs/v0.2-questions.md.
 */

export async function listHarnessVersions(
	controlClient: any,
	harnessId: string,
): Promise<IDataObject[]> {
	const { ListHarnessVersionsCommand } = await import('@aws-sdk/client-bedrock-agentcore-control');
	const versions: IDataObject[] = [];
	let nextToken: string | undefined;
	do {
		const resp = await controlClient.send(
			new ListHarnessVersionsCommand({
				harnessId,
				maxResults: 100,
				...(nextToken ? { nextToken } : {}),
			}),
		);
		for (const v of resp.harnessVersions ?? []) {
			versions.push({
				harnessVersion: v.harnessVersion,
				status: v.status,
				createdAt: v.createdAt,
				updatedAt: v.updatedAt,
				failureReason: v.failureReason,
			});
		}
		nextToken = resp.nextToken;
	} while (nextToken);
	return versions;
}

export async function listHarnessEndpoints(
	controlClient: any,
	harnessId: string,
): Promise<IDataObject[]> {
	const { ListHarnessEndpointsCommand } = await import('@aws-sdk/client-bedrock-agentcore-control');
	const endpoints: IDataObject[] = [];
	let nextToken: string | undefined;
	do {
		const resp = await controlClient.send(
			new ListHarnessEndpointsCommand({
				harnessId,
				maxResults: 100,
				...(nextToken ? { nextToken } : {}),
			}),
		);
		for (const e of resp.endpoints ?? []) {
			endpoints.push(summarizeEndpoint(e));
		}
		nextToken = resp.nextToken;
	} while (nextToken);
	return endpoints;
}

/**
 * Creates a named endpoint, or updates it to a new target version if it already
 * exists. Idempotent so re-running the same workflow doesn't fail on
 * ConflictException.
 */
export async function upsertHarnessEndpoint(
	controlClient: any,
	harnessId: string,
	endpointName: string,
	targetVersion: string | undefined,
	description: string | undefined,
): Promise<IDataObject> {
	const { CreateHarnessEndpointCommand, UpdateHarnessEndpointCommand, GetHarnessEndpointCommand } =
		await import('@aws-sdk/client-bedrock-agentcore-control');

	// Does the endpoint already exist?
	let exists = false;
	try {
		await controlClient.send(new GetHarnessEndpointCommand({ harnessId, endpointName }));
		exists = true;
	} catch (error) {
		const name = (error as { name?: string }).name ?? '';
		if (name !== 'ResourceNotFoundException') throw error;
	}

	if (exists) {
		const resp = await controlClient.send(
			new UpdateHarnessEndpointCommand({
				harnessId,
				endpointName,
				...(targetVersion ? { targetVersion } : {}),
				...(description ? { description } : {}),
			}),
		);
		return summarizeEndpoint(resp.endpoint ?? {});
	}

	const resp = await controlClient.send(
		new CreateHarnessEndpointCommand({
			harnessId,
			endpointName,
			...(targetVersion ? { targetVersion } : {}),
			...(description ? { description } : {}),
		}),
	);
	return summarizeEndpoint(resp.endpoint ?? {});
}

function summarizeEndpoint(e: IDataObject): IDataObject {
	return {
		endpointName: e.endpointName,
		status: e.status,
		targetVersion: e.targetVersion,
		liveVersion: e.liveVersion,
		arn: e.arn,
		description: e.description,
		failureReason: e.failureReason,
	};
}
