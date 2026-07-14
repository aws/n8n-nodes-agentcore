/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

import { randomUUID } from 'crypto';

import { runtimeFields } from './descriptions/RuntimeFields';
import { buildAwsCredentials, getRegion } from '../AgentCoreHarness/helpers/client';

/**
 * Per-workflow static data.
 * sessions[agentRuntimeArn] = sessionId persisted across executions
 * when sessionMode is 'auto'.
 */
interface NodeStaticData {
	sessions?: Record<string, string>;
}

export class AgentCoreRuntime implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Amazon Bedrock AgentCore Runtime',
		name: 'agentCoreRuntime',
		icon: 'file:agentcore-runtime.svg',
		group: ['transform'],
		version: 1,
		subtitle:
			'={{ $parameter["operation"] === "invoke" ? "Invoke: " + ($parameter["agentRuntimeArn"] || "—") : ($parameter["operation"] === "stopSession" ? "Stop Session" : "List Runtimes") }}',
		description:
			'Invoke containerized AgentCore Runtime agents. Supports session management, AssumeRole, and multi-agent chaining.',
		defaults: {
			name: 'AgentCore Runtime',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'agentCoreApi',
				required: true,
			},
		],
		properties: [...runtimeFields],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const creds = await this.getCredentials('agentCoreApi');
		const region = getRegion(creds);
		const awsCreds = await buildAwsCredentials(creds);

		const { BedrockAgentCoreControlClient, ListAgentRuntimesCommand } =
			await import('@aws-sdk/client-bedrock-agentcore-control');
		const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand, StopRuntimeSessionCommand } =
			await import('@aws-sdk/client-bedrock-agentcore');

		const controlClient = new BedrockAgentCoreControlClient({ region, credentials: awsCreds });
		const dataClient = new BedrockAgentCoreClient({ region, credentials: awsCreds });

		const staticData = this.getWorkflowStaticData('node') as NodeStaticData;
		if (!staticData.sessions) staticData.sessions = {};

		const operation = this.getNodeParameter('operation', 0) as string;

		// listRuntimes is not item-scoped — run once and emit all runtimes as rows
		if (operation === 'listRuntimes') {
			try {
				const runtimes = await paginateRuntimes(controlClient, ListAgentRuntimesCommand);
				return [runtimes.map((r) => ({ json: r }))];
			} catch (error) {
				throw new NodeOperationError(this.getNode(), error as Error, {
					message: 'Failed to list AgentCore Runtimes',
				});
			}
		}

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				let result: IDataObject;

				if (operation === 'invoke') {
					result = await invokeAgent(
						this,
						itemIndex,
						dataClient,
						InvokeAgentRuntimeCommand,
						staticData,
					);
				} else if (operation === 'stopSession') {
					result = await stopSession(
						this,
						itemIndex,
						dataClient,
						StopRuntimeSessionCommand,
						staticData,
					);
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
				}

				returnData.push({ json: result, pairedItem: { item: itemIndex } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}

// ── Operation helpers ─────────────────────────────────────────────────────────

async function invokeAgent(
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
	dataClient: InstanceType<any>,
	InvokeAgentRuntimeCommand: any,
	staticData: NodeStaticData,
): Promise<IDataObject> {
	const agentRuntimeArn = (
		executeFunctions.getNodeParameter('agentRuntimeArn', itemIndex, '') as string
	).trim();
	const qualifier =
		(
			(executeFunctions.getNodeParameter('qualifier', itemIndex, 'DEFAULT') as string) || 'DEFAULT'
		).trim() || 'DEFAULT';
	const accountId = (
		executeFunctions.getNodeParameter('accountId', itemIndex, '') as string
	).trim();
	const payloadParam = executeFunctions.getNodeParameter('payload', itemIndex, '{}');

	const sessionMode = executeFunctions.getNodeParameter('sessionMode', itemIndex, 'auto') as string;
	const sessionId = resolveSessionId(
		executeFunctions,
		itemIndex,
		agentRuntimeArn,
		staticData,
		sessionMode,
	);

	const payloadBytes = Buffer.from(
		typeof payloadParam === 'string' ? payloadParam : JSON.stringify(payloadParam),
	);

	const startedAt = Date.now();
	const response = await dataClient.send(
		new InvokeAgentRuntimeCommand({
			agentRuntimeArn,
			qualifier,
			runtimeSessionId: sessionId,
			payload: payloadBytes,
			contentType: 'application/json',
			...(accountId ? { accountId } : {}),
		}),
	);

	const responseText: string = await response.response.transformToString();
	const latencyMs = Date.now() - startedAt;

	// The service may return a session ID that differs from what we sent on
	// the very first call. Always use the returned value going forward.
	const returnedSessionId: string = (response.runtimeSessionId as string | undefined) ?? sessionId;
	if (sessionMode === 'auto') {
		if (!staticData.sessions) staticData.sessions = {};
		staticData.sessions[agentRuntimeArn] = returnedSessionId;
	}

	return {
		agentRuntimeArn,
		sessionId: returnedSessionId,
		sessionSource: sessionMode,
		response: responseText,
		latencyMs,
	};
}

async function stopSession(
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
	dataClient: InstanceType<any>,
	StopRuntimeSessionCommand: any,
	staticData: NodeStaticData,
): Promise<IDataObject> {
	const agentRuntimeArn = (
		executeFunctions.getNodeParameter('agentRuntimeArn', itemIndex, '') as string
	).trim();
	const sessionId = (
		executeFunctions.getNodeParameter('stopSessionId', itemIndex, '') as string
	).trim();
	const qualifier =
		(
			(executeFunctions.getNodeParameter('qualifier', itemIndex, 'DEFAULT') as string) || 'DEFAULT'
		).trim() || 'DEFAULT';

	await dataClient.send(
		new StopRuntimeSessionCommand({
			agentRuntimeArn,
			runtimeSessionId: sessionId,
			qualifier,
		}),
	);

	// Remove from static data so the next auto-mode invoke starts a fresh session
	if (staticData.sessions?.[agentRuntimeArn] === sessionId) {
		delete staticData.sessions[agentRuntimeArn];
	}

	return { stopped: true, sessionId, agentRuntimeArn };
}

async function paginateRuntimes(
	controlClient: InstanceType<any>,
	ListAgentRuntimesCommand: any,
): Promise<IDataObject[]> {
	const runtimes: IDataObject[] = [];
	let nextToken: string | undefined;

	do {
		const resp = await controlClient.send(
			new ListAgentRuntimesCommand({
				maxResults: 100,
				...(nextToken ? { nextToken } : {}),
			}),
		);
		const items: any[] = resp.agentRuntimes ?? [];
		for (const r of items) {
			runtimes.push({
				agentRuntimeId: r.agentRuntimeId,
				agentRuntimeArn: r.agentRuntimeArn,
				agentRuntimeName: r.agentRuntimeName,
				status: r.status,
				description: r.description ?? '',
				lastUpdatedAt: r.lastUpdatedAt,
			});
		}
		nextToken = resp.nextToken as string | undefined;
	} while (nextToken);

	return runtimes;
}

// ── Session resolution ────────────────────────────────────────────────────────

function resolveSessionId(
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
	agentRuntimeArn: string,
	staticData: NodeStaticData,
	sessionMode: string,
): string {
	if (sessionMode === 'provided') {
		return (executeFunctions.getNodeParameter('invokeSessionId', itemIndex, '') as string).trim();
	}

	if (sessionMode === 'new') {
		return randomUUID();
	}

	// auto: reuse the persisted session for this agent, or create one
	if (!staticData.sessions) staticData.sessions = {};
	const existing = staticData.sessions[agentRuntimeArn];
	if (existing) return existing;

	const workflowId = String(executeFunctions.getWorkflow().id ?? 'wf');
	const newId = `wf-${workflowId}-${Date.now()}`;
	staticData.sessions[agentRuntimeArn] = newId;
	return newId;
}
