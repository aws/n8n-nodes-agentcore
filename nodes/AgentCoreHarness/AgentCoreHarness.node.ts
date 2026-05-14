/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import { createHash, randomUUID } from 'crypto';

import { runOperationFields } from './descriptions/RunOperation';
import { invokeExistingOperationFields } from './descriptions/InvokeExistingOperation';
import { buildToolsArray, configHash, type ToolConfig } from './helpers/tools';
import {
	getAwsCredentials,
	getControlEndpoint,
	getDataEndpoint,
	getExecutionRoleArn,
	getRegion,
	waitForHarnessReady,
} from './helpers/client';
import { consumeStream } from './helpers/stream';

/**
 * Static-data shape per workflow.
 *   harnesses[<agentName>] = { harnessId, arn, configHash }
 * One agent name maps to exactly one harness. Renaming the agent in the node
 * config creates a new harness (and orphans the old one until the user deletes it).
 */
interface HarnessRecord {
	harnessId: string;
	arn: string;
	configHash: string;
}
interface NodeStaticData {
	harnesses?: Record<string, HarnessRecord>;
}

export class AgentCoreHarness implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AWS Bedrock AgentCore',
		name: 'agentCoreHarness',
		icon: 'file:agentcore.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Run AI agents on Amazon Bedrock AgentCore Harness. Auto-provisions and reuses harnesses across executions.',
		defaults: {
			name: 'Amazon Bedrock AgentCore',
		},
		codex: {
			categories: ['AI', 'AWS', 'Development'],
			subcategories: {
				AI: ['Agents'],
				AWS: ['Bedrock'],
			},
			alias: ['agent', 'bedrock', 'agentcore', 'aws', 'llm', 'claude', 'anthropic'],
			resources: {
				primaryDocumentation: [
					{ url: 'https://github.com/aws/n8n-nodes-agentcore' },
				],
			},
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'agentCoreApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'run',
				options: [
					{
						name: 'Run Agent',
						value: 'run',
						description:
							'Run an agent. Auto-provisions the harness on first execution and reuses it thereafter.',
						action: 'Run an agent',
					},
					{
						name: 'Invoke Existing Harness',
						value: 'invokeExisting',
						description:
							'Invoke a harness deployed outside n8n (CLI, console, CloudFormation, etc.)',
						action: 'Invoke an existing harness',
					},
				],
			},
			...runOperationFields,
			...invokeExistingOperationFields,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const creds = await this.getCredentials('agentCoreApi');
		const region = getRegion(creds);
		const awsCreds = getAwsCredentials(creds);
		const dataEndpoint = getDataEndpoint(creds);
		const controlEndpoint = getControlEndpoint(creds);

		const {
			BedrockAgentCoreControlClient,
			CreateHarnessCommand,
			UpdateHarnessCommand,
			GetHarnessCommand,
			ListHarnessesCommand,
		} = await import('@aws-sdk/client-bedrock-agentcore-control');
		const { BedrockAgentCoreClient, InvokeHarnessCommand } = await import(
			'@aws-sdk/client-bedrock-agentcore'
		);

		const controlClient = new BedrockAgentCoreControlClient({
			region,
			credentials: awsCreds,
			...(controlEndpoint ? { endpoint: controlEndpoint } : {}),
		});
		const dataClient = new BedrockAgentCoreClient({
			region,
			credentials: awsCreds,
			...(dataEndpoint ? { endpoint: dataEndpoint } : {}),
		});

		const staticData = this.getWorkflowStaticData('node') as NodeStaticData;
		if (!staticData.harnesses) {
			staticData.harnesses = {};
		}

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;

				if (operation === 'run') {
					const result = await runAgent(this, itemIndex, creds, controlClient, dataClient, {
						CreateHarnessCommand,
						UpdateHarnessCommand,
						InvokeHarnessCommand,
						GetHarnessCommand,
						ListHarnessesCommand,
					}, staticData);
					returnData.push({ json: result, pairedItem: { item: itemIndex } });
				} else if (operation === 'invokeExisting') {
					const result = await invokeExisting(this, itemIndex, dataClient, InvokeHarnessCommand);
					returnData.push({ json: result, pairedItem: { item: itemIndex } });
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
						itemIndex,
					});
				}
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

