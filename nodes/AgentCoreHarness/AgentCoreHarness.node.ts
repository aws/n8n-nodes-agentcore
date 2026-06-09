/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
	ApplicationError,
	type ICredentialDataDecryptedObject,
	type ICredentialTestFunctions,
	type ICredentialsDecrypted,
	type IDataObject,
	type IExecuteFunctions,
	type INodeCredentialTestResult,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

import { createHash, randomUUID } from 'crypto';

import { harnessFields } from './descriptions/HarnessFields';
import { buildToolsArray, configHash, type ToolConfig } from './helpers/tools';
import {
	getAwsCredentials,
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

// Run-mode fallbacks. The merged field set defaults model/system prompt to
// empty so that, in ARN/invoke mode, a blank field sends no override. Run mode
// applies these defaults in code instead, preserving the prior behavior.
const DEFAULT_MODEL_ID = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant.';

export class AgentCoreHarness implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Amazon Bedrock AgentCore',
		name: 'agentCoreHarness',
		icon: 'file:agentcore.svg',
		group: ['transform'],
		version: 1,
		subtitle:
			'={{ $parameter["harnessArn"] ? "Invoke Existing Harness" : ("Run Agent" + ($parameter["agentName"] ? ": " + $parameter["agentName"] : "")) }}',
		description:
			'Run AI agents on Amazon Bedrock AgentCore harness. Auto-provisions and reuses harnesses across executions.',
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
				primaryDocumentation: [{ url: 'https://github.com/aws/n8n-nodes-agentcore' }],
			},
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'agentCoreApi',
				required: true,
				testedBy: 'agentCoreApiTest',
			},
		],
		properties: [...harnessFields],
	};

	// Validates credentials when the user clicks "Test" in the n8n credential UI.
	// Reuses the same helpers as execute() to ensure the test path mirrors runtime behavior.
	methods = {
		credentialTest: {
			async agentCoreApiTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
			): Promise<INodeCredentialTestResult> {
				try {
					const creds = credential.data!;
					const region = getRegion(creds);
					const awsCreds = getAwsCredentials(creds);

					const { BedrockAgentCoreControlClient, ListHarnessesCommand } =
						await import('@aws-sdk/client-bedrock-agentcore-control');

					const client = new BedrockAgentCoreControlClient({
						region,
						credentials: awsCreds,
					});

					await client.send(new ListHarnessesCommand({ maxResults: 1 }));
					return { status: 'OK', message: 'Connection successful' };
				} catch (error) {
					return { status: 'Error', message: (error as Error).message };
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const creds = await this.getCredentials('agentCoreApi');
		const region = getRegion(creds);
		const awsCreds = getAwsCredentials(creds);

		const {
			BedrockAgentCoreControlClient,
			CreateHarnessCommand,
			UpdateHarnessCommand,
			GetHarnessCommand,
			ListHarnessesCommand,
		} = await import('@aws-sdk/client-bedrock-agentcore-control');
		const { BedrockAgentCoreClient, InvokeHarnessCommand } =
			await import('@aws-sdk/client-bedrock-agentcore');

		const controlClient = new BedrockAgentCoreControlClient({
			region,
			credentials: awsCreds,
		});
		const dataClient = new BedrockAgentCoreClient({
			region,
			credentials: awsCreds,
		});

		const staticData = this.getWorkflowStaticData('node') as NodeStaticData;
		if (!staticData.harnesses) {
			staticData.harnesses = {};
		}

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				// Harness ARN is the mode discriminator: blank -> auto-provision and
				// reuse (Run Agent); populated -> invoke that harness directly, with
				// the config fields applied as per-invocation overrides.
				const harnessArn = (
					this.getNodeParameter('harnessArn', itemIndex, '') as string
				).trim();

				let result: IDataObject;
				if (harnessArn) {
					result = await invokeExisting(this, itemIndex, dataClient, InvokeHarnessCommand);
				} else {
					result = await runAgent(
						this,
						itemIndex,
						creds,
						controlClient,
						dataClient,
						{
							CreateHarnessCommand,
							UpdateHarnessCommand,
							InvokeHarnessCommand,
							GetHarnessCommand,
							ListHarnessesCommand,
						},
						staticData,
					);
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

	// Model and system prompt default to empty at the field level (so invoke mode
	// sends no override when blank); run mode applies the in-code fallbacks here.
	const modelId =
		((ctx.getNodeParameter('modelId', itemIndex, '') as string).trim()) || DEFAULT_MODEL_ID;
	const systemPromptRaw = ctx.getNodeParameter('systemPrompt', itemIndex, '') as string;
	const systemPrompt = systemPromptRaw.trim() ? systemPromptRaw : DEFAULT_SYSTEM_PROMPT;
	const prompt = ctx.getNodeParameter('prompt', itemIndex) as string;
	const toolsUi = ctx.getNodeParameter('tools', itemIndex, {}) as IDataObject;
	const additional = ctx.getNodeParameter('additionalOptions', itemIndex, {}) as IDataObject;
	// memoryArn and forceRecreate live in the run-only "Provisioning Options"
	// collection (hidden when a Harness ARN is provided).
	const provisioning = ctx.getNodeParameter('provisioningOptions', itemIndex, {}) as IDataObject;

	const tools = buildToolsArray(toolsUi);
	const maxIterations = additional.maxIterations as number | undefined;
	const maxTokens = additional.maxTokens as number | undefined;
	const timeoutSeconds = additional.timeoutSeconds as number | undefined;
	const actorId = (additional.actorId as string) || '';
	const memoryArn = (provisioning.memoryArn as string) || '';
	const forceRecreate = (provisioning.forceRecreate as boolean) || false;

	const executionRoleArn = getExecutionRoleArn(creds);
	if (!executionRoleArn) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Execution Role ARN is required. Configure it on the Amazon Bedrock AgentCore credential.',
			{ itemIndex },
		);
	}
	validateExecutionRoleArn(executionRoleArn);

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
			const { DeleteHarnessCommand } = await import('@aws-sdk/client-bedrock-agentcore-control');
			try {
				await controlClient.send(new DeleteHarnessCommand({ harnessId: existing.harnessId }));
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
	const harnessArn = (ctx.getNodeParameter('harnessArn', itemIndex) as string).trim();
	validateHarnessArn(harnessArn);
	const prompt = ctx.getNodeParameter('prompt', itemIndex) as string;

	// In the merged operation the visible config fields ARE the per-invocation
	// overrides. A blank field sends nothing, so the harness config is used as-is.
	const modelId = (ctx.getNodeParameter('modelId', itemIndex, '') as string).trim();
	const systemPrompt = ctx.getNodeParameter('systemPrompt', itemIndex, '') as string;
	const toolsUi = ctx.getNodeParameter('tools', itemIndex, {}) as IDataObject;
	const additional = ctx.getNodeParameter('additionalOptions', itemIndex, {}) as IDataObject;

	const sessionId = resolveSessionId(ctx.getNodeParameter('sessionId', itemIndex, '') as string);

	const overrideTools = buildToolsArray(toolsUi);

	const invokePayload = buildInvokePayload({
		harnessArn,
		runtimeSessionId: sessionId,
		prompt,
		modelId: modelId || undefined,
		systemPrompt: systemPrompt.trim() ? systemPrompt : undefined,
		tools: overrideTools.length > 0 ? overrideTools : undefined,
		actorId: (additional.actorId as string) || undefined,
		maxIterations: additional.maxIterations as number | undefined,
		maxTokens: additional.maxTokens as number | undefined,
		timeoutSeconds: additional.timeoutSeconds as number | undefined,
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
		throw new ApplicationError(
			`Invalid agent name: "${name}". Must start with a letter and contain only letters, numbers, and underscores (max 40 chars).`,
		);
	}
}

function validateHarnessArn(arn: string): void {
	if (!/^arn:aws:bedrock-agentcore:[a-z0-9-]+:\d{12}:harness\/[A-Za-z0-9_-]+$/.test(arn)) {
		throw new ApplicationError(
			`Invalid harness ARN: "${arn}". Expected format: arn:aws:bedrock-agentcore:<region>:<account-id>:harness/<harness-id>`,
		);
	}
}

function validateExecutionRoleArn(arn: string): void {
	if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@\/-]+$/.test(arn)) {
		throw new ApplicationError(
			`Invalid execution role ARN: "${arn}". Expected format: arn:aws:iam::<account-id>:role/<role-name>`,
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
	if (!input) return randomUUID();

	const isValid = /^[A-Za-z0-9_-]+$/.test(input);
	const hash = createHash('sha256').update(input).digest('hex');
	let sessionId: string;

	if (isValid && input.length >= 33) {
		// Valid and meets minimum length — use as-is
		sessionId = input.slice(0, 128);
	} else if (isValid) {
		// Valid but too short — extend deterministically to meet 33-char minimum
		sessionId = `${input}-${hash}`.slice(0, 128);
	} else {
		// Contains invalid characters — sanitize and append hash of original to prevent collisions
		// Truncate sanitized prefix to guarantee full 64-char hash is preserved
		const sanitized = input.replace(/[^A-Za-z0-9_-]/g, '_');
		sessionId = `${sanitized.slice(0, 63)}-${hash}`;
	}

	return sessionId;
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
		payload.memory = {
			agentCoreMemoryConfiguration: {
				arn: memoryArn,
				...(actorId ? { actorId } : {}),
			},
		};
	}

	const response = await controlClient.send(new CreateHarnessCommand(payload));
	const harness = response.harness ?? {};
	if (!harness.harnessId || !harness.arn) {
		throw new ApplicationError('CreateHarness did not return harnessId and arn');
	}

	const ready = await waitForHarnessReady(controlClient, harness.harnessId);
	if (ready.status !== 'READY') {
		throw new ApplicationError(
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
		payload.memory = {
			optionalValue: {
				agentCoreMemoryConfiguration: {
					arn: memoryArn,
					...(actorId ? { actorId } : {}),
				},
			},
		};
	}

	await controlClient.send(new UpdateHarnessCommand(payload));

	const ready = await waitForHarnessReady(controlClient, harnessId);
	if (ready.status !== 'READY') {
		throw new ApplicationError(
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
	if (input.actorId) {
		payload.actorId = input.actorId;
	}
	if (input.maxIterations !== undefined) payload.maxIterations = input.maxIterations;
	if (input.maxTokens !== undefined) payload.maxTokens = input.maxTokens;
	if (input.timeoutSeconds !== undefined) payload.timeoutSeconds = input.timeoutSeconds;

	return payload;
}

