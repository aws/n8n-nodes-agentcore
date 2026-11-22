/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { AgentCoreHarness } from '../nodes/AgentCoreHarness/AgentCoreHarness.node';
import { buildFrame, streamOf } from './fixtures/eventStreamFrames';

/**
 * Node-level tests: drive the real `execute()` with a minimal IExecuteFunctions
 * and an in-memory AgentCore. They pin the wiring that the builder tests
 * cannot see: which request each option lands on (CreateHarness, UpdateHarness,
 * TagResource, InvokeHarness), and that an unchanged workflow makes no
 * mutating calls.
 */

const ARN = 'arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/agent-abc1234567';
const HARNESS_ID = 'agent-abc1234567';

interface SentRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	body?: IDataObject;
}

/** A tiny stand-in for the AgentCore control and data planes. */
class FakeAgentCore {
	requests: SentRequest[] = [];
	harness?: IDataObject;
	/** Extra stream events to emit before messageStop, e.g. hookEvent frames. */
	extraEvents: Array<{ type: string; payload: unknown }> = [];

	httpRequest = async (options: IDataObject) => {
		const url = new URL(options.url as string);
		const body = options.body ? (JSON.parse(options.body as string) as IDataObject) : undefined;
		const method = options.method as string;
		const path = decodeURIComponent(url.pathname);
		this.requests.push({ method, path, query: url.searchParams, body });
		const json = (b: unknown) => ({ statusCode: 200, headers: {}, body: JSON.stringify(b) });

		if (path === '/harnesses/invoke') {
			return {
				statusCode: 200,
				headers: {},
				body: streamOf(
					buildFrame(
						{ ':message-type': 'event', ':event-type': 'contentBlockDelta' },
						{ contentBlockIndex: 0, delta: { text: 'ok' } },
					),
					...this.extraEvents.map((e) =>
						buildFrame({ ':message-type': 'event', ':event-type': e.type }, e.payload),
					),
					buildFrame(
						{ ':message-type': 'event', ':event-type': 'messageStop' },
						{ stopReason: 'end_turn' },
					),
					buildFrame(
						{ ':message-type': 'event', ':event-type': 'metadata' },
						{ usage: { inputTokens: 3, outputTokens: 1 }, metrics: { latencyMs: 5 } },
					),
				),
			};
		}
		if (method === 'GET' && path === '/harnesses') {
			return json({
				harnesses: this.harness
					? [{ harnessId: HARNESS_ID, harnessName: 'agent', arn: ARN, status: 'READY' }]
					: [],
			});
		}
		if (method === 'POST' && path === '/harnesses') {
			this.harness = {
				...body,
				harnessId: HARNESS_ID,
				arn: ARN,
				status: 'READY',
				harnessVersion: '1',
			};
			return json({ harness: this.harness });
		}
		if (method === 'GET' && path === `/harnesses/${HARNESS_ID}`)
			return json({ harness: this.harness });
		if (method === 'PATCH' && path === `/harnesses/${HARNESS_ID}`) {
			this.harness = { ...this.harness, ...body };
			return json({ harness: this.harness });
		}
		if (path.startsWith('/tags/')) return { statusCode: 204, headers: {}, body: '' };
		throw new Error(`unexpected request ${method} ${path}`);
	};

	mutations() {
		return this.requests.filter((r) => r.method !== 'GET' && r.path !== '/harnesses/invoke');
	}
	invokes() {
		return this.requests.filter((r) => r.path === '/harnesses/invoke');
	}
	reset() {
		this.requests = [];
	}
}

const BASE_PARAMS: IDataObject = {
	harnessArn: '',
	agentName: 'agent',
	modelProvider: 'bedrock',
	modelId: 'global.anthropic.claude-sonnet-4-6',
	modelOptions: {},
	systemPrompt: 'You are a test agent.',
	prompt: 'hello',
	addTools: true,
	tools: { tool: [{ type: 'agentcore_code_interpreter', name: 'code_interpreter' }] },
	addSkills: false,
	skills: {},
	sessionId: 'session-1',
	authentication: 'awsSigV4',
	additionalOptions: {},
	toolResults: {},
	provisioningOptions: { memoryMode: 'disabled' },
};