/* ----- top-level helpers (kept outside the class to keep `this` typing simple) ----- */

interface SdkCommands {
	CreateHarnessCommand: any;
	UpdateHarnessCommand: any;
	InvokeHarnessCommand: any;
	GetHarnessCommand: any;
	ListHarnessesCommand: any;
}

/**
 * "Run Agent" operation. Creates the harness on first run, reuses it on
 * subsequent runs, updates it when the configuration drifts.
 */
async function runAgent(
	ctx: IExecuteFunctions,
	itemIndex: number,
	creds: any,
	controlClient: any,
	dataClient: any,
	commands: SdkCommands,
	staticData: NodeStaticData,
): Promise<IDataObject> {
	const agentName = ctx.getNodeParameter('agentName', itemIndex) as string;
	validateAgentName(agentName);

	const modelId = ctx.getNodeParameter('modelId', itemIndex) as string;
	const systemPrompt = ctx.getNodeParameter('systemPrompt', itemIndex) as string;
	const prompt = ctx.getNodeParameter('prompt', itemIndex) as string;
	const toolsUi = ctx.getNodeParameter('tools', itemIndex, {}) as IDataObject;
	const additional = ctx.getNodeParameter('additionalOptions', itemIndex, {}) as IDataObject;

	const tools = buildToolsArray(toolsUi);
	const maxIterations = additional.maxIterations as number | undefined;
	const maxTokens = additional.maxTokens as number | undefined;
	const timeoutSeconds = additional.timeoutSeconds as number | undefined;
	const memoryArn = (additional.memoryArn as string) || '';
	const actorId = (additional.actorId as string) || '';
	const forceRecreate = (additional.forceRecreate as boolean) || false;

	const executionRoleArn = getExecutionRoleArn(creds);
	if (!executionRoleArn) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Execution Role ARN is required. Configure it on the AWS Bedrock AgentCore credential.',
			{ itemIndex },
		);
	}

	const desiredHash = configHash({
		modelId,
		systemPrompt,
		tools,
		maxIterations,
		maxTokens,
		timeoutSeconds,
	});

	// Resolve harness: existing match, drift-update, or create.
	let record = staticData.harnesses![agentName];

	if (forceRecreate) {
		// Tear down our local cache and try to delete the remote harness so
		// CreateHarness won't collide on the unique-name constraint.
		delete staticData.harnesses![agentName];
		record = undefined as any;

		const existing = await resolveExistingHarness(controlClient, commands, agentName);
		if (existing) {
			const { DeleteHarnessCommand } = await import(
				'@aws-sdk/client-bedrock-agentcore-control'
			);
			try {
				await controlClient.send(
					new DeleteHarnessCommand({ harnessId: existing.harnessId }),
				);
			} catch {
				// best-effort; fall through to create and let AWS surface any real error
			}
		}
	}

	// AWS is the source of truth. If static data is missing or stale, look up
	// the harness by agent name. This survives: workflow copies, n8n restarts,
	// test-execution static-data loss, and users deleting .n8n/database.sqlite.
	if (!record) {
		const existing = await resolveExistingHarness(controlClient, commands, agentName);
		if (existing) {
			if (existing.status === 'READY') {
				// Adopt the live harness. We don't know its stored config hash,
				// so we force a drift check by setting configHash to empty. That
				// triggers UpdateHarness below if desiredHash != '', which is
				// always true. This is the correct behavior when adopting a
				// harness that may have been created outside this node.
				record = {
					harnessId: existing.harnessId,
					arn: existing.arn,
					configHash: '',
				};
				staticData.harnesses![agentName] = record;
			} else if (
				existing.status === 'CREATE_FAILED' ||
				existing.status === 'UPDATE_FAILED' ||
				existing.status === 'DELETE_FAILED'
			) {
				throw new NodeOperationError(
					ctx.getNode(),
					`Harness "${existing.harnessId}" for agent "${agentName}" is in terminal state ${existing.status}. ` +
						`Enable "Force Recreate" in Additional Options, or delete the harness manually with: ` +
						`aws bedrock-agentcore-control delete-harness --harness-id ${existing.harnessId}`,
					{ itemIndex },
				);
			} else {
				// CREATING / UPDATING — wait for it to settle.
				const ready = await waitForHarnessReady(controlClient, existing.harnessId);
				if (ready.status !== 'READY') {
					throw new NodeOperationError(
						ctx.getNode(),
						`Harness ${existing.harnessId} reached terminal state ${ready.status}: ${ready.failureReason}`,
						{ itemIndex },
					);
				}
				record = {
					harnessId: existing.harnessId,
					arn: existing.arn,
					configHash: '',
				};
				staticData.harnesses![agentName] = record;
			}
		}
	}

	if (!record) {
		record = await createHarness(
			controlClient,
			commands.CreateHarnessCommand,
			agentName,
			executionRoleArn,
			modelId,
			systemPrompt,
			tools,
			maxIterations,
			maxTokens,
			timeoutSeconds,
			memoryArn,
			actorId,
			desiredHash,
		);
		staticData.harnesses![agentName] = record;
	} else if (record.configHash !== desiredHash) {
		record = await updateHarness(
			controlClient,
			commands.UpdateHarnessCommand,
			record.harnessId,
			record.arn,
			modelId,
			systemPrompt,
			tools,
			maxIterations,
			maxTokens,
			timeoutSeconds,
			memoryArn,
			actorId,
			desiredHash,
		);
		staticData.harnesses![agentName] = record;
	}

	const sessionId = resolveSessionId(ctx.getNodeParameter('sessionId', itemIndex, '') as string);

	const invokePayload = buildInvokePayload({
		harnessArn: record.arn,
		runtimeSessionId: sessionId,
		prompt,
		modelId,
		memoryArn,
		actorId,
		maxIterations,
		maxTokens,
		timeoutSeconds,
	});

	const response = await dataClient.send(new commands.InvokeHarnessCommand(invokePayload));
	const stream = (response as any).stream;
	if (!stream) {
		throw new NodeOperationError(ctx.getNode(), 'InvokeHarness returned no stream', {
			itemIndex,
		});
	}
	const result = await consumeStream(stream);

	return {
		operation: 'run',
		agentName,
		harnessId: record.harnessId,
		harnessArn: record.arn,
		sessionId,
		response: result.text,
		stopReason: result.stopReason,
		toolUses: result.toolUses,
		usage: result.usage,
		latencyMs: result.latencyMs,
	};
}

