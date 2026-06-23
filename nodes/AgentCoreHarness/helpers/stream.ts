/**
 * Consumes the InvokeHarness streaming response and accumulates the final text,
 * tool-use trace, stop reason, and usage metadata.
 *
 * Event shapes are derived from the AgentCore samples notebooks and the API
 * reference (harnessapis.md):
 *   contentBlockStart -> { contentBlockIndex, start: { toolUse: { name, toolUseId } } }
 *   contentBlockDelta -> { contentBlockIndex, delta: { text } | { toolUse: { input } } }
 *   messageStop       -> { stopReason: string }
 *   metadata          -> { usage: { inputTokens, outputTokens }, metrics: { latencyMs } }
 *   internalServerException / validationException / runtimeClientError -> error envelope
 *
 * Tool-use input arrives as a stream of partial-JSON string fragments in
 * contentBlockDelta.toolUse.input, keyed by contentBlockIndex. We accumulate
 * the fragments per index and parse them at messageStop, so the inline-function
 * round-trip can hand the parsed input back to the caller.
 */
export interface ToolUse {
	name: string;
	toolUseId?: string;
	/** Parsed tool input (best-effort JSON parse of the accumulated fragments). */
	input?: unknown;
}

export interface InvokeResult {
	text: string;
	toolUses: ToolUse[];
	stopReason?: string;
	usage?: { inputTokens?: number; outputTokens?: number };
	latencyMs?: number;
	error?: string;
}

export async function consumeStream(stream: AsyncIterable<any>): Promise<InvokeResult> {
	const result: InvokeResult = {
		text: '',
		toolUses: [],
	};

	// Tool-use blocks indexed by contentBlockIndex so we can attach streamed
	// input fragments to the right tool call.
	const toolUseByIndex = new Map<number, ToolUse>();
	const inputFragmentsByIndex = new Map<number, string>();

	for await (const event of stream) {
		if (event.contentBlockStart) {
			const idx = event.contentBlockStart.contentBlockIndex as number | undefined;
			const start = event.contentBlockStart.start ?? {};
			if (start.toolUse) {
				const toolUse: ToolUse = {
					name: start.toolUse.name ?? 'unknown',
					toolUseId: start.toolUse.toolUseId,
				};
				result.toolUses.push(toolUse);
				if (idx !== undefined) toolUseByIndex.set(idx, toolUse);
			}
		} else if (event.contentBlockDelta) {
			const idx = event.contentBlockDelta.contentBlockIndex as number | undefined;
			const delta = event.contentBlockDelta.delta ?? {};
			if (typeof delta.text === 'string') {
				result.text += delta.text;
			}
			if (delta.toolUse && typeof delta.toolUse.input === 'string' && idx !== undefined) {
				inputFragmentsByIndex.set(
					idx,
					(inputFragmentsByIndex.get(idx) ?? '') + delta.toolUse.input,
				);
			}
		} else if (event.contentBlockStop) {
			const idx = event.contentBlockStop.contentBlockIndex as number | undefined;
			if (idx !== undefined) attachInput(toolUseByIndex, inputFragmentsByIndex, idx);
		} else if (event.messageStop) {
			result.stopReason = event.messageStop.stopReason;
		} else if (event.metadata) {
			const meta = event.metadata;
			if (meta.usage) {
				result.usage = {
					inputTokens: meta.usage.inputTokens,
					outputTokens: meta.usage.outputTokens,
				};
			}
			if (meta.metrics?.latencyMs !== undefined) {
				result.latencyMs = meta.metrics.latencyMs;
			}
		} else if (event.internalServerException) {
			throw new Error(
				`AgentCore internal server error: ${errorText(event.internalServerException)}`,
			);
		} else if (event.validationException) {
			throw new Error(`AgentCore validation error: ${errorText(event.validationException)}`);
		} else if (event.runtimeClientError) {
			throw new Error(`AgentCore runtime client error: ${errorText(event.runtimeClientError)}`);
		} else if (event.throttlingException) {
			throw new Error('AgentCore throttling: request was throttled, retry later');
		}
	}

	// Parse any remaining tool-use input fragments not flushed at contentBlockStop.
	for (const idx of inputFragmentsByIndex.keys()) {
		attachInput(toolUseByIndex, inputFragmentsByIndex, idx);
	}

	return result;
}

function attachInput(
	toolUseByIndex: Map<number, ToolUse>,
	inputFragmentsByIndex: Map<number, string>,
	idx: number,
): void {
	const toolUse = toolUseByIndex.get(idx);
	const raw = inputFragmentsByIndex.get(idx);
	if (!toolUse || raw === undefined || toolUse.input !== undefined) return;
	if (raw.trim() === '') {
		toolUse.input = {};
		return;
	}
	try {
		toolUse.input = JSON.parse(raw);
	} catch {
		// Leave the raw fragment string so the caller can still inspect it.
		toolUse.input = raw;
	}
}

function errorText(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}