async function execute(
	fake: FakeAgentCore,
	staticData: IDataObject,
	params: IDataObject,
	typeVersion = 2,
) {
	const p = { ...BASE_PARAMS, ...params };
	const ctx = {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({
			accessKeyId: 'AKID',
			secretAccessKey: 'secret',
			region: 'us-west-2',
			executionRoleArn: 'arn:aws:iam::111122223333:role/HarnessRole',
			networkMode: 'PUBLIC',
		}),
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in p ? p[name] : fallback,
		getWorkflowStaticData: () => staticData,
		getNode: () => ({
			name: 'AgentCore',
			type: 'agentCoreHarness',
			typeVersion,
			parameters: {},
		}),
		continueOnFail: () => false,
		helpers: { httpRequest: fake.httpRequest },
	} as unknown as IExecuteFunctions;
	const [[item]] = await new AgentCoreHarness().execute.call(ctx);
	return item.json as IDataObject;
}

describe('Run Agent wiring', () => {
	let fake: FakeAgentCore;
	let staticData: IDataObject;
	beforeEach(() => {
		fake = new FakeAgentCore();
		staticData = {};
	});

	it('sends truncation and tags on CreateHarness, allowed tools only on InvokeHarness', async () => {
		const out = await execute(fake, staticData, {
			additionalOptions: { allowedBuiltInTools: ['read'] },
			provisioningOptions: {
				memoryMode: 'disabled',
				truncation: { config: { strategy: 'sliding_window', messagesCount: 8 } },
				tags: '{"team":"a"}',
			},
		});

		const create = fake.mutations().find((r) => r.method === 'POST' && r.path === '/harnesses');
		expect(create?.body?.truncation).toEqual({
			strategy: 'sliding_window',
			config: { slidingWindow: { messagesCount: 8 } },
		});
		expect(create?.body?.tags).toEqual({ team: 'a' });
		expect(create?.body).not.toHaveProperty('allowedTools');

		// The configured Code Interpreter is kept available as @<name>.
		expect(fake.invokes()[0].body?.allowedTools).toEqual(['read', '@code_interpreter']);
		expect(out.allowedTools).toEqual(['read', '@code_interpreter']);
		expect(out.tags).toEqual({ team: 'a' });
		expect((out.harness as IDataObject).truncation).toEqual({
			strategy: 'sliding_window',
			config: { slidingWindow: { messagesCount: 8 } },
		});
	});

	it('changing allowed tools makes no harness mutation', async () => {
		await execute(fake, staticData, { additionalOptions: { allowedBuiltInTools: ['read'] } });
		fake.reset();

		await execute(fake, staticData, {
			additionalOptions: { allowedBuiltInTools: ['read', 'shell'] },
		});
		expect(fake.mutations()).toEqual([]);
		expect(fake.invokes()[0].body?.allowedTools).toEqual(['read', 'shell', '@code_interpreter']);
	});

	it('sends an empty list for "no built-ins and no configured tools"', async () => {
		const out = await execute(fake, staticData, {
			addTools: false,
			additionalOptions: { allowedBuiltInTools: [] },
		});
		expect(fake.invokes()[0].body?.allowedTools).toEqual([]);
		expect((out.harness as IDataObject).builtInToolsAvailable).toBe(false);
	});

	it('omits allowedTools entirely when the option is not added', async () => {
		const out = await execute(fake, staticData, {});
		expect(fake.invokes()[0].body).not.toHaveProperty('allowedTools');
		expect(out).not.toHaveProperty('allowedTools');
	});

	it('applies a tag change with TagResource / UntagResource, not UpdateHarness', async () => {
		await execute(fake, staticData, {
			provisioningOptions: { memoryMode: 'disabled', tags: '{"team":"a","old":"x"}' },
		});
		fake.reset();

		await execute(fake, staticData, {
			provisioningOptions: { memoryMode: 'disabled', tags: '{"team":"b","env":"prod"}' },
		});
		const muts = fake.mutations();
		expect(muts.some((r) => r.method === 'PATCH')).toBe(false);
		const tag = muts.find((r) => r.method === 'POST' && r.path.startsWith('/tags/'));
		const untag = muts.find((r) => r.method === 'DELETE' && r.path.startsWith('/tags/'));
		expect(tag?.path).toBe(`/tags/${ARN}`);
		expect(tag?.body).toEqual({ tags: { team: 'b', env: 'prod' } });
		expect(untag?.query.getAll('tagKeys')).toEqual(['old']);
	});

	it('updates the harness when truncation changes', async () => {
		await execute(fake, staticData, {
			provisioningOptions: { memoryMode: 'disabled', truncation: { config: { strategy: 'none' } } },
		});
		fake.reset();

		await execute(fake, staticData, {
			provisioningOptions: {
				memoryMode: 'disabled',
				truncation: { config: { strategy: 'summarization', summaryRatio: 0.4 } },
			},
		});
		const patch = fake.mutations().find((r) => r.method === 'PATCH');
		expect(patch?.body?.truncation).toEqual({
			strategy: 'summarization',
			config: { summarization: { summaryRatio: 0.4 } },
		});
		expect(patch?.body).not.toHaveProperty('allowedTools');
		expect(patch?.body).not.toHaveProperty('tags');
	});

	it('an unchanged workflow recorded before these options existed makes no mutating calls', async () => {
		// First run with none of the new options, then drop `tags` from the record
		// to mimic a harness recorded by 0.4.5.
		await execute(fake, staticData, {});
		const records = staticData.harnesses as Record<string, IDataObject>;
		delete records.agent.tags;
		fake.reset();

		await execute(fake, staticData, {});
		expect(fake.mutations()).toEqual([]);
		expect(fake.invokes()).toHaveLength(1);
	});
});

