// Integration tests for Gemini Web provider (Stage 3)
// Adapted from gemini-web-to-api (https://github.com/ntthanh2603/gemini-web-to-api)
// Pinned upstream commit: 1f1577dbd479d5b61a1c5f03de742ffcdeb51f6d
// Copyright (c) 2025 Nguyễn Tuấn Thành
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { getSupportedThinkingLevels, Type } from '@earendil-works/pi-ai';
import type {
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
  Api,
} from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  CookieCredentialStore,
  type CookieCredential,
} from '../extensions/gemini-web/auth.ts';
import {
  createGeminiWebClient,
  type GeminiWebClient,
} from '../extensions/gemini-web/client.ts';
import geminiWebExtension, {
  toPiModel,
  PROVIDER_ID,
  GEMINI_WEB_API,
} from '../extensions/gemini-web/index.ts';
import {
  createGeminiWebStream,
} from '../extensions/gemini-web/stream.ts';
import {
  type WebModel,
} from '../extensions/gemini-web/protocol.ts';
import {
  createSyntheticDiscoveryFetch,
  createSyntheticGenerateFetch,
  createTestCredential,
  makeSyntheticBootstrapHtml,
  makeSyntheticDiscoveryPayload,
  makeSyntheticGenerationPayload,
  sampleWebModel,
  withTempDir,
} from './helpers/gemini-web.ts';

const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get weather for a location',
  parameters: Type.Object({
    location: Type.String(),
  }),
};

test('toPiModel: maps discovered WebModel to Pi Model with planning limits and unmeasured usage placeholders', () => {
  const piModel = toPiModel(sampleWebModel);
  assert.equal(piModel.id, 'gemini-pro-web');
  assert.equal(piModel.name, 'Gemini Pro Web');
  assert.equal(piModel.api, GEMINI_WEB_API);
  assert.equal(piModel.provider, PROVIDER_ID);
  assert.equal(piModel.baseUrl, 'https://gemini.google.com');
  assert.equal(piModel.reasoning, true);
  assert.deepEqual(getSupportedThinkingLevels(piModel), ['low', 'medium', 'high']);
  assert.deepEqual(piModel.input, ['text']);
  assert.equal(piModel.contextWindow, 32768);
  assert.equal(piModel.maxTokens, 8192);
  assert.deepEqual(piModel.cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test('geminiWebExtension: registers provider with empty models when unconfigured, zero network calls', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    let registeredProvider: any;
    const commands = new Map<string, any>();
    const listeners = new Map<string, any>();

    let networkCalled = false;
    const fakeFetch = (async () => {
      networkCalled = true;
      throw new Error('Network must not be called during startup');
    }) as any;

    const fakePi: ExtensionAPI = {
      registerProvider: (name: string, config: any) => {
        registeredProvider = { name, ...config };
      },
      registerCommand: (name: string, def: any) => {
        commands.set(name, def);
      },
      on: (event: string, handler: any) => {
        listeners.set(event, handler);
      },
    } as any;

    await geminiWebExtension(fakePi, store, { fetch: fakeFetch });

    assert.equal(networkCalled, false);
    assert.ok(registeredProvider);
    assert.equal(registeredProvider.name, 'Gemini Web (cookie session; buffered)');
    assert.equal(registeredProvider.apiKey, undefined);
    assert.deepEqual(registeredProvider.models, []);
    assert.ok(commands.has('gemini-web.import'));
    assert.ok(commands.has('gemini-web.refresh'));
    assert.ok(commands.has('gemini-web.logout'));
    assert.ok(commands.has('gemini-web.status'));
    assert.ok(listeners.has('session_shutdown'));
  });
});