/**
 * "Invoke Existing Harness" operation. BYO-ARN escape hatch.
 */
async function invokeExisting(
	ctx: IExecuteFunctions,
	itemIndex: number,
	dataClient: any,
	InvokeHarnessCommand: any,
): Promise<IDataObject> {
	const harnessArn = ctx.getNodeParameter('harnessArn', itemIndex) as string;
	const prompt = ctx.getNodeParameter('prompt', itemIndex) as string;
	const overrides = ctx.getNodeParameter('overrides', itemIndex, {}) as IDataObject;

	const sessionId = resolveSessionId(ctx.getNodeParameter('sessionId', itemIndex, '') as string);

	const overrideTools = overrides.tools
		? buildToolsArray(overrides.tools as IDataObject)
		: undefined;

	const invokePayload = buildInvokePayload({
		harnessArn,
		runtimeSessionId: sessionId,
		prompt,
		modelId: (overrides.modelId as string) || undefined,
		systemPrompt: (overrides.systemPrompt as string) || undefined,
		tools: overrideTools,
		actorId: (overrides.actorId as string) || undefined,
		maxIterations: overrides.maxIterations as number | undefined,
		maxTokens: overrides.maxTokens as number | undefined,
		timeoutSeconds: overrides.timeoutSeconds as number | undefined,
	});

	const response = await dataClient.send(new InvokeHarnessCommand(invokePayload));
	const stream = (response as any).stream;
	if (!stream) {
		throw new NodeOperationError(ctx.getNode(), 'InvokeHarness returned no stream', {
			itemIndex,
		});
	}
	const result = await consumeStream(stream);

	return {
		operation: 'invokeExisting',
		harnessArn,
		sessionId,
		response: result.text,
		stopReason: result.stopReason,
		toolUses: result.toolUses,
		usage: result.usage,
		latencyMs: result.latencyMs,
	};
}

