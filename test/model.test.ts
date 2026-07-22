/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { buildModelConfig } from '../nodes/AgentCoreHarness/helpers/model';

describe('buildModelConfig', () => {
	it('returns undefined when no model id is supplied', () => {
		expect(buildModelConfig({ provider: 'bedrock', modelId: '', options: {} })).toBeUndefined();
	});

	it('builds a bedrock config with apiFormat and sampling options', () => {
		const cfg = buildModelConfig({
			provider: 'bedrock',
			modelId: 'us.anthropic.claude-opus-4-7',
			options: { apiFormat: 'converse_stream', temperature: 0.5, topP: 0.9 },
		});
		expect(cfg).toEqual({
			bedrockModelConfig: {
				modelId: 'us.anthropic.claude-opus-4-7',
				apiFormat: 'converse_stream',
				temperature: 0.5,
				topP: 0.9,
			},
		});
	});

	it('builds an openai config and requires an API key ARN', () => {
		const cfg = buildModelConfig({
			provider: 'openai',
			modelId: 'gpt-5.4',
			options: { apiKeyArn: 'arn:key' },
		});
		expect(cfg).toEqual({ openAiModelConfig: { modelId: 'gpt-5.4', apiKeyArn: 'arn:key' } });

		expect(() => buildModelConfig({ provider: 'openai', modelId: 'gpt-5.4', options: {} })).toThrow(
			/requires an API Key ARN/,
		);
	});

	it('builds a gemini config with topK and requires an API key ARN', () => {
		const cfg = buildModelConfig({
			provider: 'gemini',
			modelId: 'gemini-2.5-pro',
			options: { apiKeyArn: 'arn:key', topK: 40 },
		});
		expect(cfg).toEqual({ geminiModelConfig: { modelId: 'gemini-2.5-pro', apiKeyArn: 'arn:key', topK: 40 } });

		expect(() => buildModelConfig({ provider: 'gemini', modelId: 'x', options: {} })).toThrow(
			/requires an API Key ARN/,
		);
	});

	it('builds a litellm config where the API key ARN is optional', () => {
		const cfg = buildModelConfig({
			provider: 'litellm',
			modelId: 'gemini/gemini-2.5-pro',
			options: { apiBase: 'https://proxy.example.com' },
		});
		expect(cfg).toEqual({
			liteLlmModelConfig: { modelId: 'gemini/gemini-2.5-pro', apiBase: 'https://proxy.example.com' },
		});
	});

	it('throws when additionalParams is not valid JSON', () => {
		expect(() =>
			buildModelConfig({ provider: 'bedrock', modelId: 'x', options: { additionalParams: 'nope' } }),
		).toThrow(/valid JSON object/);
	});
});
