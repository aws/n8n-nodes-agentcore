/**
 * Consumes the InvokeHarness streaming response and accumulates the final text,
 * tool-use trace, stop reason, and usage metadata.
 *
 * Event shapes are derived from the AgentCore samples notebooks:
 *   contentBlockStart -> { start: { toolUse: { name, toolUseId } } }
 *   contentBlockDelta -> { delta: { text: string } }
 *   messageStop       -> { stopReason: string }
 *   metadata          -> { usage: { inputTokens, outputTokens }, metrics: { latencyMs } }
 *   internalServerException -> error envelope
 */
export interface InvokeResult {
	text: string;
	toolUses: Array<{ name: string; toolUseId?: string }>;
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

	for await (const event of stream) {
		if (event.contentBlockStart) {
			const start = event.contentBlockStart.start ?? {};
			if (start.toolUse) {
				result.toolUses.push({
					name: start.toolUse.name ?? 'unknown',
					toolUseId: start.toolUse.toolUseId,
				});
			}
		} else if (event.contentBlockDelta) {
			const delta = event.contentBlockDelta.delta ?? {};
			if (typeof delta.text === 'string') {
				result.text += delta.text;
			}
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
			const msg =
				typeof event.internalServerException === 'string'
					? event.internalServerException
					: JSON.stringify(event.internalServerException);
			throw new Error(`AgentCore internal server error: ${msg}`);
		} else if (event.validationException) {
			const msg =
				typeof event.validationException === 'string'
					? event.validationException
					: JSON.stringify(event.validationException);
			throw new Error(`AgentCore validation error: ${msg}`);
		} else if (event.throttlingException) {
			throw new Error('AgentCore throttling: request was throttled, retry later');
		}
	}

	return result;
}