function validateAgentName(name: string): void {
	if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)) {
		throw new Error(
			`Invalid agent name: "${name}". Must start with a letter and contain only letters, numbers, and underscores (max 40 chars).`,
		);
	}
}

/**
 * Resolves an existing harness for the given agent name by querying AWS.
 * This is the source of truth. Workflow static data is used as a fast-path
 * cache but its absence or staleness must never cause a CreateHarness call
 * when the harness already exists in the AWS account.
 *
 * Returns the live record if found and READY; null otherwise.
 * Throws if an unexpected state is encountered (e.g. CREATE_FAILED).
 */
async function resolveExistingHarness(
	controlClient: any,
	commands: SdkCommands,
	agentName: string,
): Promise<{ harnessId: string; arn: string; status: string } | null> {
	// List harnesses; paginate until we find one with a matching name prefix.
	// AgentCore suffixes a random 10-char ID to the user-supplied agent name,
	// so we match on `harnessName === agentName` OR `harnessName startsWith agentName-`.
	let nextToken: string | undefined;
	do {
		const resp = await controlClient.send(
			new commands.ListHarnessesCommand({
				maxResults: 100,
				...(nextToken ? { nextToken } : {}),
			}),
		);
		const summaries = resp.harnessSummaries ?? resp.harnesses ?? resp.items ?? [];
		const match = summaries.find((h: any) => {
			const name = h.harnessName ?? h.name ?? h.harnessId ?? '';
			return name === agentName || name.startsWith(agentName + '-');
		});
		if (match) {
			// Hydrate with full details so callers can check drift or readiness.
			const detail = await controlClient.send(
				new commands.GetHarnessCommand({ harnessId: match.harnessId }),
			);
			const h = detail.harness ?? {};
			return {
				harnessId: h.harnessId,
				arn: h.arn,
				status: h.status ?? 'UNKNOWN',
			};
		}
		nextToken = resp.nextToken;
	} while (nextToken);

	return null;
}

function resolveSessionId(input: string): string {
	if (!input) {
		// runtimeSessionId requires >= 33 chars; UUIDs are 36.
		return randomUUID();
	}

	// Sanitize: AgentCore runtimeSessionId is restricted to [A-Za-z0-9_-].
	// Replace disallowed characters with '_' rather than dropping them, so
	// logically distinct inputs stay distinct after sanitization.
	const sanitized = input.replace(/[^A-Za-z0-9_-]/g, '_');

	if (sanitized.length >= 33) {
		// Cap at 128 to stay well under any API limit while allowing long
		// composite IDs like "{customerId}-{threadId}".
		return sanitized.slice(0, 128);
	}

	// Deterministically extend short inputs so that the same logical key
	// (e.g. customer-thread) maps to the same session across executions.
	// SHA-256 over the sanitized input is stable and collision-resistant.
	const hash = createHash('sha256').update(sanitized).digest('hex').slice(0, 40);
	return `${sanitized}-${hash}`.slice(0, 128);
}