describe('Invoke Existing wiring', () => {
	let fake: FakeAgentCore;
	beforeEach(async () => {
		fake = new FakeAgentCore();
		// A harness created elsewhere with its own configured tools.
		fake.harness = {
			harnessId: HARNESS_ID,
			arn: ARN,
			status: 'READY',
			tools: [
				{ type: 'agentcore_code_interpreter', name: 'ci' },
				{ type: 'remote_mcp', name: 'search' },
			],
		};
	});

	const existing = (additionalOptions: IDataObject, extra: IDataObject = {}) => ({
		harnessArn: ARN,
		modelId: '',
		systemPrompt: '',
		addTools: false,
		additionalOptions,
		...extra,
	});

	it('reads the harness tools so a restriction keeps them available', async () => {
		await execute(fake, {}, existing({ allowedBuiltInTools: [] }));
		const invokeIndex = fake.requests.findIndex((r) => r.path === '/harnesses/invoke');
		const getBefore = fake.requests
			.slice(0, invokeIndex)
			.filter((r) => r.method === 'GET' && r.path === `/harnesses/${HARNESS_ID}`);
		expect(getBefore).toHaveLength(1);
		expect(fake.invokes()[0].body?.allowedTools).toEqual(['@ci', '@search']);
	});

	it('uses the invocation tool override instead of the harness tools', async () => {
		await execute(
			fake,
			{},
			existing(
				{ allowedBuiltInTools: ['read'] },
				{ addTools: true, tools: { tool: [{ type: 'agentcore_browser', name: 'browser' }] } },
			),
		);
		expect(fake.invokes()[0].body?.allowedTools).toEqual(['read', '@browser']);
	});

	it('lets an extra selector narrow one harness tool', async () => {
		await execute(
			fake,
			{},
			existing({ allowedBuiltInTools: [], additionalToolSelectors: '@search/web_*' }),
		);
		expect(fake.invokes()[0].body?.allowedTools).toEqual(['@search/web_*', '@ci']);
	});

	it('makes no extra GetHarness call before invoking when there is no restriction', async () => {
		await execute(fake, {}, existing({}));
		const invokeIndex = fake.requests.findIndex((r) => r.path === '/harnesses/invoke');
		expect(fake.requests.slice(0, invokeIndex).filter((r) => r.method === 'GET')).toEqual([]);
		expect(fake.invokes()[0].body).not.toHaveProperty('allowedTools');
	});
});