test('geminiWebExtension: registers provider with cached models when credentials exist, zero network calls', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    const initialCred = createTestCredential({
      revision: 'rev-init',
      catalogCheckedAt: Date.now(),
    });
    await store.save(initialCred);

    let registeredProvider: any;
    let networkCalled = false;
    const fakeFetch = (async () => {
      networkCalled = true;
      throw new Error('Network must not be called during startup');
    }) as any;

    const fakePi: ExtensionAPI = {
      registerProvider: (name: string, config: any) => {
        registeredProvider = { name, ...config };
      },
      registerCommand: () => {},
      on: () => {},
    } as any;

    await geminiWebExtension(fakePi, store, { fetch: fakeFetch });

    assert.equal(networkCalled, false);
    assert.ok(registeredProvider);
    assert.equal(registeredProvider.apiKey, 'gemini-web-cookie-session');
    assert.equal(registeredProvider.models.length, 1);
    assert.equal(registeredProvider.models[0].id, 'gemini-pro-web');
    assert.equal(registeredProvider.models[0].name, 'Gemini Pro Web');
  });
});

test('gemini-web.status command: discloses buffered/unmeasured limitations without leaking secrets', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    const commands = new Map<string, any>();
    const fakePi: ExtensionAPI = {
      registerProvider: () => {},
      registerCommand: (name: string, def: any) => {
        commands.set(name, def);
      },
      on: () => {},
    } as any;

    await geminiWebExtension(fakePi, store);

    const statusCmd = commands.get('gemini-web.status');
    assert.ok(statusCmd);

    const notifications: string[] = [];
    const ctx: ExtensionCommandContext = {
      hasUI: true,
      ui: {
        notify: (text: string) => {
          notifications.push(text);
        },
      },
    } as any;

    // 1. Unconfigured status
    await statusCmd.handler('', ctx);
    const unconfigured = notifications.pop()!;
    assert.match(unconfigured, /Not configured/);
    assert.match(unconfigured, /Buffered Web responses/);
    assert.match(unconfigured, /Prompt-based bridge/);
    assert.match(unconfigured, /Reasoning: Adjustable via \/thinking/);
    assert.match(unconfigured, /Unmeasured/);
    assert.match(unconfigured, /planning limits/i);

    // 2. Configured status
    await store.save(createTestCredential({
      revision: 'rev-status',
      cookieHeader: '__Secure-1PSID=SECRET123; __Secure-1PSIDTS=SECRET456',
      authUser: 2,
      catalogCheckedAt: Date.now(),
    }));

    await statusCmd.handler('', ctx);
    const configured = notifications.pop()!;
    assert.match(configured, /Google auth-user slot: 2/);
    assert.match(configured, /1 model\(s\) discovered/);
    assert.match(configured, /Reasoning: Adjustable via \/thinking/);
    assert.doesNotMatch(configured, /SECRET123/);
    assert.doesNotMatch(configured, /SECRET456/);
    assert.match(configured, /Unmeasured/);
  });
});