async function createHarness(
	controlClient: any,
	CreateHarnessCommand: any,
	agentName: string,
	executionRoleArn: string,
	modelId: string,
	systemPrompt: string,
	tools: ToolConfig[],
	maxIterations: number | undefined,
	maxTokens: number | undefined,
	timeoutSeconds: number | undefined,
	memoryArn: string,
	actorId: string,
	desiredHash: string,
): Promise<HarnessRecord> {
	const payload: IDataObject = {
		harnessName: agentName,
		executionRoleArn,
		model: { bedrockModelConfig: { modelId } },
		systemPrompt: [{ text: systemPrompt }],
	};
	if (tools.length > 0) payload.tools = tools;
	if (maxIterations !== undefined) payload.maxIterations = maxIterations;
	if (maxTokens !== undefined) payload.maxTokens = maxTokens;
	if (timeoutSeconds !== undefined) payload.timeoutSeconds = timeoutSeconds;
	if (memoryArn) {
		payload.memory = { arn: memoryArn, ...(actorId ? { actorId } : {}) };
	}

	const response = await controlClient.send(new CreateHarnessCommand(payload));
	const harness = response.harness ?? {};
	if (!harness.harnessId || !harness.arn) {
		throw new Error('CreateHarness did not return harnessId and arn');
	}

	const ready = await waitForHarnessReady(controlClient, harness.harnessId);
	if (ready.status !== 'READY') {
		throw new Error(
			`Harness ${harness.harnessId} reached terminal state ${ready.status}: ${ready.failureReason}`,
		);
	}

	return {
		harnessId: harness.harnessId,
		arn: harness.arn,
		configHash: desiredHash,
	};
}

async function updateHarness(
	controlClient: any,
	UpdateHarnessCommand: any,
	harnessId: string,
	arn: string,
	modelId: string,
	systemPrompt: string,
	tools: ToolConfig[],
	maxIterations: number | undefined,
	maxTokens: number | undefined,
	timeoutSeconds: number | undefined,
	memoryArn: string,
	actorId: string,
	desiredHash: string,
): Promise<HarnessRecord> {
	const payload: IDataObject = {
		harnessId,
		model: { bedrockModelConfig: { modelId } },
		systemPrompt: [{ text: systemPrompt }],
	};
	if (tools.length > 0) payload.tools = tools;
	if (maxIterations !== undefined) payload.maxIterations = maxIterations;
	if (maxTokens !== undefined) payload.maxTokens = maxTokens;
	if (timeoutSeconds !== undefined) payload.timeoutSeconds = timeoutSeconds;
	if (memoryArn) {
		payload.memory = { arn: memoryArn, ...(actorId ? { actorId } : {}) };
	}

	await controlClient.send(new UpdateHarnessCommand(payload));

	const ready = await waitForHarnessReady(controlClient, harnessId);
	if (ready.status !== 'READY') {
		throw new Error(
			`Harness ${harnessId} update reached terminal state ${ready.status}: ${ready.failureReason}`,
		);
	}

	return { harnessId, arn, configHash: desiredHash };
}

interface InvokePayloadInput {
	harnessArn: string;
	runtimeSessionId: string;
	prompt: string;
	modelId?: string;
	systemPrompt?: string;
	tools?: ToolConfig[];
	memoryArn?: string;
	actorId?: string;
	maxIterations?: number;
	maxTokens?: number;
	timeoutSeconds?: number;
}

function buildInvokePayload(input: InvokePayloadInput): IDataObject {
	const payload: IDataObject = {
		harnessArn: input.harnessArn,
		runtimeSessionId: input.runtimeSessionId,
		messages: [
			{
				role: 'user',
				content: [{ text: input.prompt }],
			},
		],
	};

	if (input.modelId) {
		payload.model = { bedrockModelConfig: { modelId: input.modelId } };
	}
	if (input.systemPrompt) {
		payload.systemPrompt = [{ text: input.systemPrompt }];
	}
	if (input.tools && input.tools.length > 0) {
		payload.tools = input.tools;
	}
	if (input.memoryArn) {
		payload.memory = {
			arn: input.memoryArn,
			...(input.actorId ? { actorId: input.actorId } : {}),
		};
	}
	if (input.maxIterations !== undefined) payload.maxIterations = input.maxIterations;
	if (input.maxTokens !== undefined) payload.maxTokens = input.maxTokens;
	if (input.timeoutSeconds !== undefined) payload.timeoutSeconds = input.timeoutSeconds;

	return payload;
}
