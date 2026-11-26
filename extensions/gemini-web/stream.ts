import { randomUUID } from 'node:crypto';
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type TextContent,
  type ThinkingContent,
  type Api,
} from '@earendil-works/pi-ai';
import {
  PROVIDER_ID,
  GEMINI_WEB_API,
  preparePrompt,
  decodeReply,
  safeWebError,
  GeminiWebError,
  validateWebThinkingLevel,
  type WebPayload,
  type WebThinkingLevel,
} from './protocol.js';
import type { GeminiWebClient, WebResponseInfo } from './client.js';

/**
 * Adapter implementing Pi custom streaming over Gemini Web RPC.
 *
 * Important limitations:
 * - Output is fully buffered before emission; real chunked streaming is not available.
 * - Tool calling is prompt-based; responses are parsed and validated against Pi tool schemas.
 * - Usage and cost are unmeasured placeholders (reported 0s indicate unmetered/unknown, not free).
 * - Sampling knobs (temperature, maxTokens) are unenforceable on the Google Web interface.
 */
export function createGeminiWebStream(
  getClient: () => GeminiWebClient,
): (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api || GEMINI_WEB_API,
      provider: model.provider || PROVIDER_ID,
      model: model.id,
      timestamp: Date.now(),
      stopReason: 'pending',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    };

    void (async () => {
      let started = false;

      const finishError = (error: unknown) => {
        const isAbort =
          options?.signal?.aborted ||
          (error instanceof GeminiWebError && error.code === 'closed') ||
          (error instanceof Error &&
            (error.name === 'AbortError' ||
              error.message.toLowerCase().includes('aborted') ||
              error.message.toLowerCase().includes('abort')));

        output.stopReason = isAbort ? 'aborted' : 'error';
        output.errorMessage = safeWebError(error);

        stream.push({
          type: 'error',
          reason: isAbort ? 'aborted' : 'error',
          error: output,
        });
        stream.end();
      };

      try {
        options?.signal?.throwIfAborted();

        // Enforce supported options: Web protocol supports only low, medium, and high reasoning effort
        if (options?.deferred || options?.thinkingBudgets !== undefined) {
          throw new GeminiWebError('unsupported');
        }

        let thinkingLevel: WebThinkingLevel = 'low';
        if (options?.reasoning !== undefined) {
          thinkingLevel = validateWebThinkingLevel(options.reasoning);
          output.providerThinkingLevel = thinkingLevel;
        }

        // Prepare current transcript prompt and active tools
        const prepared = preparePrompt(context, options?.toolChoice);
        options?.signal?.throwIfAborted();

        const client = getClient();
        if (!client) {
          throw new GeminiWebError('closed');
        }

        // Wire options adapters for instrumentation
        const wireOptions = {
          signal: options?.signal,
          fetch: options?.fetch,
          timeoutMs: options?.timeoutMs,
          thinkingLevel,
          onPayload: options?.onPayload
            ? async (payload: WebPayload) => {
                const hookRes = await options!.onPayload!(payload, model);
                return hookRes;
              }
            : undefined,
          onResponse: async (response: WebResponseInfo) => {
            options?.signal?.throwIfAborted();
            if (options?.onResponse) {
              await options.onResponse(
                { status: response.status, headers: response.headers },
                model,
              );
              options?.signal?.throwIfAborted();
            }
            if (!started) {
              started = true;
              stream.push({ type: 'start', partial: output });
            }
          },
          onFrame: async (frame: unknown) => {
            options?.signal?.throwIfAborted();
            const observer = (
              options as {
                onProviderStreamEvent?: (
                  event: unknown,
                  model: Model<Api>,
                ) => void | Promise<void>;
              }
            )?.onProviderStreamEvent;
            if (observer) {
              await observer(frame, model);
              options?.signal?.throwIfAborted();
            }
          },
        };

        const generation = await client.generate(
          model.id,
          prepared.payload,
          wireOptions,
        );

        options?.signal?.throwIfAborted();

        if (!started) {
          started = true;
          stream.push({ type: 'start', partial: output });
        }

        const idPrefix = randomUUID().replace(/-/g, '').slice(0, 8);
        const decoded = decodeReply(generation.text, prepared.tools, idPrefix);
        options?.signal?.throwIfAborted();

        // 1. If thinking is present, emit standard Pi thinking block first
        if (generation.thinking && generation.thinking.length > 0) {
          const thinkingIndex = output.content.length;
          const thinkingBlock: ThinkingContent = {
            type: 'thinking',
            thinking: '',
          };
          output.content.push(thinkingBlock);
          stream.push({
            type: 'thinking_start',
            contentIndex: thinkingIndex,
            partial: output,
          });
          thinkingBlock.thinking = generation.thinking;
          stream.push({
            type: 'thinking_delta',
            contentIndex: thinkingIndex,
            delta: generation.thinking,
            partial: output,
          });
          stream.push({
            type: 'thinking_end',
            contentIndex: thinkingIndex,
            content: generation.thinking,
            partial: output,
          });
        }

        // 2. Deliver buffered blocks synchronously
        if (decoded.toolCalls.length > 0) {
          for (const call of decoded.toolCalls) {
            const contentIndex = output.content.length;
            const toolCall: ToolCall = { ...call };
            output.content.push(toolCall);
            stream.push({
              type: 'toolcall_start',
              contentIndex,
              partial: output,
            });
            stream.push({
              type: 'toolcall_delta',
              contentIndex,
              delta: JSON.stringify(toolCall.arguments),
              partial: output,
            });
            stream.push({
              type: 'toolcall_end',
              contentIndex,
              toolCall,
              partial: output,
            });
          }
          output.stopReason = 'toolUse';
          stream.push({ type: 'done', reason: 'toolUse', message: output });
          stream.end();
        } else {
          const contentIndex = output.content.length;
          const textBlock: TextContent = { type: 'text', text: '' };
          output.content.push(textBlock);
          stream.push({
            type: 'text_start',
            contentIndex,
            partial: output,
          });
          if (decoded.text.length > 0) {
            textBlock.text = decoded.text;
            stream.push({
              type: 'text_delta',
              contentIndex,
              delta: decoded.text,
              partial: output,
            });
          }
          stream.push({
            type: 'text_end',
            contentIndex,
            content: decoded.text,
            partial: output,
          });
          output.stopReason = 'stop';
          stream.push({ type: 'done', reason: 'stop', message: output });
          stream.end();
        }
      } catch (error) {
        finishError(error);
      }
    })();

    return stream;
  };
}