test('gemini-web.import command: validates 0600 file, saves credential, refreshes catalog, and rejects bad args', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    const commands = new Map<string, any>();
    let lastRegisteredModels: any[] = [];

    const fakePi: ExtensionAPI = {
      registerProvider: (_name: string, config: any) => {
        lastRegisteredModels = config.models;
      },
      registerCommand: (name: string, def: any) => {
        commands.set(name, def);
      },
      on: () => {},
    } as any;

    // Fake fetch for import discovery
    const fakeFetch = createSyntheticDiscoveryFetch([sampleWebModel]);

    await geminiWebExtension(fakePi, store, { fetch: fakeFetch });

    const importCmd = commands.get('gemini-web.import');
    assert.ok(importCmd);

    const notifications: Array<{ text: string; type?: string }> = [];
    const ctx: ExtensionCommandContext = {
      hasUI: true,
      ui: {
        notify: (text: string, type?: string) => {
          notifications.push({ text, type });
        },
      },
    } as any;

    // 1. Missing --auth-user
    await importCmd.handler('/tmp/cookies.txt', ctx);
    const err1 = notifications.pop()!;
    assert.equal(err1.type, 'error');
    assert.match(err1.text, /Usage: \/gemini-web\.import/);
    assert.doesNotMatch(err1.text, /\/tmp\/cookies\.txt/); // Does not echo path

    // 2. Valid import file
    const cookieFile = join(dir, 'source-cookies.txt');
    writeFileSync(
      cookieFile,
      '__Secure-1PSID=psid_imp; __Secure-1PSIDTS=psidts_imp\n',
      { mode: 0o600 },
    );
    chmodSync(cookieFile, 0o600);

    // 3. Reject secret cookie input literal directly in args
    await importCmd.handler('__Secure-1PSID=secret_cookie_val; --auth-user 0', ctx);
    const errSecret = notifications.pop()!;
    assert.equal(errSecret.type, 'error');
    assert.match(errSecret.text, /Do not pass cookies directly/);

    await importCmd.handler(`"${cookieFile}" --auth-user 1`, ctx);
    const succ = notifications.pop()!;
    assert.match(succ.text, /Imported Gemini Web session \(slot 1, 1 model\(s\) discovered\)/);
    assert.equal(lastRegisteredModels.length, 1);
    assert.equal(lastRegisteredModels[0].id, 'gemini-pro-web');
    assert.equal(lastRegisteredModels[0].name, 'Gemini Pro Web');

    // Verify persisted store
    const saved = await store.read();
    assert.ok(saved);
    assert.equal(saved.authUser, 1);
    assert.match(saved.cookieHeader, /psid_imp/);
    assert.equal(saved.models.length, 1);
  });
});

test('gemini-web.import command: creates missing nested provider subdirectory with 0700 permissions and succeeds', async () => {
  await withTempDir(async (dir) => {
    // Nested provider directory does not exist initially!
    const nestedDir = join(dir, 'sub1', 'gemini-web');
    const storePath = join(nestedDir, 'credentials.json');
    const store = new CookieCredentialStore(storePath);

    const commands = new Map<string, any>();
    const fakePi: ExtensionAPI = {
      registerProvider: () => {},
      registerCommand: (name: string, def: any) => {
        commands.set(name, def);
      },
      on: () => {},
    } as any;

    const fakeFetch = createSyntheticDiscoveryFetch([sampleWebModel]);

    await geminiWebExtension(fakePi, store, { fetch: fakeFetch });

    const importCmd = commands.get('gemini-web.import');
    assert.ok(importCmd);

    const cookieFile = join(dir, 'source-cookies.txt');
    writeFileSync(
      cookieFile,
      '__Secure-1PSID=psid_first_install; __Secure-1PSIDTS=psidts_first_install\n',
      { mode: 0o600 },
    );
    chmodSync(cookieFile, 0o600);

    const notifications: Array<{ text: string; type?: string }> = [];
    const ctx: ExtensionCommandContext = {
      hasUI: true,
      ui: {
        notify: (text: string, type?: string) => {
          notifications.push({ text, type });
        },
      },
    } as any;

    await importCmd.handler(`"${cookieFile}" --auth-user 0`, ctx);
    const succ = notifications.pop()!;
    assert.match(succ.text, /Imported Gemini Web session/);

    // Verify parent directory was created with 0700
    const statDir = await import('node:fs/promises').then((fs) => fs.lstat(nestedDir));
    assert.equal(statDir.isDirectory(), true);
    assert.equal(statDir.mode & 0o777, 0o700);

    // Verify credential was saved with 0600
    const statFile = await import('node:fs/promises').then((fs) => fs.lstat(storePath));
    assert.equal(statFile.isFile(), true);
    assert.equal(statFile.mode & 0o777, 0o600);

    const saved = await store.read();
    assert.ok(saved);
    assert.equal(saved.authUser, 0);
    assert.match(saved.cookieHeader, /psid_first_install/);
  });
});

