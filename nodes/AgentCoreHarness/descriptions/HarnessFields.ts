/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import type { INodeProperties } from 'n8n-workflow';
import { toolsField } from './Common';

/**
 * Single-operation field set for the Amazon Bedrock AgentCore node.
 *
 * The **Harness ARN** field is the mode discriminator:
 *   - blank  -> Run Agent: ListHarnesses -> CreateHarness on miss ->
 *               UpdateHarness on drift -> InvokeHarness, keyed by Agent Name
 *               and cached in workflow static data.
 *   - filled -> Invoke Existing: InvokeHarness directly against the given ARN.
 *               Every visible config field (Model, System Prompt, Tools, Skills,
 *               limits, Actor ID) is applied as a per-invocation override.
 *
 * Fields that only make sense when the node owns the harness lifecycle
 * (Agent Name, Provisioning Options) are hidden once an ARN is present.
 *
 * v0.2 additions: multi-provider models, managed memory, VPC + filesystem +
 * custom container, skills, inline-function tool-result round-trip, OAuth Bearer
 * invoke, and opt-in version/endpoint management.
 */

// Visible only in Run Agent mode (Harness ARN blank).
const RUN_ONLY = { show: { harnessArn: [''] } };

export const harnessFields: INodeProperties[] = [
	{
		displayName: 'Harness ARN',
		name: 'harnessArn',
		type: 'string',
		default: '',
		placeholder: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/MyAgent-abc123',
		description:
			'Leave blank to run an agent the node provisions and reuses for you (keyed by Agent Name). Provide the ARN of a harness created outside n8n (CLI, console, CloudFormation, Terraform) to invoke it directly — in that case the Model, System Prompt, Tools, Skills, limits, and Actor ID fields below are applied as per-invocation overrides.',
	},
	{
		displayName: 'Agent Name',
		name: 'agentName',
		type: 'string',
		default: '',
		required: true,
		displayOptions: RUN_ONLY,
		placeholder: 'my_research_agent',
		description:
			'A name for this agent. Letters, numbers, and underscores only (max 40). The harness is created automatically on the first run and reused thereafter — this is the cache key, so renaming creates a new harness. Hidden when a harness ARN is provided.',
	},

	// ----- Model -----
	{
		displayName: 'Model Provider',
		name: 'modelProvider',
		type: 'options',
		default: 'bedrock',
		options: [
			{ name: 'Amazon Bedrock', value: 'bedrock' },
			{ name: 'OpenAI', value: 'openai' },
			{ name: 'Google Gemini', value: 'gemini' },
			{ name: 'LiteLLM', value: 'litellm' },
		],
		description:
			'Model provider. Bedrock is native (no API key). OpenAI and Gemini call the provider directly and require an API Key ARN. LiteLLM reaches any LiteLLM-supported provider. To call OpenAI models through Bedrock Mantle without an API key, pick Bedrock and set API Format to Responses or Chat Completions with a Mantle model ID. Switchable per invocation.',
	},
	{
		displayName: 'Model ID',
		name: 'modelId',
		type: 'string',
		default: '',
		placeholder: 'global.anthropic.claude-sonnet-4-6',
		description:
			'Model ID. Bedrock: e.g. global.anthropic.claude-sonnet-4-6. OpenAI: e.g. gpt-5.4. Gemini: e.g. gemini-2.5-pro. LiteLLM: provider-prefixed, e.g. gemini/gemini-2.5-pro. In Run Agent mode defaults to Claude Sonnet 4.6 on Bedrock when blank. When a harness ARN is set, overrides the harness model for this invocation only — leave blank to use the harness model as-is.',
	},
	{
		displayName: 'Model Options',
		name: 'modelOptions',
		type: 'collection',
		placeholder: 'Add Model Option',
		default: {},
		options: [
			{
				displayName: 'Additional Params (JSON)',
				name: 'additionalParams',
				type: 'json',
				default: '',
				placeholder: '{ "reasoning": { "effort": "high" } }',
				description:
					'Bedrock/OpenAI/LiteLLM only. Provider-specific parameters passed through unchanged. Security note: these can alter endpoint routing and credentials — validate before exposing this node to untrusted callers.',
			},
			{
				displayName: 'API Base URL',
				name: 'apiBase',
				type: 'string',
				default: '',
				placeholder: 'https://my-openai-proxy.example.com/v1',
				description:
					'LiteLLM only. Custom endpoint URL for an OpenAI-compatible gateway, proxy, or self-hosted endpoint.',
			},
			{
				displayName: 'API Format',
				name: 'apiFormat',
				type: 'options',
				default: 'converse_stream',
				options: [
					{ name: 'Converse Stream (Bedrock Default)', value: 'converse_stream' },
					{ name: 'Responses', value: 'responses' },
					{ name: 'Chat Completions', value: 'chat_completions' },
				],
				description:
					'Bedrock/OpenAI only. For Bedrock, Responses/Chat Completions route through the Bedrock Mantle endpoint (enables OpenAI-compatible and Mantle models with no API key). For OpenAI direct, choose Responses (default) or Chat Completions.',
			},
			{
				displayName: 'API Key ARN',
				name: 'apiKeyArn',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				placeholder:
					'arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/my-key',
				description:
					'AgentCore Identity API key credential provider ARN. Required for OpenAI and Gemini; optional for LiteLLM (API-key providers) and unused for Bedrock.',
			},
			{
				displayName: 'Model Max Tokens',
				name: 'modelMaxTokens',
				type: 'number',
				default: 4096,
				description: 'Per-iteration max output tokens passed to the model provider',
			},
			{
				displayName: 'Temperature',
				name: 'temperature',
				type: 'number',
				default: 1,
				typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
				description: 'Sampling temperature (0.0–2.0)',
			},
			{
				displayName: 'Top K',
				name: 'topK',
				type: 'number',
				default: 40,
				typeOptions: { minValue: 0, maxValue: 500 },
				description: 'Gemini only. Top-K sampling (0–500).',
			},
			{
				displayName: 'Top P',
				name: 'topP',
				type: 'number',
				default: 1,
				typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
				description: 'Nucleus sampling probability (0.0–1.0)',
			},
		],
	},

	{
		displayName: 'System Prompt',
		name: 'systemPrompt',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		description:
			'Instructions that define how the agent behaves. In Run Agent mode, defaults to a generic assistant prompt when left blank. When a harness ARN is set, this overrides the harness system prompt for this invocation only — leave blank to use the harness prompt as-is.',
	},
	{
		displayName: 'Prompt',
		name: 'prompt',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		placeholder: '={{ $json.userMessage }}',
		description:
			'The user message to send to the agent. Optional only when sending Tool Results back for an inline-function round-trip.',
	},

	{
		...toolsField,
		description:
			'Tools the agent can use. In Run Agent mode these are baked into the harness configuration. When a Harness ARN is set, they override the harness tool list for this invocation only.',
	},

	// ----- Skills -----
	{
		displayName: 'Skills',
		name: 'skills',
		type: 'fixedCollection',
		placeholder: 'Add Skill',
		typeOptions: { multipleValues: true },
		default: {},
		description:
			'Skill bundles the agent loads on demand. In Run Agent mode these are baked into the harness; with a Harness ARN they are appended per invocation (invoke-time wins on name collision).',
		options: [
			{
				name: 'skill',
				displayName: 'Skill',
				values: [
					{
						displayName: 'AWS Skill Globs',
						name: 'paths',
						type: 'string',
						default: '',
						placeholder: 'core-skills/*, specialized-skills/operations-skills/*',
						description:
							'Comma/newline-separated glob patterns selecting AWS skills. Leave blank to enable all AWS skills.',
					},
					{
						displayName: 'Filesystem Path',
						name: 'fsPath',
						type: 'string',
						default: '',
						placeholder: '.agents/skills/xlsx',
						description:
							'Path to a skill already on the harness filesystem (baked into the image or installed at session start)',
					},
					{
						displayName: 'Git Credential ARN',
						name: 'gitCredentialArn',
						type: 'string',
						default: '',
						description:
							'Optional. AgentCore Identity credential provider ARN holding a PAT for private repos.',
					},
					{
						displayName: 'Git Subdirectory',
						name: 'gitPath',
						type: 'string',
						default: '',
						placeholder: 'skills/docx',
						description: 'Optional subdirectory within the repo (sparse checkout)',
					},
					{
						displayName: 'Git URL',
						name: 'gitUrl',
						type: 'string',
						default: '',
						placeholder: 'https://github.com/anthropics/skills',
						description: 'HTTPS URL of the Git repository',
					},
					{
						displayName: 'Git Username',
						name: 'gitUsername',
						type: 'string',
						default: '',
						description: 'Optional git username. Defaults to oauth2.',
					},
					{
						displayName: 'S3 URI',
						name: 's3Uri',
						type: 'string',
						default: '',
						placeholder: 's3://my-skills-bucket/skills/company-style/',
						description: 'S3 URI pointing to the skill directory',
					},
					{
						displayName: 'Source',
						name: 'source',
						type: 'options',
						default: 'awsSkills',
						options: [
							{
								name: 'AWS Skills (Curated Catalog)',
								value: 'awsSkills',
							},
							{
								name: 'Git (HTTPS)',
								value: 'git',
							},
							{
								name: 'Amazon S3',
								value: 's3',
							},
							{
								name: 'Filesystem Path',
								value: 'path',
							},
						],
					},
				],
			},
		],
	},

	{
		displayName: 'Session ID',
		name: 'sessionId',
		type: 'string',
		default: '',
		placeholder: '={{ $json.userId }}',
		description:
			'Controls conversation continuity. Leave blank and each execution starts a NEW conversation (a fresh ID is generated, so the agent will not remember prior runs — the output shows sessionSource "generated"). To CONTINUE a conversation across runs, set a stable value and reuse it — e.g. an expression bound to a per-user field for a chat, or a fixed string like my-test-session for manual testing. Values under 33 chars are extended deterministically. Memory (managed or BYO) only recalls earlier turns when the session ID matches; set Actor ID too for per-user long-term memory scoping.',
	},

	// ----- Authentication (invoke-time) -----
	{
		displayName: 'Authentication',
		name: 'authentication',
		type: 'options',
		default: 'awsSigV4',
		options: [
			{ name: 'AWS SigV4 (Default)', value: 'awsSigV4' },
			{ name: 'OAuth Bearer Token', value: 'oauthBearer' },
		],
		description:
			'How to authenticate the InvokeHarness call. SigV4 uses the credential AWS keys. OAuth Bearer makes a raw HTTPS request with a JWT (the harness must have an inbound OAuth authorizer configured). Control-plane operations (create/update/provision) always use SigV4.',
	},
	{
		displayName: 'Bearer Token',
		name: 'bearerToken',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		required: true,
		displayOptions: { show: { authentication: ['oauthBearer'] } },
		placeholder: '={{ $json.id_token }}',
		description:
			'JWT issued by your identity provider. Populate it from an upstream auth node via an expression. Used only for the invoke call; the credential AWS keys are ignored for invoke when OAuth is selected.',
	},

	{
		displayName: 'Additional Options',
		name: 'additionalOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Actor ID',
				name: 'actorId',
				type: 'string',
				default: '',
				description:
					'Identifier for the entity interacting with the agent (used for memory scoping). Recommended when memory is enabled. When a harness ARN is provided, sent as a per-invocation override.',
			},
			{
				displayName: 'Endpoint (Qualifier)',
				name: 'qualifier',
				type: 'string',
				default: '',
				placeholder: 'production-endpoint',
				description:
					'Optional named endpoint to invoke. If omitted, the DEFAULT endpoint (latest version) is used. Use this to invoke a staging/prod endpoint pinned to a specific version.',
			},
			{
				displayName: 'Max Iterations',
				name: 'maxIterations',
				type: 'number',
				default: 50,
				description: 'Maximum think-act-observe cycles per invocation',
			},
			{
				displayName: 'Max Tokens',
				name: 'maxTokens',
				type: 'number',
				default: 4096,
				description: 'Maximum output tokens per invocation',
			},
			{
				displayName: 'Runtime User ID',
				name: 'runtimeUserId',
				type: 'string',
				default: '',
				description:
					'Optional end-user identifier passed to the runtime container (X-Amzn-Bedrock-AgentCore-Runtime-User-ID)',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeoutSeconds',
				type: 'number',
				default: 600,
				description: 'Wall-clock timeout for the entire invocation',
			},
		],
	},

	// ----- Inline-function tool-result round-trip -----
	{
		displayName: 'Tool Results',
		name: 'toolResults',
		type: 'fixedCollection',
		placeholder: 'Add Tool Result',
		typeOptions: { multipleValues: true },
		default: {},
		description:
			'Results for inline-function tool calls returned by a previous invocation (stopReason "tool_use"). When set, the node sends the assistant tool-use message plus your tool result on the same session, and the agent resumes. Provide the Tool Use ID, function name, and original input from the prior output.',
		options: [
			{
				name: 'result',
				displayName: 'Result',
				values: [
					{
						displayName: 'Function Input (JSON)',
						name: 'input',
						type: 'json',
						default: '',
						placeholder: '={{	$json.toolUses[0	].input	}}',
						description:
							'The original input the model passed to the function (from the prior output). Required so the assistant tool-use message can be reconstructed.',
					},
					{
						displayName: 'Function Name',
						name: 'name',
						type: 'string',
						default: '',
						placeholder: '={{	$json.toolUses[0].name	}}',
						description: 'The inline function name the model called',
					},
					{
						displayName: 'Result Content',
						name: 'content',
						type: 'string',
						default: '',
						description: 'The result text to return to the agent',
					},
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						default: 'success',
						options: [
							{
								name: 'Success',
								value: 'success',
							},
							{
								name: 'Error',
								value: 'error',
							},
						],
						description: 'Whether the tool execution succeeded',
					},
					{
						displayName: 'Tool Use ID',
						name: 'toolUseId',
						type: 'string',
						default: '',
						placeholder: '={{	$json.toolUses[0].toolUseId	}}',
						description: 'The toolUseId from the prior invocation output',
					},
				],
			},
		],
	},

	// ----- Provisioning Options (run mode only) -----
	{
		displayName: 'Provisioning Options',
		name: 'provisioningOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: RUN_ONLY,
		description:
			'Options that apply only when the node owns the harness lifecycle (Harness ARN blank)',
		options: [
			{
				displayName: 'Container Image URI',
				name: 'containerUri',
				type: 'string',
				default: '',
				placeholder: '123456789012.dkr.ecr.us-west-2.amazonaws.com/my-agent:latest',
				description:
					'Optional custom container image (ECR URI). Must be built for linux/arm64. The harness overrides ENTRYPOINT/CMD; your filesystem, dependencies, and env vars are available to the agent.',
			},
			{
				displayName: 'Endpoint Description',
				name: 'endpointDescription',
				type: 'string',
				default: '',
				description: 'Optional description for the named endpoint',
			},
			{
				displayName: 'Endpoint Name',
				name: 'endpointName',
				type: 'string',
				default: '',
				placeholder: 'production-endpoint',
				description:
					'Optional. Create (or update) a named endpoint after provisioning. Use the Endpoint (Qualifier) option above to invoke it. Letters/numbers/underscores, max 48.',
			},
			{
				displayName: 'Endpoint Target Version',
				name: 'endpointTargetVersion',
				type: 'string',
				default: '',
				placeholder: '2',
				description:
					'Version the endpoint should point to (e.g. 2). If blank, points to the latest version at creation time.',
			},
			{
				displayName: 'Event Expiry (Days)',
				name: 'eventExpiryDuration',
				type: 'number',
				default: 30,
				typeOptions: { minValue: 3, maxValue: 365 },
				displayOptions: { show: { memoryMode: ['managed'] } },
				description: 'How long managed-memory events are retained (3–365 days)',
			},
			{
				displayName: 'Filesystem Mounts',
				name: 'filesystemMounts',
				type: 'fixedCollection',
				placeholder: 'Add Mount',
				typeOptions: { multipleValues: true },
				default: {},
				description:
					'Persistent storage mounts. Session storage needs no VPC; EFS and S3 Files require VPC mode (set on the credential).',
				options: [
					{
						name: 'mount',
						displayName: 'Mount',
						values: [
							{
								displayName: 'Access Point ARN',
								name: 'accessPointArn',
								type: 'string',
								default: '',
								displayOptions: { show: { type: ['efsAccessPoint', 's3FilesAccessPoint'] } },
								description: 'EFS or S3 Files access point ARN',
							},
							{
								displayName: 'Mount Path',
								name: 'mountPath',
								type: 'string',
								default: '',
								placeholder: '/mnt/data',
								description: 'Path under /mnt where the filesystem is mounted',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								default: 'sessionStorage',
								options: [
									{ name: 'Session Storage (No VPC)', value: 'sessionStorage' },
									{ name: 'EFS Access Point (VPC)', value: 'efsAccessPoint' },
									{ name: 'S3 Files Access Point (VPC)', value: 's3FilesAccessPoint' },
								],
							},
						],
					},
				],
			},
			{
				displayName: 'Force Recreate',
				name: 'forceRecreate',
				type: 'boolean',
				default: false,
				description:
					'Whether to delete and recreate the harness instead of updating it. Use only when an update fails or the harness is stuck. Managed memory is disassociated (not deleted) on recreate. Hidden when a Harness ARN is provided.',
			},
			{
				displayName: 'List Versions',
				name: 'listVersions',
				type: 'boolean',
				default: false,
				description:
					'Whether to list all immutable versions of this harness and include them in the output under "versions"',
			},
			{
				displayName: 'Memory ARN (BYO)',
				name: 'memoryArn',
				type: 'string',
				default: '',
				placeholder: 'arn:aws:bedrock-agentcore:us-west-2:...:memory/...',
				description:
					'Existing AgentCore Memory ARN. When set, takes precedence and the harness uses BYO memory. This is the v0.1-compatible field. Memory is a harness-level setting, so this is hidden when a Harness ARN is provided.',
			},
			{
				displayName: 'Memory Mode',
				name: 'memoryMode',
				type: 'options',
				default: 'managed',
				options: [
					{ name: 'Managed (Auto-Provision)', value: 'managed' },
					{ name: 'Bring Your Own ARN', value: 'byoArn' },
					{ name: 'Disabled', value: 'disabled' },
				],
				description:
					'Managed auto-provisions an AgentCore Memory instance (the GA default). BYO attaches an existing Memory ARN. Disabled opts out. NOTE: a populated Memory ARN below is always treated as BYO regardless of this setting, preserving v0.1 behavior.',
			},
			{
				displayName: 'Memory Strategies',
				name: 'memoryStrategies',
				type: 'multiOptions',
				default: ['SEMANTIC', 'SUMMARIZATION'],
				displayOptions: { show: { memoryMode: ['managed'] } },
				options: [
					{ name: 'Semantic', value: 'SEMANTIC' },
					{ name: 'Summarization', value: 'SUMMARIZATION' },
					{ name: 'User Preference', value: 'USER_PREFERENCE' },
					{ name: 'Episodic', value: 'EPISODIC' },
				],
				description: 'Long-term memory strategies for managed memory (1–4)',
			},
		],
	},
];
