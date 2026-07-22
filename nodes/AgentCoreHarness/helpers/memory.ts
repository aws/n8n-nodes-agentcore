/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import type { IDataObject } from 'n8n-workflow';

/**
 * Builds the `memory` union (HarnessMemoryConfiguration) for CreateHarness and
 * the `optionalValue`-wrapped UpdatedHarnessMemoryConfiguration for
 * UpdateHarness.
 *
 * Union members (verified against the installed SDK type definitions,
 * @aws-sdk/client-bedrock-agentcore-control@3.1071.0):
 *   - managedMemoryConfiguration  { strategies?, eventExpiryDuration?, encryptionKeyArn? }
 *   - agentCoreMemoryConfiguration { arn, actorId?, messagesCount?, retrievalConfig? }
 *   - disabled                     {}
 *
 * Memory is a harness-level setting (not an invoke-time override), so this is
 * only used by the run/provision path, never by buildInvokePayload.
 *
 * Backward compatibility (TODO(v0.2-question-3)): v0.1 only had a "Memory ARN
 * (BYO)" field. v0.2 adds an explicit Memory Mode selector. A populated legacy
 * memoryArn is mapped to BYO regardless of mode, so v0.1 workflows keep working.
 */

export type MemoryMode = 'managed' | 'byoArn' | 'disabled';

export interface MemoryInput {
	mode: MemoryMode;
	/** BYO AgentCore Memory ARN (also the v0.1 legacy field). */
	memoryArn?: string;
	/** Managed-memory strategies, 1–4 of SEMANTIC|SUMMARIZATION|USER_PREFERENCE|EPISODIC. */
	strategies?: string[];
	/** Managed-memory event expiry in days (3–365). */
	eventExpiryDuration?: number;
	/** Actor ID for memory scoping (applies to BYO). */
	actorId?: string;
}

/**
 * Resolves the effective memory mode, honoring the v0.1 legacy contract: a
 * populated Memory ARN always means BYO, no matter what the mode selector says.
 */
export function resolveMemoryMode(input: MemoryInput): MemoryMode {
	if ((input.memoryArn || '').trim()) return 'byoArn';
	return input.mode;
}

/**
 * Builds the bare union for CreateHarness (no optionalValue wrapper). Always
 * returns a config — every mode (managed/byoArn/disabled) maps to a union member.
 */
export function buildMemoryConfig(input: MemoryInput): IDataObject {
	const mode = resolveMemoryMode(input);

	switch (mode) {
		case 'disabled':
			return { disabled: {} };

		case 'byoArn': {
			const arn = (input.memoryArn || '').trim();
			if (!arn) {
				throw new Error('Memory Mode "Bring Your Own ARN" requires a Memory ARN.');
			}
			const cfg: IDataObject = { arn };
			if ((input.actorId || '').trim()) cfg.actorId = input.actorId;
			return { agentCoreMemoryConfiguration: cfg };
		}

		case 'managed':
		default: {
			const cfg: IDataObject = {};
			if (input.strategies && input.strategies.length > 0) {
				cfg.strategies = input.strategies;
			}
			if (input.eventExpiryDuration !== undefined) {
				cfg.eventExpiryDuration = input.eventExpiryDuration;
			}
			return { managedMemoryConfiguration: cfg };
		}
	}
}

/** Wraps the union in the optionalValue envelope UpdateHarness requires. */
export function buildMemoryUpdate(input: MemoryInput): IDataObject {
	return { optionalValue: buildMemoryConfig(input) };
}