test('commands reject unexpected arguments and session_shutdown aborts commands and client', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    const commands = new Map<string, any>();
    const listeners = new Map<string, any>();

    const fakePi: ExtensionAPI = {
      registerProvider: () => {},
      registerCommand: (name: string, def: any) => {
        commands.set(name, def);
      },
      on: (event: string, handler: any) => {
        listeners.set(event, handler);
      },
    } as any;

    await geminiWebExtension(fakePi, store);

    const notifications: Array<{ text: string; type?: string }> = [];
    const ctx: ExtensionCommandContext = {
      hasUI: true,
      ui: {
        notify: (text: string, type?: string) => {
          notifications.push({ text, type });
        },
      },
    } as any;

    // Reject unexpected args
    const refreshCmd = commands.get('gemini-web.refresh');
    await refreshCmd.handler('unexpected_arg', ctx);
    assert.equal(notifications.pop()!.type, 'error');

    const logoutCmd = commands.get('gemini-web.logout');
    await logoutCmd.handler('unexpected_arg', ctx);
    assert.equal(notifications.pop()!.type, 'error');

    const statusCmd = commands.get('gemini-web.status');
    await statusCmd.handler('unexpected_arg', ctx);
    assert.equal(notifications.pop()!.type, 'error');

    // session_shutdown is idempotent and cleans up
    const shutdown = listeners.get('session_shutdown');
    assert.ok(shutdown);
    await shutdown();
    await shutdown(); // Idempotent second call does not throw
  });
});

test('gemini-web.logout command: closes client, deletes credentials under lock, and clears models', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    await store.save(createTestCredential({
      revision: 'rev-logout',
    }));

    const commands = new Map<string, any>();
    let lastRegisteredModels: any[] = [sampleWebModel];
    let unregisterCalled = false;

    const fakePi: ExtensionAPI = {
      registerProvider: (_name: string, config: any) => {
        lastRegisteredModels = config.models;
      },
      unregisterProvider: (name: string) => {
        if (name === PROVIDER_ID) unregisterCalled = true;
      },
      registerCommand: (name: string, def: any) => {
        commands.set(name, def);
      },
      on: () => {},
    } as any;

    await geminiWebExtension(fakePi, store);

    const logoutCmd = commands.get('gemini-web.logout');
    assert.ok(logoutCmd);

    const notifications: string[] = [];
    const ctx: ExtensionCommandContext = {
      hasUI: true,
      ui: {
        notify: (text: string) => {
          notifications.push(text);
        },
      },
    } as any;

    await logoutCmd.handler('', ctx);
    assert.match(notifications.pop()!, /Logged out of Gemini Web/);
    assert.deepEqual(lastRegisteredModels, []);
    assert.equal(unregisterCalled, true);

    const remaining = await store.read();
    assert.equal(remaining, undefined);
  });
});

test('createGeminiWebStream: full buffered text generation with balanced events and zero usage', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    await store.save(createTestCredential({
      revision: 'rev-gen-text',
      cookieHeader: '__Secure-1PSID=psid_val; __Secure-1PSIDTS=psidts_val',
    }));

    const fakeFetch = createSyntheticGenerateFetch('Hello from Gemini Web!');

    const client = createGeminiWebClient(store, { fetch: fakeFetch });
    const streamFactory = createGeminiWebStream(() => client);

    const piModel = toPiModel(sampleWebModel);
    const context: Context = {
      messages: [{ role: 'user', content: 'Say hello', timestamp: 1000 }],
    };

    let responseSeen = false;
    let payloadSeen = false;
    const streamOptions: SimpleStreamOptions = {
      reasoning: 'high',
      onPayload: (payload, model) => {
        payloadSeen = true;
        assert.equal(model.id, piModel.id);
        assert.ok((payload as any).prompt.includes('Say hello'));
      },
      onResponse: (response, model) => {
        responseSeen = true;
        assert.equal(response.status, 200);
        assert.equal(model.id, piModel.id);
      },
    };

    const stream = streamFactory(piModel, context, streamOptions);
    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    assert.equal(payloadSeen, true);
    assert.equal(responseSeen, true);

    // Verify balanced event sequence
    assert.equal(events[0].type, 'start');
    assert.equal(events[1].type, 'text_start');
    assert.equal(events[1].contentIndex, 0);
    assert.equal(events[2].type, 'text_delta');
    assert.equal(events[2].delta, 'Hello from Gemini Web!');
    assert.equal(events[3].type, 'text_end');
    assert.equal(events[3].content, 'Hello from Gemini Web!');
    assert.equal(events[4].type, 'done');
    assert.equal(events[4].reason, 'stop');

    // Verify final message result
    const finalMsg = await stream.result();
    assert.equal(finalMsg.role, 'assistant');
    assert.equal(finalMsg.stopReason, 'stop');
    assert.equal(finalMsg.providerThinkingLevel, 'high');
    assert.equal(finalMsg.content.length, 1);
    assert.equal((finalMsg.content[0] as any).text, 'Hello from Gemini Web!');
    assert.deepEqual(finalMsg.usage, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });
});

