import { join } from 'node:path';
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type { Model, Api, Context, SimpleStreamOptions } from '@earendil-works/pi-ai';
import {
  PROVIDER_ID,
  GEMINI_WEB_API,
  getFriendlyModelId,
  getFriendlyModelName,
  safeWebError,
  GeminiWebError,
  type WebModel,
} from './protocol.js';
import {
  CookieCredentialStore,
  readCookieImport,
} from './auth.js';
import {
  createGeminiWebClient,
  type GeminiWebClient,
  type WebClientDependencies,
} from './client.js';
import { createGeminiWebStream } from './stream.js';

export { PROVIDER_ID, GEMINI_WEB_API };

export function toPiModel(
  webModel: WebModel,
  catalog: readonly WebModel[] = [webModel],
): Model<Api> {
  return {
    id: getFriendlyModelId(webModel, catalog),
    name: getFriendlyModelName(webModel),
    api: GEMINI_WEB_API,
    provider: PROVIDER_ID,
    baseUrl: 'https://gemini.google.com',
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    },
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
  };
}

function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: 'info' | 'warning' | 'error' = 'info',
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === 'warning' || type === 'error') {
    console.error(text);
  } else {
    console.log(text);
  }
}

async function registerCompatProvider(
  streamFn: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => ReturnType<ReturnType<typeof createGeminiWebStream>>,
): Promise<void> {
  try {
    const piAi = await import('@earendil-works/pi-ai');
    if (typeof (piAi as Record<string, unknown>).registerApiProvider === 'function') {
      ((piAi as Record<string, unknown>).registerApiProvider as Function)({
        api: GEMINI_WEB_API,
        stream: streamFn,
        streamSimple: streamFn,
      });
      return;
    }
  } catch {
    // ignore
  }

  try {
    const compat = await import('@earendil-works/pi-ai/compat');
    if (typeof compat.registerApiProvider === 'function') {
      compat.registerApiProvider({
        api: GEMINI_WEB_API,
        stream: streamFn,
        streamSimple: streamFn,
      });
      return;
    }
  } catch {
    // ignore
  }
}

