/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import {
	buildMemoryConfig,
	buildMemoryUpdate,
	resolveMemoryMode,
} from '../nodes/AgentCoreHarness/helpers/memory';

describe('resolveMemoryMode', () => {
	it('honors the v0.1 legacy contract: a populated ARN always means BYO', () => {
		expect(resolveMemoryMode({ mode: 'managed', memoryArn: 'arn:mem' })).toBe('byoArn');
		expect(resolveMemoryMode({ mode: 'disabled', memoryArn: 'arn:mem' })).toBe('byoArn');
	});

	it('uses the selected mode when no ARN is present', () => {
		expect(resolveMemoryMode({ mode: 'managed' })).toBe('managed');
		expect(resolveMemoryMode({ mode: 'disabled' })).toBe('disabled');
	});
});

describe('buildMemoryConfig', () => {
	it('builds managed memory with strategies and expiry', () => {
		const cfg = buildMemoryConfig({
			mode: 'managed',
			strategies: ['SEMANTIC', 'EPISODIC'],
			eventExpiryDuration: 30,
		});
		expect(cfg).toEqual({
			managedMemoryConfiguration: { strategies: ['SEMANTIC', 'EPISODIC'], eventExpiryDuration: 30 },
		});
	});

	it('builds managed memory with an empty config when nothing is set', () => {
		expect(buildMemoryConfig({ mode: 'managed' })).toEqual({ managedMemoryConfiguration: {} });
	});

	it('builds BYO memory from an ARN, with optional actorId', () => {
		expect(buildMemoryConfig({ mode: 'byoArn', memoryArn: 'arn:mem', actorId: 'user-1' })).toEqual({
			agentCoreMemoryConfiguration: { arn: 'arn:mem', actorId: 'user-1' },
		});
	});

	it('throws for BYO mode without an ARN', () => {
		expect(() => buildMemoryConfig({ mode: 'byoArn' })).toThrow(/requires a Memory ARN/);
	});

	it('builds a disabled memory config', () => {
		expect(buildMemoryConfig({ mode: 'disabled' })).toEqual({ disabled: {} });
	});
});

describe('buildMemoryUpdate', () => {
	it('wraps the union in the optionalValue envelope', () => {
		expect(buildMemoryUpdate({ mode: 'disabled' })).toEqual({ optionalValue: { disabled: {} } });
	});
});