test('createGeminiWebStream: balanced thinking events then text with dynamic contentIndex', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    await store.save(createTestCredential({
      revision: 'rev-gen-thinking',
    }));

    const thinkingPayload =
      '<ctrl94>thought\nInvestigating query thoroughly...\n<ctrl95>\nHello with thinking!';

    const fakeFetch = createSyntheticGenerateFetch(thinkingPayload);

    const client = createGeminiWebClient(store, { fetch: fakeFetch });
    const streamFactory = createGeminiWebStream(() => client);
    const piModel = toPiModel(sampleWebModel);
    const context: Context = {
      messages: [{ role: 'user', content: 'Say hello with thinking', timestamp: 1000 }],
    };

    const stream = streamFactory(piModel, context, { reasoning: 'high' });
    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Verify event sequence: start -> thinking (0) -> text (1) -> done
    assert.equal(events[0].type, 'start');

    assert.equal(events[1].type, 'thinking_start');
    assert.equal(events[1].contentIndex, 0);

    assert.equal(events[2].type, 'thinking_delta');
    assert.equal(events[2].contentIndex, 0);
    assert.equal(events[2].delta, 'Investigating query thoroughly...');

    assert.equal(events[3].type, 'thinking_end');
    assert.equal(events[3].contentIndex, 0);
    assert.equal(events[3].content, 'Investigating query thoroughly...');

    assert.equal(events[4].type, 'text_start');
    assert.equal(events[4].contentIndex, 1); // Dynamic contentIndex!

    assert.equal(events[5].type, 'text_delta');
    assert.equal(events[5].contentIndex, 1);
    assert.equal(events[5].delta, 'Hello with thinking!');

    assert.equal(events[6].type, 'text_end');
    assert.equal(events[6].contentIndex, 1);
    assert.equal(events[6].content, 'Hello with thinking!');

    assert.equal(events[7].type, 'done');
    assert.equal(events[7].reason, 'stop');

    const finalMsg = await stream.result();
    assert.equal(finalMsg.content.length, 2);
    assert.equal((finalMsg.content[0] as any).type, 'thinking');
    assert.equal((finalMsg.content[0] as any).thinking, 'Investigating query thoroughly...');
    assert.equal((finalMsg.content[1] as any).type, 'text');
    assert.equal((finalMsg.content[1] as any).text, 'Hello with thinking!');
    assert.equal(finalMsg.providerThinkingLevel, 'high');
  });
});