export default async function (
  pi: ExtensionAPI,
  injectedStore?: CookieCredentialStore,
  injectedDependencies?: WebClientDependencies,
): Promise<void> {
  const storePath = join(getAgentDir(), 'gemini-web', 'credentials.json');
  const store = injectedStore ?? new CookieCredentialStore(storePath);

  let client: GeminiWebClient | undefined;

  function getClient(): GeminiWebClient {
    if (!client) {
      client = createGeminiWebClient(store, injectedDependencies);
    }
    return client;
  }

  function resetClient(): GeminiWebClient {
    if (client) {
      client.close();
      client = undefined;
    }
    client = createGeminiWebClient(store, injectedDependencies);
    return client;
  }

  const streamSimple = createGeminiWebStream(getClient);
  await registerCompatProvider(streamSimple);

  function registerCurrentProvider(models: readonly WebModel[], hasAuth: boolean): void {
    const piModels = models.map((m) => toPiModel(m, models));
    const providerConfig = {
      name: 'Gemini Web (cookie session; buffered)',
      baseUrl: 'https://gemini.google.com',
      api: GEMINI_WEB_API,
      apiKey: hasAuth ? 'gemini-web-cookie-session' : undefined,
      models: piModels,
      refreshModels: async (context?: {
        force?: boolean;
        allowNetwork?: boolean;
        signal?: AbortSignal;
      }) => {
        if (context?.force && context?.allowNetwork) {
          const refreshed = await getClient().refresh({ signal: context?.signal });
          registerCurrentProvider(refreshed, true);
          return refreshed.map((m) => toPiModel(m, refreshed));
        }
        const current = await store.read(context?.signal);
        const list = current?.models ?? [];
        return list.map((m) => toPiModel(m, list));
      },
      streamSimple,
    };

    pi.registerProvider(
      PROVIDER_ID,
      providerConfig as unknown as Parameters<typeof pi.registerProvider>[1],
    );
  }

  // Hydrate credential-bound cached catalog with safe local read.
  // Never perform network calls on extension startup or during --list-models.
  let initialWebModels: readonly WebModel[] = [];
  let initialHasAuth = false;
  try {
    const cred = await store.read();
    if (cred) {
      initialHasAuth = true;
      if (Array.isArray(cred.models) && cred.models.length > 0) {
        initialWebModels = cred.models;
      }
    }
  } catch {
    // Fail safe on corrupt store; empty availability rather than extension crash
  }

  registerCurrentProvider(initialWebModels, initialHasAuth);

  const activeCommandControllers = new Set<AbortController>();

  async function runCommand(
    ctx: ExtensionCommandContext,
    fn: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    activeCommandControllers.add(controller);

    const onCtxAbort = () => {
      controller.abort(ctx.signal?.reason);
    };
    if (ctx.signal) {
      if (ctx.signal.aborted) onCtxAbort();
      else ctx.signal.addEventListener('abort', onCtxAbort, { once: true });
    }

    try {
      await fn(controller.signal);
    } finally {
      ctx.signal?.removeEventListener('abort', onCtxAbort);
      activeCommandControllers.delete(controller);
    }
  }

  pi.registerCommand('gemini-web.import', {
    description: 'Import full Google cookie header from a private 0600 file',
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (
        trimmed.includes('__Secure-') ||
        (trimmed.includes(';') && !trimmed.includes('--auth-user'))
      ) {
        emitCommandOutput(
          ctx,
          'Usage: /gemini-web.import <private-file-path> --auth-user <N>. Do not pass cookies directly as command arguments.',
          'error',
        );
        return;
      }
      const slotMatch = trimmed.match(/(?:^|\s+)--auth-user(?:=|\s+)(\d+)(?:\s+|$)/);
      if (!slotMatch) {
        emitCommandOutput(
          ctx,
          'Usage: /gemini-web.import <private-file-path> --auth-user <N> (where N is Google account index, e.g. 0)',
          'error',
        );
        return;
      }
      const authUser = parseInt(slotMatch[1], 10);
      let rawPath = trimmed.replace(slotMatch[0], ' ').trim();
      if (
        (rawPath.startsWith('"') && rawPath.endsWith('"')) ||
        (rawPath.startsWith("'") && rawPath.endsWith("'"))
      ) {
        rawPath = rawPath.slice(1, -1);
      }
      if (!rawPath) {
        emitCommandOutput(
          ctx,
          'Usage: /gemini-web.import <private-file-path> --auth-user <N>',
          'error',
        );
        return;
      }

      await (ctx as { waitUntilIdle?: () => Promise<void> }).waitUntilIdle?.();

      await runCommand(ctx, async (signal) => {
        try {
          const cred = await readCookieImport(rawPath, authUser, signal);
          if (client) {
            client.close();
            client = undefined;
          }
          await store.update(async () => cred, signal);
          const c = resetClient();

          try {
            const models = await c.refresh({ signal });
            registerCurrentProvider(models, true);
            emitCommandOutput(
              ctx,
              `Imported Gemini Web session (slot ${authUser}, ${models.length} model(s) discovered). Provider is ready in /model.`,
            );
          } catch (refreshErr) {
            registerCurrentProvider([], true);
            emitCommandOutput(
              ctx,
              `Imported credentials saved for slot ${authUser}, but initial verification failed: ${safeWebError(refreshErr)}. Run /gemini-web.refresh to retry.`,
              'warning',
            );
          }
        } catch (err) {
          emitCommandOutput(
            ctx,
            `Failed to import cookie credentials: ${safeWebError(err)}`,
            'error',
          );
        }
      });
    },
  });

  pi.registerCommand('gemini-web.refresh', {
    description: 'Refresh Gemini Web dynamic models and opportunistic cookie rotation',
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        emitCommandOutput(ctx, 'Usage: /gemini-web.refresh takes no arguments.', 'error');
        return;
      }
      await (ctx as { waitUntilIdle?: () => Promise<void> }).waitUntilIdle?.();

      await runCommand(ctx, async (signal) => {
        try {
          const cred = await store.read(signal);
          if (!cred) {
            emitCommandOutput(
              ctx,
              'No Gemini Web credentials configured. Run /gemini-web.import first.',
              'warning',
            );
            return;
          }
          const c = getClient();
          const models = await c.refresh({ signal });
          registerCurrentProvider(models, true);
          emitCommandOutput(
            ctx,
            `Refreshed Gemini Web catalog (slot ${cred.authUser}): ${models.length} model(s) available.`,
          );
        } catch (err) {
          emitCommandOutput(
            ctx,
            `Failed to refresh Gemini Web models: ${safeWebError(err)}`,
            'error',
          );
        }
      });
    },
  });

  pi.registerCommand('gemini-web.logout', {
    description: 'Log out of Gemini Web and remove local credentials and cached models',
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        emitCommandOutput(ctx, 'Usage: /gemini-web.logout takes no arguments.', 'error');
        return;
      }
      await (ctx as { waitUntilIdle?: () => Promise<void> }).waitUntilIdle?.();

      await runCommand(ctx, async (signal) => {
        try {
          if (client) {
            client.close();
            client = undefined;
          }
          await store.update(async () => undefined, signal);
          registerCurrentProvider([], false);
          if (
            typeof (pi as { unregisterProvider?: (id: string) => void }).unregisterProvider ===
            'function'
          ) {
            try {
              (pi as { unregisterProvider?: (id: string) => void }).unregisterProvider!(
                PROVIDER_ID,
              );
            } catch {
              // ignore
            }
          }
          emitCommandOutput(
            ctx,
            'Logged out of Gemini Web. Stored credentials and cached models removed.',
          );
        } catch (err) {
          emitCommandOutput(
            ctx,
            `Failed to log out: ${safeWebError(err)}`,
            'error',
          );
        }
      });
    },
  });

  pi.registerCommand('gemini-web.status', {
    description: 'Show Gemini Web provider status, slot, and disclosures',
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        emitCommandOutput(ctx, 'Usage: /gemini-web.status takes no arguments.', 'error');
        return;
      }
      await runCommand(ctx, async (signal) => {
        try {
          const cred = await store.read(signal);
          if (!cred) {
            emitCommandOutput(
              ctx,
              [
                'Gemini Web Provider Status:',
                '• Status: Not configured (run /gemini-web.import <path> --auth-user <N>)',
                '• Mode: Buffered Web responses (not real streaming)',
                '• Tool Calling: Prompt-based bridge with Pi validation (not native)',
                '• Reasoning: Adjustable via /thinking (low/medium/high, default low; unverified server compliance)',
                '• Usage/Cost: Unmeasured (reported 0 placeholders are unmeasured, not free)',
                '• Limits: Planning limits (context 32768, output 8192); real Web limits unknown',
              ].join('\n'),
            );
            return;
          }

          const ageMs = cred.catalogCheckedAt ? Date.now() - cred.catalogCheckedAt : undefined;
          const ageStr = ageMs !== undefined ? `${Math.round(ageMs / 60000)}m ago` : 'never';

          emitCommandOutput(
            ctx,
            [
              'Gemini Web Provider Status:',
              `• Status: Configured (Google auth-user slot: ${cred.authUser})`,
              `• Models: ${cred.models.length} model(s) discovered (checked ${ageStr})`,
              '• Mode: Buffered Web responses (not real streaming)',
              '• Tool Calling: Prompt-based bridge with Pi validation (not native)',
              '• Reasoning: Adjustable via /thinking (low/medium/high, default low; unverified server compliance)',
              '• Usage/Cost: Unmeasured (reported 0 placeholders are unmeasured, not free)',
              '• Limits: Planning limits (context 32768, output 8192); real Web limits unknown',
            ].join('\n'),
          );
        } catch (err) {
          emitCommandOutput(
            ctx,
            `Failed to get status: ${safeWebError(err)}`,
            'error',
          );
        }
      });
    },
  });

  pi.on('session_shutdown', async () => {
    for (const controller of activeCommandControllers) {
      controller.abort(new GeminiWebError('closed'));
    }
    activeCommandControllers.clear();
    if (client) {
      client.close();
      client = undefined;
    }
  });
}