describe('managed defaults by node version', () => {
	let fake: FakeAgentCore;
	beforeEach(() => {
		fake = new FakeAgentCore();
	});
	const blank = { modelId: '', systemPrompt: '' };
	const create = () => fake.mutations().find((r) => r.method === 'POST' && r.path === '/harnesses');

	it('version 3 omits a blank model and system prompt so AgentCore applies its managed defaults', async () => {
		await execute(fake, {}, blank, 3);
		expect(create()?.body).not.toHaveProperty('model');
		expect(create()?.body).not.toHaveProperty('systemPrompt');
		expect(fake.invokes()[0].body).not.toHaveProperty('model');
	});

	it('version 2 keeps the pinned model and one-line prompt, unchanged from 0.4.x', async () => {
		await execute(fake, {}, blank, 2);
		expect(create()?.body?.model).toEqual({
			bedrockModelConfig: { modelId: 'global.anthropic.claude-sonnet-4-6' },
		});
		expect(create()?.body?.systemPrompt).toEqual([{ text: 'You are a helpful AI assistant.' }]);
	});

	it('version 3 still sends an explicit model and system prompt', async () => {
		await execute(
			fake,
			{},
			{ modelId: 'us.anthropic.claude-sonnet-5-5', systemPrompt: 'Be terse.' },
			3,
		);
		expect(create()?.body?.model).toEqual({
			bedrockModelConfig: { modelId: 'us.anthropic.claude-sonnet-5-5' },
		});
		expect(create()?.body?.systemPrompt).toEqual([{ text: 'Be terse.' }]);
	});

	it('version 3 never sends an empty prompt on update', async () => {
		// Omitting systemPrompt on UpdateHarness keeps the stored value.
		const staticData = {};
		await execute(fake, staticData, blank, 3);
		fake.reset();
		await execute(fake, staticData, { ...blank, additionalOptions: { maxIterations: 20 } }, 3);
		const patch = fake.mutations().find((r) => r.method === 'PATCH');
		expect(patch?.body?.maxIterations).toBe(20);
		expect(patch?.body).not.toHaveProperty('systemPrompt');
	});
});

describe('lifecycle hook events in the output', () => {
	it('reports hookEvent entries from the stream, in order', async () => {
		const fake = new FakeAgentCore();
		fake.extraEvents = [
			{
				type: 'hookEvent',
				payload: {
					hookEventId: 'h1',
					name: 'policy',
					type: 'before_tool_call',
					decision: 'deny',
					reason: 'Over limit.',
				},
			},
			{ type: 'hookEvent', payload: { hookEventId: 'h2', name: 'audit', type: 'after_tool_call' } },
		];
		const out = await execute(fake, {}, {});
		expect(out.hookEvents).toEqual([
			{
				hookEventId: 'h1',
				name: 'policy',
				type: 'before_tool_call',
				decision: 'deny',
				reason: 'Over limit.',
			},
			{ hookEventId: 'h2', name: 'audit', type: 'after_tool_call' },
		]);
	});

	it('omits hookEvents when no hook fired', async () => {
		const out = await execute(new FakeAgentCore(), {}, {});
		expect(out).not.toHaveProperty('hookEvents');
	});
});
