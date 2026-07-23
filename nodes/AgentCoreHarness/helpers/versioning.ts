/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import type { IDataObject } from 'n8n-workflow';
import type { ControlClient } from './controlClient';

/**
 * Thin wrappers around the harness versioning + endpoint control-plane APIs.
 * These power the opt-in "Version & Endpoint" actions on the run path, keeping
 * the node's single-operation design intact.
 *
 * TODO(v0.2-question-9): exposed as opt-in toggles rather than a second
 * resource. See docs/v0.2-questions.md.
 */

export async function listHarnessVersions(
	controlClient: ControlClient,
	harnessId: string,
): Promise<IDataObject[]> {
	const versions: IDataObject[] = [];
	let nextToken: string | undefined;
	do {
		const resp = await controlClient.listHarnessVersions(harnessId, {
			maxResults: 100,
			nextToken,
		});
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
	controlClient: ControlClient,
	harnessId: string,
): Promise<IDataObject[]> {
	const endpoints: IDataObject[] = [];
	let nextToken: string | undefined;
	do {
		const resp = await controlClient.listHarnessEndpoints(harnessId, {
			maxResults: 100,
			nextToken,
		});
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
	controlClient: ControlClient,
	harnessId: string,
	endpointName: string,
	targetVersion: string | undefined,
	description: string | undefined,
): Promise<IDataObject> {
	// Does the endpoint already exist?
	let exists = false;
	let lookupError: unknown;
	try {
		await controlClient.getHarnessEndpoint(harnessId, endpointName);
		exists = true;
	} catch (error) {
		lookupError = error;
	}
	if (lookupError !== undefined) {
		const message = (lookupError as Error).message ?? '';
		// A genuine "not found" means we should create it; anything else is a real error.
		if (!message.includes('ResourceNotFoundException')) throw lookupError;
	}

	if (exists) {
		const resp = await controlClient.updateHarnessEndpoint(harnessId, endpointName, {
			...(targetVersion ? { targetVersion } : {}),
			...(description ? { description } : {}),
		});
		return summarizeEndpoint(resp.endpoint ?? {});
	}

	const resp = await controlClient.createHarnessEndpoint(harnessId, {
		endpointName,
		...(targetVersion ? { targetVersion } : {}),
		...(description ? { description } : {}),
	});
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