test('createGeminiWebStream: thoughts with tool envelope ignores tool-like JSON in thinking and executes validated tool calls', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    await store.save(createTestCredential({
      revision: 'rev-gen-think-tool',
    }));

    // Thinking contains tool-looking JSON that must NOT be executed
    const thinkingAndToolPayload =
      '<ctrl94>thought\nI could call this: {"tool_calls": [{"name": "fake_tool", "arguments": {}}]}\n<ctrl95>\n' +
      JSON.stringify({
        tool_calls: [{ name: 'get_weather', arguments: { location: 'Madrid' } }],
      });

    const fakeFetch = createSyntheticGenerateFetch(thinkingAndToolPayload);

    const client = createGeminiWebClient(store, { fetch: fakeFetch });
    const streamFactory = createGeminiWebStream(() => client);
    const piModel = toPiModel(sampleWebModel);
    const context: Context = {
      tools: [weatherTool],
      messages: [{ role: 'user', content: 'What is the weather in Madrid?', timestamp: 1000 }],
    };

    const stream = streamFactory(piModel, context, { reasoning: 'medium' });
    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Thinking block emitted at contentIndex 0
    assert.equal(events[1].type, 'thinking_start');
    assert.equal(events[1].contentIndex, 0);
    assert.equal(events[3].type, 'thinking_end');
    assert.equal(events[3].contentIndex, 0);
    assert.match(events[3].content, /I could call this/);

    // Tool call emitted at contentIndex 1 (only valid advertised get_weather!)
    assert.equal(events[4].type, 'toolcall_start');
    assert.equal(events[4].contentIndex, 1);
    assert.equal(events[6].type, 'toolcall_end');
    assert.equal(events[6].contentIndex, 1);
    assert.equal(events[6].toolCall.name, 'get_weather');
    assert.deepEqual(events[6].toolCall.arguments, { location: 'Madrid' });

    assert.equal(events[7].type, 'done');
    assert.equal(events[7].reason, 'toolUse');

    const finalMsg = await stream.result();
    assert.equal(finalMsg.content.length, 2);
    assert.equal(finalMsg.content[0].type, 'thinking');
    assert.equal(finalMsg.content[1].type, 'toolCall');
    assert.equal((finalMsg.content[1] as any).name, 'get_weather');
  });
});

test('createGeminiWebStream: bad final tool batch with thoughts does not leak executable calls', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    await store.save(createTestCredential({
      revision: 'rev-bad-tool-think',
    }));

    // Thoughts present, but final tool envelope is invalid (missing required location param)
    const badToolPayload =
      '<ctrl94>thought\nSome thoughts before bad call\n<ctrl95>\n' +
      JSON.stringify({
        tool_calls: [{ name: 'get_weather', arguments: {} }],
      });

    const fakeFetch = createSyntheticGenerateFetch(badToolPayload);

    const client = createGeminiWebClient(store, { fetch: fakeFetch });
    const streamFactory = createGeminiWebStream(() => client);
    const piModel = toPiModel(sampleWebModel);
    const context: Context = {
      tools: [weatherTool],
      messages: [{ role: 'user', content: 'Bad call test', timestamp: 1000 }],
    };

    const stream = streamFactory(piModel, context, { reasoning: 'low' });
    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Must terminate with error without leaking executable tool calls
    assert.equal(events[0].type, 'start');
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.type, 'error');
    assert.equal(lastEvent.reason, 'error');
    assert.match(lastEvent.error.errorMessage, /schema validation failed|tool.*error/i);

    const result = await stream.result();
    assert.equal(result.stopReason, 'error');
    assert.equal(result.content.some((c: any) => c.type === 'toolCall'), false);
  });
});

test('createGeminiWebStream: empty text response succeeds with stop reason stop', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    await store.save(createTestCredential({
      revision: 'rev-gen-empty',
    }));

    const fakeFetch = createSyntheticGenerateFetch('');

    const client = createGeminiWebClient(store, { fetch: fakeFetch });
    const streamFactory = createGeminiWebStream(() => client);

    const piModel = toPiModel(sampleWebModel);
    const context: Context = {
      messages: [{ role: 'user', content: 'Empty test', timestamp: 1000 }],
    };

    const stream = streamFactory(piModel, context);
    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    assert.equal(events[0].type, 'start');
    assert.equal(events[1].type, 'text_start');
    assert.equal(events[2].type, 'text_end');
    assert.equal(events[2].content, '');
    assert.equal(events[3].type, 'done');
    assert.equal(events[3].reason, 'stop');

    const result = await stream.result();
    assert.equal(result.stopReason, 'stop');
    assert.equal((result.content[0] as any).text, '');
  });
});

