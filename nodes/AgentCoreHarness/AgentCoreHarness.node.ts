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
import { buildModelConfig, type ModelProvider } from './helpers/model';
import { buildMemoryConfig, buildMemoryUpdate, type MemoryMode } from './helpers/memory';
import {
	buildEnvironment,
	buildEnvironmentArtifact,
	buildEnvironmentArtifactUpdate,
	type FilesystemMount,
} from './helpers/environment';
import { buildSkillsArray } from './helpers/skills';
import { invokeWithBearer } from './helpers/oauth';
import {
	listHarnessVersions,
	listHarnessEndpoints,
	upsertHarnessEndpoint,
} from './helpers/versioning';
import {
	getAwsCredentials,
	getExecutionRoleArn,
	getRegion,
	getVpcConfig,
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
// v0.2: the service default model is Claude Sonnet 4.6 on Bedrock.
const DEFAULT_MODEL_ID = 'global.anthropic.claude-sonnet-4-6';
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant.';

/** Bundle of the model/config field values shared by run + invoke paths. */
interface ResolvedConfig {
	modelConfig?: IDataObject;
	systemPrompt: string;
	tools: ToolConfig[];
	skills: IDataObject[];
	maxIterations?: number;
	maxTokens?: number;
	timeoutSeconds?: number;
	actorId: string;
	qualifier: string;
	runtimeUserId: string;
}

export class AgentCoreHarness implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Amazon Bedrock AgentCore',
		name: 'agentCoreHarness',
		icon: 'file:agentcore.svg',
		group: ['transform'],
		version: 1,
		subtitle:
			'={{ $parameter["harnessArn"] ? "Invoke Existing harness" : ("Run Agent" + ($parameter["agentName"] ? ": " + $parameter["agentName"] : "")) }}',
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
				const harnessArn = (this.getNodeParameter('harnessArn', itemIndex, '') as string).trim();

				let result: IDataObject;
				if (harnessArn) {
					result = await invokeExisting(
						this,
						itemIndex,
						region,
						controlClient,
						dataClient,
						InvokeHarnessCommand,
						GetHarnessCommand,
					);
				} else {
					result = await runAgent(
						this,
						itemIndex,
						creds,
						region,
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
 * Reads the model / tools / skills / limits fields shared by run and invoke.
 * `applyDefaults` substitutes the run-mode model/system-prompt fallbacks; in
 * invoke mode a blank field stays blank so no override is sent.
 */
function resolveConfig(
	ctx: IExecuteFunctions,
	itemIndex: number,
	applyDefaults: boolean,
): ResolvedConfig {
	const provider = ctx.getNodeParameter('modelProvider', itemIndex, 'bedrock') as ModelProvider;
	const modelIdRaw = (ctx.getNodeParameter('modelId', itemIndex, '') as string).trim();
	const modelId = applyDefaults && !modelIdRaw ? DEFAULT_MODEL_ID : modelIdRaw;
	const modelOptions = ctx.getNodeParameter('modelOptions', itemIndex, {}) as IDataObject;
	const modelConfig = buildModelConfig({ provider, modelId, options: modelOptions });

	const systemPromptRaw = ctx.getNodeParameter('systemPrompt', itemIndex, '') as string;
	const systemPrompt =
		applyDefaults && !systemPromptRaw.trim() ? DEFAULT_SYSTEM_PROMPT : systemPromptRaw;

	const toolsUi = ctx.getNodeParameter('tools', itemIndex, {}) as IDataObject;
	const tools = buildToolsArray(toolsUi);

	const skillsUi = ctx.getNodeParameter('skills', itemIndex, {}) as IDataObject;
	const skills = buildSkillsArray(skillsUi);

	const additional = ctx.getNodeParameter('additionalOptions', itemIndex, {}) as IDataObject;

	return {
		modelConfig,
		systemPrompt,
		tools,
		skills,
		maxIterations: additional.maxIterations as number | undefined,
		maxTokens: additional.maxTokens as number | undefined,
		timeoutSeconds: additional.timeoutSeconds as number | undefined,
		actorId: (additional.actorId as string) || '',
		qualifier: ((additional.qualifier as string) || '').trim(),
		runtimeUserId: ((additional.runtimeUserId as string) || '').trim(),
	};
}

/**
 * "Run Agent" operation. Creates the harness on first run, reuses it on
 * subsequent runs, updates it when the configuration drifts.
 */
async function runAgent(
	ctx: IExecuteFunctions,
	itemIndex: number,
	creds: ICredentialDataDecryptedObject,
	region: string,
	controlClient: any,
	dataClient: any,
	commands: SdkCommands,
	staticData: NodeStaticData,
): Promise<IDataObject> {
	const agentName = ctx.getNodeParameter('agentName', itemIndex) as string;
	validateAgentName(agentName);

	const cfg = resolveConfig(ctx, itemIndex, true);
	const prompt = ctx.getNodeParameter('prompt', itemIndex, '') as string;
	const provisioning = ctx.getNodeParameter('provisioningOptions', itemIndex, {}) as IDataObject;

	const memoryMode = (provisioning.memoryMode as MemoryMode) || 'managed';
	const memoryArn = (provisioning.memoryArn as string) || '';
	const memoryStrategies = (provisioning.memoryStrategies as string[]) || undefined;
	const eventExpiryDuration = provisioning.eventExpiryDuration as number | undefined;
	const containerUri = (provisioning.containerUri as string) || '';
	const forceRecreate = (provisioning.forceRecreate as boolean) || false;
	const mounts = parseFilesystemMounts(provisioning.filesystemMounts as IDataObject);

	const memoryConfig = buildMemoryConfig({
		mode: memoryMode,
		memoryArn,
		strategies: memoryStrategies,
		eventExpiryDuration,
		actorId: cfg.actorId,
	});

	const vpc = getVpcConfig(creds);
	const environment = buildEnvironment({ vpc, mounts });
	const environmentArtifact = buildEnvironmentArtifact(containerUri);

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
		model: cfg.modelConfig,
		systemPrompt: cfg.systemPrompt,
		tools: cfg.tools,
		skills: cfg.skills.length > 0 ? cfg.skills : undefined,
		memory: memoryConfig,
		environment,
		environmentArtifact,
		maxIterations: cfg.maxIterations,
		maxTokens: cfg.maxTokens,
		timeoutSeconds: cfg.timeoutSeconds,
	});

	// Resolve harness: existing match, drift-update, or create.
	let record = staticData.harnesses![agentName];

	if (forceRecreate) {
		// Tear down our local cache and try to delete the remote harness so
		// CreateHarness won't collide on the unique-name constraint.
		// deleteManagedMemory=false disassociates managed memory instead of
		// cascade-deleting it (TODO(v0.2-question-2)) — avoids silent data loss.
		delete staticData.harnesses![agentName];
		record = undefined as any;

		const existing = await resolveExistingHarness(controlClient, commands, agentName);
		if (existing) {
			const { DeleteHarnessCommand } = await import('@aws-sdk/client-bedrock-agentcore-control');
			try {
				await controlClient.send(
					new DeleteHarnessCommand({
						harnessId: existing.harnessId,
						deleteManagedMemory: false,
					}),
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
				// so we force a drift check by setting configHash to empty.
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
						`Enable "Force Recreate" in Provisioning Options, or delete the harness manually with: ` +
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

	const provisionInput: ProvisionInput = {
		modelConfig: cfg.modelConfig,
		systemPrompt: cfg.systemPrompt,
		tools: cfg.tools,
		skills: cfg.skills,
		memoryConfig,
		memoryUpdate: buildMemoryUpdate({
			mode: memoryMode,
			memoryArn,
			strategies: memoryStrategies,
			eventExpiryDuration,
			actorId: cfg.actorId,
		}),
		environment,
		environmentArtifact,
		environmentArtifactUpdate: buildEnvironmentArtifactUpdate(containerUri),
		maxIterations: cfg.maxIterations,
		maxTokens: cfg.maxTokens,
		timeoutSeconds: cfg.timeoutSeconds,
	};

	if (!record) {
		record = await createHarness(
			controlClient,
			commands.CreateHarnessCommand,
			agentName,
			executionRoleArn,
			provisionInput,
			desiredHash,
		);
		staticData.harnesses![agentName] = record;
	} else if (record.configHash !== desiredHash) {
		record = await updateHarness(
			controlClient,
			commands.UpdateHarnessCommand,
			record.harnessId,
			record.arn,
			provisionInput,
			desiredHash,
		);
		staticData.harnesses![agentName] = record;
	}

	// Opt-in version/endpoint management (TODO(v0.2-question-9)).
	const versionEndpointOutput = await manageVersionsAndEndpoints(
		controlClient,
		record.harnessId,
		provisioning,
	);

	// Summarize what was actually provisioned (memory ARN, model, version, …) so
	// the user can see it in the node output instead of guessing.
	const harnessSummary = await getHarnessSummary(
		controlClient,
		commands.GetHarnessCommand,
		record.harnessId,
	);

	const sessionInput = (ctx.getNodeParameter('sessionId', itemIndex, '') as string).trim();
	const sessionId = resolveSessionId(sessionInput);
	const messages = buildMessages(ctx, itemIndex, prompt);

	const invokePayload = buildInvokePayload({
		harnessArn: record.arn,
		runtimeSessionId: sessionId,
		messages,
		modelConfig: cfg.modelConfig,
		skills: cfg.skills,
		actorId: cfg.actorId,
		qualifier: cfg.qualifier,
		maxIterations: cfg.maxIterations,
		maxTokens: cfg.maxTokens,
		timeoutSeconds: cfg.timeoutSeconds,
	});

	const result = await invoke(ctx, itemIndex, region, dataClient, commands.InvokeHarnessCommand, {
		harnessArn: record.arn,
		runtimeSessionId: sessionId,
		runtimeUserId: cfg.runtimeUserId,
		qualifier: cfg.qualifier,
		payload: invokePayload,
	});

	return {
		operation: 'run',
		agentName,
		harnessId: record.harnessId,
		harnessArn: record.arn,
		sessionId,
		// "generated" means the node created a fresh session this run (Session ID
		// left blank) — i.e. this is a NEW conversation and prior turns are not
		// recalled. "provided" means the user supplied a stable Session ID, so the
		// conversation continues. See the Session ID field help.
		sessionSource: sessionInput ? 'provided' : 'generated',
		...(cfg.actorId ? { actorId: cfg.actorId } : {}),
		...(harnessSummary ? { harness: harnessSummary } : {}),
		response: result.text,
		stopReason: result.stopReason,
		toolUses: result.toolUses,
		usage: result.usage,
		latencyMs: result.latencyMs,
		...versionEndpointOutput,
	};
}

/**
 * "Invoke Existing Harness" operation. BYO-ARN escape hatch.
 */
async function invokeExisting(
	ctx: IExecuteFunctions,
	itemIndex: number,
	region: string,
	controlClient: any,
	dataClient: any,
	InvokeHarnessCommand: any,
	GetHarnessCommand: any,
): Promise<IDataObject> {
	const harnessArn = (ctx.getNodeParameter('harnessArn', itemIndex) as string).trim();
	validateHarnessArn(harnessArn);
	const prompt = ctx.getNodeParameter('prompt', itemIndex, '') as string;

	// In the merged operation the visible config fields ARE the per-invocation
	// overrides. A blank field sends nothing, so the harness config is used as-is.
	const cfg = resolveConfig(ctx, itemIndex, false);

	const sessionInput = (ctx.getNodeParameter('sessionId', itemIndex, '') as string).trim();
	const sessionId = resolveSessionId(sessionInput);
	const messages = buildMessages(ctx, itemIndex, prompt);

	const invokePayload = buildInvokePayload({
		harnessArn,
		runtimeSessionId: sessionId,
		messages,
		modelConfig: cfg.modelConfig,
		systemPrompt: cfg.systemPrompt.trim() ? cfg.systemPrompt : undefined,
		tools: cfg.tools.length > 0 ? cfg.tools : undefined,
		skills: cfg.skills,
		actorId: cfg.actorId || undefined,
		qualifier: cfg.qualifier,
		maxIterations: cfg.maxIterations,
		maxTokens: cfg.maxTokens,
		timeoutSeconds: cfg.timeoutSeconds,
	});

	const result = await invoke(ctx, itemIndex, region, dataClient, InvokeHarnessCommand, {
		harnessArn,
		runtimeSessionId: sessionId,
		runtimeUserId: cfg.runtimeUserId,
		qualifier: cfg.qualifier,
		payload: invokePayload,
	});

	// Best-effort harness summary (memory ARN, model, version, …) for visibility.
	// Uses control-plane GetHarness, which is SigV4 even on the OAuth invoke path.
	const harnessSummary = await getHarnessSummary(
		controlClient,
		GetHarnessCommand,
		harnessIdFromArn(harnessArn),
	);

	return {
		operation: 'invokeExisting',
		harnessArn,
		sessionId,
		sessionSource: sessionInput ? 'provided' : 'generated',
		...(cfg.actorId ? { actorId: cfg.actorId } : {}),
		...(harnessSummary ? { harness: harnessSummary } : {}),
		response: result.text,
		stopReason: result.stopReason,
		toolUses: result.toolUses,
		usage: result.usage,
		latencyMs: result.latencyMs,
	};
}

/* ----- invoke dispatch (SigV4 vs OAuth Bearer) ----- */

interface InvokeDispatch {
	harnessArn: string;
	runtimeSessionId: string;
	runtimeUserId: string;
	qualifier: string;
	payload: IDataObject;
}

/**
 * Dispatches the invoke through either the SDK (SigV4) or the raw-HTTPS Bearer
 * path, depending on the Authentication field. Both paths funnel through
 * consumeStream so the output shape is identical.
 */
async function invoke(
	ctx: IExecuteFunctions,
	itemIndex: number,
	region: string,
	dataClient: any,
	InvokeHarnessCommand: any,
	dispatch: InvokeDispatch,
) {
	const authentication = ctx.getNodeParameter('authentication', itemIndex, 'awsSigV4') as string;

	if (authentication === 'oauthBearer') {
		const bearerToken = (ctx.getNodeParameter('bearerToken', itemIndex, '') as string).trim();
		if (!bearerToken) {
			throw new NodeOperationError(
				ctx.getNode(),
				'OAuth Bearer authentication selected but no Bearer Token was provided.',
				{ itemIndex },
			);
		}
		// The raw-HTTPS body excludes the path/header params (harnessArn,
		// runtimeSessionId, qualifier go on the URL/headers).
		const { harnessArn, runtimeSessionId, qualifier, ...body } = dispatch.payload as IDataObject &
			Record<string, unknown>;
		void harnessArn;
		void runtimeSessionId;
		void qualifier;
		return invokeWithBearer({
			region,
			harnessArn: dispatch.harnessArn,
			bearerToken,
			runtimeSessionId: dispatch.runtimeSessionId,
			qualifier: dispatch.qualifier || undefined,
			runtimeUserId: dispatch.runtimeUserId || undefined,
			body,
		});
	}

	const payload: IDataObject = { ...dispatch.payload };
	if (dispatch.runtimeUserId) payload.runtimeUserId = dispatch.runtimeUserId;
	const response = await dataClient.send(new InvokeHarnessCommand(payload));
	const stream = (response as any).stream;
	if (!stream) {
		throw new NodeOperationError(ctx.getNode(), 'InvokeHarness returned no stream', {
			itemIndex,
		});
	}
	return consumeStream(stream);
}

/* ----- versioning / endpoints (opt-in) ----- */

async function manageVersionsAndEndpoints(
	controlClient: any,
	harnessId: string,
	provisioning: IDataObject,
): Promise<IDataObject> {
	const output: IDataObject = {};

	if (provisioning.listVersions === true) {
		output.versions = await listHarnessVersions(controlClient, harnessId);
	}

	const endpointName = ((provisioning.endpointName as string) || '').trim();
	if (endpointName) {
		validateEndpointName(endpointName);
		const targetVersion = ((provisioning.endpointTargetVersion as string) || '').trim();
		const description = ((provisioning.endpointDescription as string) || '').trim();
		output.endpoint = await upsertHarnessEndpoint(
			controlClient,
			harnessId,
			endpointName,
			targetVersion || undefined,
			description || undefined,
		);
		// Surface the full endpoint list too, for convenience.
		output.endpoints = await listHarnessEndpoints(controlClient, harnessId);
	}

	return output;
}

/* ----- message construction (incl. inline-function tool-result round-trip) ----- */

/**
 * Builds the messages array. Normally just the user prompt; if Tool Results are
 * provided (inline-function round-trip), prepends the assistant tool-use message
 * and appends the user tool-result message on the same turn, per the harness
 * contract (TODO(v0.2-question-6)). The prompt is optional in that case.
 */
function buildMessages(ctx: IExecuteFunctions, itemIndex: number, prompt: string): IDataObject[] {
	const toolResultsUi = ctx.getNodeParameter('toolResults', itemIndex, {}) as IDataObject;
	const entries = (toolResultsUi.result as IDataObject[] | undefined) ?? [];

	const messages: IDataObject[] = [];

	if (entries.length > 0) {
		// Assistant message replays the tool-use blocks the model emitted.
		const assistantContent: IDataObject[] = [];
		const toolResultContent: IDataObject[] = [];
		for (const entry of entries) {
			const toolUseId = ((entry.toolUseId as string) || '').trim();
			const name = ((entry.name as string) || '').trim();
			if (!toolUseId || !name) {
				throw new ApplicationError(
					'Each Tool Result requires a Tool Use ID and Function Name (from the prior invocation output).',
				);
			}
			const input = parseToolInput(entry.input);
			assistantContent.push({ toolUse: { toolUseId, name, input } });
			toolResultContent.push({
				toolResult: {
					toolUseId,
					content: [{ text: (entry.content as string) ?? '' }],
					status: (entry.status as string) || 'success',
				},
			});
		}
		messages.push({ role: 'assistant', content: assistantContent });
		messages.push({ role: 'user', content: toolResultContent });
		return messages;
	}

	if (!prompt) {
		throw new ApplicationError('A Prompt is required (unless sending Tool Results back).');
	}
	messages.push({ role: 'user', content: [{ text: prompt }] });
	return messages;
}

function parseToolInput(value: unknown): unknown {
	if (value === undefined || value === null || value === '') return {};
	if (typeof value === 'object') return value;
	if (typeof value === 'string') {
		try {
			return JSON.parse(value);
		} catch {
			// Not JSON — pass the raw string through.
			return value;
		}
	}
	return value;
}

function parseFilesystemMounts(mountsUi: IDataObject | undefined): FilesystemMount[] {
	if (!mountsUi || !mountsUi.mount) return [];
	const entries = mountsUi.mount as IDataObject[];
	return entries.map((m) => ({
		type: m.type as FilesystemMount['type'],
		mountPath: (m.mountPath as string) || '',
		accessPointArn: (m.accessPointArn as string) || undefined,
	}));
}

/* ----- validators ----- */

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

function validateEndpointName(name: string): void {
	if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name)) {
		throw new ApplicationError(
			`Invalid endpoint name: "${name}". Must start with a letter and contain only letters, numbers, and underscores (max 48 chars).`,
		);
	}
}

/**
 * Resolves an existing harness for the given agent name by querying AWS.
 * This is the source of truth. Workflow static data is used as a fast-path
 * cache but its absence or staleness must never cause a CreateHarness call
 * when the harness already exists in the AWS account.
 */
async function resolveExistingHarness(
	controlClient: any,
	commands: SdkCommands,
	agentName: string,
): Promise<{ harnessId: string; arn: string; status: string } | null> {
	let nextToken: string | undefined;
	do {
		const resp = await controlClient.send(
			new commands.ListHarnessesCommand({
				maxResults: 100,
				...(nextToken ? { nextToken } : {}),
			}),
		);
		const summaries = resp.harnesses ?? resp.harnessSummaries ?? resp.items ?? [];
		const match = summaries.find((h: any) => {
			const name = h.harnessName ?? h.name ?? h.harnessId ?? '';
			return name === agentName || name.startsWith(agentName + '-');
		});
		if (match) {
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

/**
 * Reads the live harness back via GetHarness and distills the fields users care
 * about into a flat summary: the provisioned memory (incl. the managed-memory
 * ARN the service assigns), the resolved model, version, network mode, custom
 * container, and tool/skill counts. Best-effort — returns undefined on any
 * error so surfacing this never breaks the invoke result.
 */
async function getHarnessSummary(
	controlClient: any,
	GetHarnessCommand: any,
	harnessId: string,
): Promise<IDataObject | undefined> {
	try {
		const detail = await controlClient.send(new GetHarnessCommand({ harnessId }));
		return summarizeHarness(detail.harness ?? {});
	} catch {
		return undefined;
	}
}

function summarizeHarness(h: any): IDataObject {
	const summary: IDataObject = {};
	if (h.status) summary.status = h.status;
	if (h.harnessVersion) summary.version = h.harnessVersion;

	const mem = h.memory ?? {};
	if (mem.managedMemoryConfiguration) {
		const m = mem.managedMemoryConfiguration;
		summary.memory = {
			mode: 'managed',
			arn: m.arn,
			...(m.strategies ? { strategies: m.strategies } : {}),
			...(m.eventExpiryDuration !== undefined
				? { eventExpiryDuration: m.eventExpiryDuration }
				: {}),
		};
	} else if (mem.agentCoreMemoryConfiguration) {
		const m = mem.agentCoreMemoryConfiguration;
		summary.memory = {
			mode: 'byoArn',
			arn: m.arn,
			...(m.actorId ? { actorId: m.actorId } : {}),
		};
	} else if (mem.disabled) {
		summary.memory = { mode: 'disabled' };
	}

	const model = h.model ?? {};
	const providerKey = Object.keys(model)[0];
	if (providerKey) {
		const providerNames: Record<string, string> = {
			bedrockModelConfig: 'bedrock',
			openAiModelConfig: 'openai',
			geminiModelConfig: 'gemini',
			liteLlmModelConfig: 'litellm',
		};
		summary.model = {
			provider: providerNames[providerKey] ?? providerKey,
			modelId: model[providerKey]?.modelId,
			...(model[providerKey]?.apiFormat ? { apiFormat: model[providerKey].apiFormat } : {}),
		};
	}

	const networkMode = h.environment?.agentCoreRuntimeEnvironment?.networkConfiguration?.networkMode;
	if (networkMode) summary.networkMode = networkMode;

	const containerUri = h.environmentArtifact?.containerConfiguration?.containerUri;
	if (containerUri) summary.containerUri = containerUri;

	if (Array.isArray(h.tools)) summary.toolCount = h.tools.length;
	if (Array.isArray(h.skills)) summary.skillCount = h.skills.length;

	return summary;
}

/** Extracts the harnessId (the `<name>-<10char>` suffix) from a harness ARN. */
function harnessIdFromArn(arn: string): string {
	const idx = arn.lastIndexOf('harness/');
	return idx === -1 ? '' : arn.slice(idx + 'harness/'.length);
}

function resolveSessionId(input: string): string {
	if (!input) return randomUUID();

	const isValid = /^[A-Za-z0-9_-]+$/.test(input);
	const hash = createHash('sha256').update(input).digest('hex');
	let sessionId: string;

	if (isValid && input.length >= 33) {
		sessionId = input.slice(0, 128);
	} else if (isValid) {
		sessionId = `${input}-${hash}`.slice(0, 128);
	} else {
		const sanitized = input.replace(/[^A-Za-z0-9_-]/g, '_');
		sessionId = `${sanitized.slice(0, 63)}-${hash}`;
	}

	return sessionId;
}

/* ----- provisioning payload builders ----- */

interface ProvisionInput {
	modelConfig?: IDataObject;
	systemPrompt: string;
	tools: ToolConfig[];
	skills: IDataObject[];
	memoryConfig?: IDataObject;
	memoryUpdate?: IDataObject;
	environment?: IDataObject;
	environmentArtifact?: IDataObject;
	environmentArtifactUpdate?: IDataObject;
	maxIterations?: number;
	maxTokens?: number;
	timeoutSeconds?: number;
}

async function createHarness(
	controlClient: any,
	CreateHarnessCommand: any,
	agentName: string,
	executionRoleArn: string,
	input: ProvisionInput,
	desiredHash: string,
): Promise<HarnessRecord> {
	const payload: IDataObject = {
		harnessName: agentName,
		executionRoleArn,
		systemPrompt: [{ text: input.systemPrompt }],
	};
	if (input.modelConfig) payload.model = input.modelConfig;
	if (input.tools.length > 0) payload.tools = input.tools;
	if (input.skills.length > 0) payload.skills = input.skills;
	if (input.memoryConfig) payload.memory = input.memoryConfig;
	if (input.environment) payload.environment = input.environment;
	if (input.environmentArtifact) payload.environmentArtifact = input.environmentArtifact;
	if (input.maxIterations !== undefined) payload.maxIterations = input.maxIterations;
	if (input.maxTokens !== undefined) payload.maxTokens = input.maxTokens;
	if (input.timeoutSeconds !== undefined) payload.timeoutSeconds = input.timeoutSeconds;

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
	input: ProvisionInput,
	desiredHash: string,
): Promise<HarnessRecord> {
	const payload: IDataObject = {
		harnessId,
		systemPrompt: [{ text: input.systemPrompt }],
	};
	if (input.modelConfig) payload.model = input.modelConfig;
	if (input.tools.length > 0) payload.tools = input.tools;
	if (input.skills.length > 0) payload.skills = input.skills;
	// Memory + environmentArtifact use the optionalValue wrapper on update.
	if (input.memoryUpdate) payload.memory = input.memoryUpdate;
	if (input.environment) payload.environment = input.environment;
	if (input.environmentArtifactUpdate) {
		payload.environmentArtifact = input.environmentArtifactUpdate;
	}
	if (input.maxIterations !== undefined) payload.maxIterations = input.maxIterations;
	if (input.maxTokens !== undefined) payload.maxTokens = input.maxTokens;
	if (input.timeoutSeconds !== undefined) payload.timeoutSeconds = input.timeoutSeconds;

	await controlClient.send(new UpdateHarnessCommand(payload));

	const ready = await waitForHarnessReady(controlClient, harnessId);
	if (ready.status !== 'READY') {
		throw new ApplicationError(
			`Harness ${harnessId} update reached terminal state ${ready.status}: ${ready.failureReason}`,
		);
	}

	return { harnessId, arn, configHash: desiredHash };
}

/* ----- invoke payload builder ----- */

interface InvokePayloadInput {
	harnessArn: string;
	runtimeSessionId: string;
	messages: IDataObject[];
	modelConfig?: IDataObject;
	systemPrompt?: string;
	tools?: ToolConfig[];
	skills?: IDataObject[];
	actorId?: string;
	qualifier?: string;
	maxIterations?: number;
	maxTokens?: number;
	timeoutSeconds?: number;
}

function buildInvokePayload(input: InvokePayloadInput): IDataObject {
	const payload: IDataObject = {
		harnessArn: input.harnessArn,
		runtimeSessionId: input.runtimeSessionId,
		messages: input.messages,
	};

	if (input.qualifier) payload.qualifier = input.qualifier;
	if (input.modelConfig) payload.model = input.modelConfig;
	if (input.systemPrompt) payload.systemPrompt = [{ text: input.systemPrompt }];
	if (input.tools && input.tools.length > 0) payload.tools = input.tools;
	if (input.skills && input.skills.length > 0) payload.skills = input.skills;
	if (input.actorId) payload.actorId = input.actorId;
	if (input.maxIterations !== undefined) payload.maxIterations = input.maxIterations;
	if (input.maxTokens !== undefined) payload.maxTokens = input.maxTokens;
	if (input.timeoutSeconds !== undefined) payload.timeoutSeconds = input.timeoutSeconds;

	return payload;
}
