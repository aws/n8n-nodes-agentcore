/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { ApplicationError, type IDataObject } from 'n8n-workflow';

/**
 * Builds the `model` union (HarnessModelConfiguration) for CreateHarness,
 * UpdateHarness, and InvokeHarness from the node's model fields.
 *
 * The union has exactly four members (verified against the installed SDK
 * type definitions, @aws-sdk/client-bedrock-agentcore-control@3.1071.0):
 *   - bedrockModelConfig  { modelId, apiFormat?, maxTokens?, temperature?, topP?, additionalParams? }
 *   - openAiModelConfig   { modelId, apiKeyArn, apiFormat?, maxTokens?, temperature?, topP?, additionalParams? }
 *   - geminiModelConfig   { modelId, apiKeyArn, maxTokens?, temperature?, topP?, topK? }
 *   - liteLlmModelConfig  { modelId, apiKeyArn?, apiBase?, maxTokens?, temperature?, topP?, additionalParams? }
 *
 * Returns `undefined` when no model id is supplied, so the caller can omit the
 * field entirely (invoke mode: harness default applies; run mode: caller
 * substitutes its own default before calling this).
 *
 * TODO(v0.2-question-1): The "OpenAI via Bedrock Mantle, no API key" path is
 * NOT expressed through openAiModelConfig — the SDK's openAiModelConfig requires
 * apiKeyArn and has no `endpoint`/`bedrockMantle` member. The no-key Mantle path
 * is reached via bedrockModelConfig + apiFormat=responses|chat_completions with
 * a Mantle model id. See docs/v0.2-questions.md.
 */

export type ModelProvider = 'bedrock' | 'openai' | 'gemini' | 'litellm';

export interface ModelInput {
	provider: ModelProvider;
	modelId: string;
	options: IDataObject;
}

export function buildModelConfig(input: ModelInput): IDataObject | undefined {
	const modelId = (input.modelId || '').trim();
	if (!modelId) return undefined;

	const opts = input.options || {};
	const apiKeyArn = ((opts.apiKeyArn as string) || '').trim();
	const apiBase = ((opts.apiBase as string) || '').trim();
	const apiFormat = ((opts.apiFormat as string) || '').trim();
	const temperature = numOrUndef(opts.temperature);
	const topP = numOrUndef(opts.topP);
	const topK = numOrUndef(opts.topK);
	const modelMaxTokens = numOrUndef(opts.modelMaxTokens);
	const additionalParams = parseAdditionalParams(opts.additionalParams as string | undefined);

	switch (input.provider) {
		case 'openai': {
			if (!apiKeyArn) {
				throw new Error(
					'OpenAI model provider requires an API Key ARN (token-vault apikeycredentialprovider ARN). ' +
						'To call OpenAI models through Bedrock Mantle without a key, use the Bedrock provider with API Format = Responses or Chat Completions.',
				);
			}
			const cfg: IDataObject = { modelId, apiKeyArn };
			if (apiFormat) cfg.apiFormat = apiFormat;
			if (modelMaxTokens !== undefined) cfg.maxTokens = modelMaxTokens;
			if (temperature !== undefined) cfg.temperature = temperature;
			if (topP !== undefined) cfg.topP = topP;
			if (additionalParams !== undefined) cfg.additionalParams = additionalParams;
			return { openAiModelConfig: cfg };
		}

		case 'gemini': {
			if (!apiKeyArn) {
				throw new Error(
					'Gemini model provider requires an API Key ARN (token-vault apikeycredentialprovider ARN).',
				);
			}
			const cfg: IDataObject = { modelId, apiKeyArn };
			if (modelMaxTokens !== undefined) cfg.maxTokens = modelMaxTokens;
			if (temperature !== undefined) cfg.temperature = temperature;
			if (topP !== undefined) cfg.topP = topP;
			if (topK !== undefined) cfg.topK = topK;
			return { geminiModelConfig: cfg };
		}

		case 'litellm': {
			const cfg: IDataObject = { modelId };
			if (apiKeyArn) cfg.apiKeyArn = apiKeyArn;
			if (apiBase) cfg.apiBase = apiBase;
			if (modelMaxTokens !== undefined) cfg.maxTokens = modelMaxTokens;
			if (temperature !== undefined) cfg.temperature = temperature;
			if (topP !== undefined) cfg.topP = topP;
			if (additionalParams !== undefined) cfg.additionalParams = additionalParams;
			return { liteLlmModelConfig: cfg };
		}

		case 'bedrock':
		default: {
			const cfg: IDataObject = { modelId };
			if (apiFormat) cfg.apiFormat = apiFormat;
			if (modelMaxTokens !== undefined) cfg.maxTokens = modelMaxTokens;
			if (temperature !== undefined) cfg.temperature = temperature;
			if (topP !== undefined) cfg.topP = topP;
			if (additionalParams !== undefined) cfg.additionalParams = additionalParams;
			return { bedrockModelConfig: cfg };
		}
	}
}

function numOrUndef(value: unknown): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const n = Number(value);
	return Number.isNaN(n) ? undefined : n;
}

function parseAdditionalParams(raw: string | undefined): IDataObject | undefined {
	if (!raw || raw.trim() === '') return undefined;
	const invalid =
		'Model "Additional Params" must be a valid JSON object, for example: {"reasoning": {"effort": "high"}}';
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new ApplicationError(invalid);
	}
	return parsed as IDataObject;
}