test('createGeminiWebStream: tool calling with Pi schema validation and multi-turn transcript replay', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    await store.save(createTestCredential({
      revision: 'rev-gen-tool',
    }));

    const toolCallJson = JSON.stringify({
      tool_calls: [
        { name: 'get_weather', arguments: { location: 'Amsterdam' } },
      ],
    });

    const fakeFetch = createSyntheticGenerateFetch(toolCallJson);

    const client = createGeminiWebClient(store, { fetch: fakeFetch });
    const streamFactory = createGeminiWebStream(() => client);
    const piModel = toPiModel(sampleWebModel);

    // Turn 1: user asks for weather, model responds with tool call
    const context1: Context = {
      systemPrompt: 'You are a helpful assistant.',
      tools: [weatherTool],
      messages: [{ role: 'user', content: 'What is the weather in Amsterdam?', timestamp: 1000 }],
    };

    let observedFrame = false;
    const stream1 = streamFactory(piModel, context1, {
      onProviderStreamEvent: async (_event: unknown, model: Model<Api>) => {
        observedFrame = true;
        assert.equal(model.id, piModel.id);
      },
    } as any);

    const events1: any[] = [];
    for await (const event of stream1) {
      events1.push(event);
    }

    assert.equal(observedFrame, true);
    assert.equal(events1[0].type, 'start');
    assert.equal(events1[1].type, 'toolcall_start');
    assert.equal(events1[2].type, 'toolcall_delta');
    assert.equal(events1[3].type, 'toolcall_end');
    assert.equal(events1[3].toolCall.name, 'get_weather');
    assert.deepEqual(events1[3].toolCall.arguments, { location: 'Amsterdam' });
    assert.equal(events1[4].type, 'done');
    assert.equal(events1[4].reason, 'toolUse');

    const result1 = await stream1.result();
    assert.equal(result1.stopReason, 'toolUse');
    assert.equal(result1.content.length, 1);
    const callBlock = result1.content[0] as any;
    assert.equal(callBlock.type, 'toolCall');
    assert.equal(callBlock.name, 'get_weather');

    // Turn 2: replay previous assistant tool call and toolResult in transcript
    const context2: Context = {
      systemPrompt: 'You are a helpful assistant.',
      tools: [weatherTool],
      messages: [
        { role: 'user', content: 'What is the weather in Amsterdam?', timestamp: 1000 },
        result1,
        {
          role: 'toolResult',
          toolCallId: callBlock.id,
          content: 'Sunny, 20C',
          isError: false,
          timestamp: 2000,
        } as any,
      ],
    };

    let promptReplayed = '';
    const stream2 = streamFactory(piModel, context2, {
      onPayload: (payload: any) => {
        promptReplayed = payload.prompt;
      },
    });

    for await (const _event of stream2) {
      // consume
    }

    assert.ok(promptReplayed.includes('Amsterdam'));
    assert.ok(promptReplayed.includes('Sunny, 20C'));
  });
});

test('createGeminiWebStream: malformed tool envelope fails stream with error code tools', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    await store.save(createTestCredential({
      revision: 'rev-bad-tool',
    }));

    // Model outputs tool_calls with missing required parameter 'location'
    const badToolJson = JSON.stringify({
      tool_calls: [{ name: 'get_weather', arguments: {} }],
    });

    const fakeFetch = createSyntheticGenerateFetch(badToolJson);

    const client = createGeminiWebClient(store, { fetch: fakeFetch });
    const streamFactory = createGeminiWebStream(() => client);

    const piModel = toPiModel(sampleWebModel);
    const context: Context = {
      tools: [weatherTool],
      messages: [{ role: 'user', content: 'Bad tool test', timestamp: 1000 }],
    };

    const stream = streamFactory(piModel, context);
    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Must emit start (from onResponse) then error
    assert.equal(events[0].type, 'start');
    const errEvent = events[events.length - 1];
    assert.equal(errEvent.type, 'error');
    assert.equal(errEvent.reason, 'error');
    assert.match(errEvent.error.errorMessage, /schema validation failed|tool.*error/i);

    const result = await stream.result();
    assert.equal(result.stopReason, 'error');
  });
});

test('createGeminiWebStream: abort signal terminates stream cleanly with stopReason aborted', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    await store.save(createTestCredential({
      revision: 'rev-abort',
    }));

    const abortController = new AbortController();

    const fakeFetch = (async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('gemini.google.com/u/0/app')) {
        return new Response(makeSyntheticBootstrapHtml(), { status: 200 });
      }
      if (u.includes('StreamGenerate')) {
        abortController.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      throw new Error(`Unexpected fetch: ${u}`);
    }) as any;

    const client = createGeminiWebClient(store, { fetch: fakeFetch });
    const streamFactory = createGeminiWebStream(() => client);

    const piModel = toPiModel(sampleWebModel);
    const context: Context = {
      messages: [{ role: 'user', content: 'Abort me', timestamp: 1000 }],
    };

    const stream = streamFactory(piModel, context, {
      signal: abortController.signal,
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const errEvent = events[events.length - 1];
    assert.equal(errEvent.type, 'error');
    assert.equal(errEvent.reason, 'aborted');
    assert.match(errEvent.error.errorMessage, /aborted/i);

    const result = await stream.result();
    assert.equal(result.stopReason, 'aborted');
  });
});

test('createGeminiWebStream: unsupported image input terminates with safe error before start', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    const client = createGeminiWebClient(store);
    const streamFactory = createGeminiWebStream(() => client);

    const piModel = toPiModel(sampleWebModel);
    const contextWithImage: Context = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: 'synthetic_img', mimeType: 'image/png' }],
          timestamp: 1000,
        } as any,
      ],
    };

    const stream = streamFactory(piModel, contextWithImage);
    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Terminated directly with error before start
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].reason, 'error');
    assert.match(events[0].error.errorMessage, /unsupported/i);

    const result = await stream.result();
    assert.equal(result.stopReason, 'error');
  });
});

test('createGeminiWebStream: unsupported reasoning levels, deferred, or token budgets fail with safe error before network', async () => {
  await withTempDir(async (dir) => {
    const store = new CookieCredentialStore(join(dir, 'credentials.json'));
    const client = createGeminiWebClient(store);
    const streamFactory = createGeminiWebStream(() => client);

    const piModel = toPiModel(sampleWebModel);
    const context: Context = {
      messages: [{ role: 'user', content: 'Unsupported test', timestamp: 1000 }],
    };

    // 1. Literal 'off' fails safely (cannot disable backend reasoning)
    {
      const stream = streamFactory(piModel, context, { reasoning: 'off' as any });
      const events: any[] = [];
      for await (const event of stream) events.push(event);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'error');
      assert.match(events[0].error.errorMessage, /unsupported/i);
    }

    // 2. Unsupported level 'xhigh'
    {
      const stream = streamFactory(piModel, context, { reasoning: 'xhigh' as any });
      const events: any[] = [];
      for await (const event of stream) events.push(event);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'error');
      assert.match(events[0].error.errorMessage, /unsupported/i);
    }

    // 3. Deferred execution
    {
      const stream = streamFactory(piModel, context, { deferred: true } as any);
      const events: any[] = [];
      for await (const event of stream) events.push(event);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'error');
      assert.match(events[0].error.errorMessage, /unsupported/i);
    }

    // 4. Token budgets
    {
      const stream = streamFactory(piModel, context, { thinkingBudgets: {} } as any);
      const events: any[] = [];
      for await (const event of stream) events.push(event);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'error');
      assert.match(events[0].error.errorMessage, /unsupported/i);
    }
  });
});
