import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context, Message, Tool } from '@earendil-works/pi-ai';
import { Type } from '@earendil-works/pi-ai';
import {
  PROVIDER_ID,
  GEMINI_WEB_API,
  GeminiWebError,
  safeWebError,
  getFriendlyModelId,
  getFriendlyModelName,
  deriveBaseModelSlug,
  extractThinkingAndText,
  parseBootstrap,
  decodeWebFrames,
  parseModelCatalog,
  buildDiscoveryRequest,
  buildGenerateRequest,
  parseGeneration,
  preparePrompt,
  decodeReply,
  type WebSession,
  type WebModel,
  type WebThinkingLevel,
} from '../extensions/gemini-web/protocol.ts';

// Sample TypeBox tools for testing
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get weather for a location',
  parameters: Type.Object({
    location: Type.String(),
    unit: Type.Optional(Type.Union([Type.Literal('celsius'), Type.Literal('fahrenheit')])),
  }),
};

const calcTool: Tool = {
  name: 'calculate',
  description: 'Evaluate a math expression',
  parameters: Type.Object({
    expression: Type.String(),
  }),
};

test('GeminiWebError: produces fixed safe messages and codes without secret leakage', () => {
  const err = new GeminiWebError('auth');
  assert.equal(err.code, 'auth');
  assert.equal(err.name, 'GeminiWebError');
  assert.match(err.message, /authentication failed/i);
  assert.equal(safeWebError(err), err.message);

  const httpErr = new GeminiWebError('http', 403);
  assert.equal(httpErr.status, 403);
  assert.match(httpErr.message, /403/);
  assert.equal(safeWebError(httpErr), httpErr.message);

  // Unknown generic errors stay safe
  assert.equal(safeWebError(new Error('Sensitive database credentials leak!')), 'Gemini Web operation failed.');
  assert.equal(safeWebError(new Error('This operation was aborted by caller')), 'Operation was aborted.');
});

test('parseBootstrap: extracts tokens, handles escapes, and provides defaults', () => {
  // Standard object format
  const html1 = '<html><script>window.WIZ_global_data = {"SNlM0e":"sec_tok_123","cfb2h":"b_456","FdrFJe":"sid_789","TuX5cc":"fr"};</script></html>';
  const boot1 = parseBootstrap(html1);
  assert.equal(boot1.at, 'sec_tok_123');
  assert.equal(boot1.buildLabel, 'b_456');
  assert.equal(boot1.sessionId, 'sid_789');
  assert.equal(boot1.language, 'fr');

  // Fallback array format and escaped quotes
  const html2 = 'var data = [\\"SNlM0e\\",\\"tok\\\\\\\"escaped\\\\\\\"\\"];';
  const boot2 = parseBootstrap(html2);
  assert.equal(boot2.at, 'tok\\"escaped\\"');
  assert.equal(boot2.buildLabel, '');
  assert.equal(boot2.sessionId, '');
  assert.equal(boot2.language, 'en');

  // Missing or empty token throws auth error
  assert.throws(() => parseBootstrap('<html>no token here</html>'), (err: any) => err instanceof GeminiWebError && err.code === 'auth');
  assert.throws(() => parseBootstrap('{"SNlM0e":""}'), (err: any) => err instanceof GeminiWebError && err.code === 'auth');
});

test('decodeWebFrames: handles XSSI guard, multiline roots, and numeric length framing', () => {
  // Empty or whitespace-only
  assert.deepEqual(decodeWebFrames(")]}'\n\n"), []);
  assert.deepEqual(decodeWebFrames(''), []);

  // Multiple un-prefixed roots
  const unPrefixed = ")]}'\n[[\"wrb.fr\",null,\"p1\"]]\n[[\"wrb.fr\",null,\"p2\"]]\n";
  const frames1 = decodeWebFrames(unPrefixed);
  assert.equal(frames1.length, 2);
  assert.deepEqual(frames1[0], [['wrb.fr', null, 'p1']]);
  assert.deepEqual(frames1[1], [['wrb.fr', null, 'p2']]);

  // Multiline JSON roots
  const multiline = ")]}'\n[\n  [\"wrb.fr\",\n   null,\n   \"p1\"\n  ]\n]\n";
  const frames2 = decodeWebFrames(multiline);
  assert.equal(frames2.length, 1);
  assert.deepEqual(frames2[0], [['wrb.fr', null, 'p1']]);

  // Numeric length framing with UTF-8 multibyte characters (Unicode / emoji)
  const unicodePayload = JSON.stringify([['wrb.fr', null, 'こんにちは 🚀 Earth 🌍']]);
  const byteLen = Buffer.byteLength(unicodePayload, 'utf8');
  const lengthFramed = `)]}'\n${byteLen}\n${unicodePayload}\n`;
  const frames3 = decodeWebFrames(lengthFramed);
  assert.equal(frames3.length, 1);
  assert.deepEqual(frames3[0], [['wrb.fr', null, 'こんにちは 🚀 Earth 🌍']]);

  // Dummy length numbers in test fixtures (interleaved framing numbers)
  const fixture = `)]}'\n\n42\n[["wrb.fr","other-rpc","[]"]]\n${byteLen}\n${unicodePayload}\n12\n[["di",0]]\n`;
  const frames4 = decodeWebFrames(fixture);
  assert.equal(frames4.length, 3);
  assert.deepEqual(frames4[0], [['wrb.fr', 'other-rpc', '[]']]);
  assert.deepEqual(frames4[1], [['wrb.fr', null, 'こんにちは 🚀 Earth 🌍']]);
  assert.deepEqual(frames4[2], [['di', 0]]);

  // Truncated frame throws protocol error
  assert.throws(() => decodeWebFrames(')]}\'\n100\n[["wrb.fr",'), (err: any) => err instanceof GeminiWebError && err.code === 'protocol');
  assert.throws(() => decodeWebFrames(')]}\'\n[["wrb.fr", "unclosed'), (err: any) => err instanceof GeminiWebError && err.code === 'protocol');
  assert.throws(() => decodeWebFrames(')]}\'\n[invalid json]'), (err: any) => err instanceof GeminiWebError && err.code === 'protocol');
});

function makeModelRecord(statusCode: any, tiers: any, caps: any, entries: any[]): unknown {
  const status = new Array(18).fill(null);
  status[14] = statusCode;
  status[15] = entries;
  status[16] = tiers;
  status[17] = caps;
  return [['wrb.fr', 'otAQ7b', JSON.stringify(status), null, null, null, 'generic']];
}

test('parseModelCatalog: parses account models, validates status and capacity flags, and deduplicates', () => {
  const entries = [
    ['model-flash', 'Fast', null, null, null, null, null, null, null, 1, null, 'Gemini 2.0 Flash', null, null, null, null, null, 1],
    ['model-pro', 'Pro', null, null, null, null, null, null, null, 3, null, 'Gemini 1.5 Pro', null, null, null, null, null, 3],
    ['model-flash', 'Fast Dupe', null, null, null, null, null, null, null, 1, null, 'Gemini 2.0 Flash', null, null, null, null, null, 1],
  ];

  // Tier 21 -> capacity 1, capacityField 13
  const frames1 = [makeModelRecord(1000, [21], [], entries)];
  const catalog1 = parseModelCatalog(frames1);
  assert.equal(catalog1.length, 2);
  assert.equal(catalog1[0].id, 'model-flash');
  assert.equal(catalog1[0].name, 'Gemini 2.0 Flash');
  assert.equal(catalog1[0].capacity, 1);
  assert.equal(catalog1[0].capacityField, 13);
  assert.equal(catalog1[0].modelNumber, 1);
  assert.equal(catalog1[1].id, 'model-pro');
  assert.equal(catalog1[1].modelNumber, 3);

  // Capability 115 -> capacity 4, capacityField 12
  const frames2 = [makeModelRecord(1000, [], [115], entries)];
  const catalog2 = parseModelCatalog(frames2);
  assert.equal(catalog2[0].capacity, 4);
  assert.equal(catalog2[0].capacityField, 12);

  // Default capacity -> 1, 12
  const frames3 = [makeModelRecord(1000, [], [], entries)];
  const catalog3 = parseModelCatalog(frames3);
  assert.equal(catalog3[0].capacity, 1);
  assert.equal(catalog3[0].capacityField, 12);

  // Status not 1000 throws auth error
  assert.throws(() => parseModelCatalog([makeModelRecord(2000, [], [], entries)]), (err: any) => err instanceof GeminiWebError && err.code === 'auth');

  // RPC rejection at index 5 throws auth error
  const rejectedRecord = [['wrb.fr', 'otAQ7b', '[]', null, null, [2]]];
  assert.throws(() => parseModelCatalog([rejectedRecord]), (err: any) => err instanceof GeminiWebError && err.code === 'auth');

  // Empty catalog throws model error
  assert.throws(() => parseModelCatalog([makeModelRecord(1000, [], [], [])]), (err: any) => err instanceof GeminiWebError && err.code === 'model');
});

test('buildDiscoveryRequest: constructs exact wire URL and headers for slot 0 and slot N', () => {
  const session: WebSession = {
    at: 'token_abc',
    buildLabel: 'bl_123',
    sessionId: 'sid_456',
    language: 'en',
    authUser: 0,
    generationId: 'gen_uuid_789',
  };

  const req0 = buildDiscoveryRequest(session, 10001);
  assert.equal(req0.method, 'POST');
  assert.match(req0.url, /^https:\/\/gemini\.google\.com\/u\/0\/_\/BardChatUi\/data\/batchexecute\?/);
  assert.match(req0.url, /rpcids=otAQ7b/);
  assert.match(req0.url, /source-path=%2Fu%2F0%2Fapp/);
  assert.match(req0.url, /_reqid=10001/);
  assert.match(req0.url, /bl=bl_123/);
  assert.match(req0.url, /f\.sid=sid_456/);

  // Selector header has length 17, 1 at 0, [4,5,6,8] at 8, generationId at 16
  const selector = JSON.parse(req0.headers['x-goog-ext-525001261-jspb']);
  assert.equal(selector.length, 17);
  assert.equal(selector[0], 1);
  assert.deepEqual(selector[8], [4, 5, 6, 8]);
  assert.equal(selector[16], 'gen_uuid_789');
  assert.equal(req0.headers['x-goog-ext-73010989-jspb'], '[0]');

  // Form body contains at and generic otAQ7b req
  assert.match(req0.body, /at=token_abc/);
  assert.match(req0.body, /f\.req=/);

  // Invalid authUser throws protocol error
  assert.throws(() => buildDiscoveryRequest({ ...session, authUser: -1 }, 10001), (err: any) => err instanceof GeminiWebError && err.code === 'protocol');
  assert.throws(() => buildDiscoveryRequest({ ...session, authUser: 1.5 }, 10001), (err: any) => err instanceof GeminiWebError && err.code === 'protocol');
});

test('buildGenerateRequest: constructs exact 81-slot payload, model header offset, and auxiliary headers', () => {
  const session: WebSession = {
    at: 'token_abc',
    buildLabel: 'bl_123',
    sessionId: 'sid_456',
    language: 'en',
    authUser: 2,
    generationId: 'gen_uuid_789',
  };

  const model12: WebModel = {
    id: 'models/gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    capacity: 2,
    capacityField: 12,
    modelNumber: 1,
  };

  const req12 = buildGenerateRequest(session, model12, { prompt: 'Hello world' }, 'req_uuid_001', 20002);
  assert.equal(req12.method, 'POST');
  assert.match(req12.url, /^https:\/\/gemini\.google\.com\/u\/2\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate\?/);
  assert.match(req12.url, /at=token_abc/);

  // Model header for capacityField 12 (offset 0 -> length 17)
  const header12 = JSON.parse(req12.headers['x-goog-ext-525001261-jspb']);
  assert.equal(header12.length, 17);
  assert.equal(header12[0], 1);
  assert.equal(header12[4], 'models/gemini-2.0-flash');
  assert.equal(header12[7], 0);
  assert.deepEqual(header12[8], [4, 5, 6, 8]);
  assert.equal(header12[11], 2); // capacity at capacityField - 1
  assert.equal(header12[14], 1); // modelNumber
  assert.equal(header12[15], 1); // default thinking wire value 1
  assert.equal(header12[16], 'gen_uuid_789');

  // Request ID header [requestId, 1]
  assert.equal(req12.headers['x-goog-ext-525005358-jspb'], JSON.stringify(['req_uuid_001', 1]));
  assert.equal(req12.headers['x-goog-ext-73010989-jspb'], '[0]');
  assert.equal(req12.headers['x-goog-ext-73010990-jspb'], '[0,0,0]');

  // Body: outer [null, JSON.stringify(inner)] with inner length 81
  const formParams = new URLSearchParams(req12.body);
  assert.equal(formParams.get('at'), 'token_abc');
  const outer = JSON.parse(formParams.get('f.req')!);
  assert.equal(outer[0], null);
  const inner = JSON.parse(outer[1]);
  assert.equal(inner.length, 81);
  assert.deepEqual(inner[0], ['Hello world']);
  assert.deepEqual(inner[1], ['en']);
  assert.deepEqual(inner[2], ['', '', '', null, null, null, null, null, null, '']);
  assert.equal(inner[45], 1); // temporary flag
  assert.equal(inner[59], 'req_uuid_001');
  assert.equal(inner[79], 1); // modelNumber
  assert.equal(inner[80], 1); // thinking default wire value

  // Test capacityField 13 (offset 1 -> length 18)
  const model13: WebModel = {
    id: 'models/gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    capacity: 1,
    capacityField: 13,
    modelNumber: 3,
  };
  const req13 = buildGenerateRequest(session, model13, { prompt: 'Hello pro' }, 'req_uuid_002', 20003);
  const header13 = JSON.parse(req13.headers['x-goog-ext-525001261-jspb']);
  assert.equal(header13.length, 18);
  assert.equal(header13[12], 1); // capacity at capacityField - 1 (index 12)
  assert.equal(header13[15], 3); // modelNumber at 14 + offset (index 15)
  assert.equal(header13[16], 1); // thinking default wire value at 15 + offset (index 16)
  assert.equal(header13[17], 'gen_uuid_789'); // generationId at 16 + offset (index 17)
});

test('buildGenerateRequest: wire levels for low/medium/high, capacityField 12 and 13, and rejection of unsupported levels', () => {
  const session: WebSession = {
    at: 'token_abc',
    buildLabel: 'bl_123',
    sessionId: 'sid_456',
    language: 'en',
    authUser: 0,
    generationId: 'gen_uuid_789',
  };

  const levels: Array<{ level: WebThinkingLevel | undefined; wire: number }> = [
    { level: undefined, wire: 1 },
    { level: 'low', wire: 1 },
    { level: 'medium', wire: 4 },
    { level: 'high', wire: 2 },
  ];

  for (const capacityField of [12, 13] as const) {
    const model: WebModel = {
      id: 'models/gemini-thinking-test',
      name: 'Gemini Thinking Test',
      capacity: 3,
      capacityField,
      modelNumber: 7,
    };
    const offset = capacityField - 12;
    const headerLevelIndex = 15 + offset;

    for (const { level, wire } of levels) {
      const req = buildGenerateRequest(
        session,
        model,
        { prompt: 'Testing thinking' },
        'req_test_uuid',
        10001,
        level,
      );

      // Verify header index 15 + offset
      const header = JSON.parse(req.headers['x-goog-ext-525001261-jspb']);
      assert.equal(header[headerLevelIndex], wire);
      assert.equal(header[4], model.id);
      assert.equal(header[14 + offset], model.modelNumber);
      assert.equal(header[capacityField - 1], model.capacity);
      assert.equal(header[16 + offset], session.generationId);

      // Verify body inner[80]
      const formParams = new URLSearchParams(req.body);
      const outer = JSON.parse(formParams.get('f.req')!);
      const inner = JSON.parse(outer[1]);
      assert.equal(inner[80], wire);
      assert.equal(inner[79], model.modelNumber);
      assert.equal(inner[59], 'req_test_uuid');
      assert.deepEqual(inner[0], ['Testing thinking']);
    }
  }

  // Unsupported levels are rejected before generation
  const modelStd: WebModel = {
    id: 'models/gemini-std',
    name: 'Gemini Std',
    capacity: 1,
    capacityField: 12,
    modelNumber: 1,
  };
  for (const badLevel of ['off', 'none', 'minimal', 'xhigh', 'max', 'deep_think', 'invalid']) {
    assert.throws(
      () =>
        buildGenerateRequest(
          session,
          modelStd,
          { prompt: 'Bad' },
          'req_bad',
          10002,
          badLevel as any,
        ),
      (err: any) => err instanceof GeminiWebError && err.code === 'unsupported',
    );
  }
});

test('parseGeneration: extracts classic candidate text, numbered updates, cumulative updates, and detects BardErrorInfo', () => {
  // Classic candidate snapshot
  const classicFrame = [
    ['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', ['Hello from classic']]]])],
  ];
  const gen1 = parseGeneration([classicFrame]);
  assert.equal(gen1.text, 'Hello from classic');

  // Numbered payload update at payload[2]["7"]
  const numberedFrame = [
    ['wrb.fr', null, JSON.stringify([null, ['c_1', 'r_1'], { '7': ['Hello from numbered'] }])],
  ];
  const gen2 = parseGeneration([numberedFrame]);
  assert.equal(gen2.text, 'Hello from numbered');

  // Cumulative updates: last snapshot wins, including valid empty string
  const cumulativeFrames = [
    [['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', ['First snapshot']]]])]],
    [['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', ['Second snapshot']]]])]],
    [['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', ['']]]])]],
  ];
  const gen3 = parseGeneration(cumulativeFrames);
  assert.equal(gen3.text, '');

  // Legitimate reply text mentioning "BardErrorInfo" succeeds without error
  const textMentionsBardErrorFrame = [
    [
      'wrb.fr',
      null,
      JSON.stringify([
        null,
        null,
        null,
        null,
        [['rc_1', ['Here is an explanation of BardErrorInfo error handling.']]],
      ]),
    ],
  ];
  const genMention = parseGeneration([textMentionsBardErrorFrame]);
  assert.equal(
    genMention.text,
    'Here is an explanation of BardErrorInfo error handling.',
  );

  // Structured BardErrorInfo tag in item[5] throws protocol error, even if earlier frames had text
  const errorFrames = [
    [['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', ['Partial text']]]])]],
    [['wrb.fr', null, null, null, null, [13, null, [['type.googleapis.com/assistant.boq.bard.application.BardErrorInfo', [1152]]]]]],
  ];
  assert.throws(() => parseGeneration(errorFrames), (err: any) => err instanceof GeminiWebError && err.code === 'protocol');

  // Missing text throws protocol error
  assert.throws(() => parseGeneration([[ ['wrb.fr', null, '[]'] ]]), (err: any) => err instanceof GeminiWebError && err.code === 'protocol');

  // Thoughts extraction: marked thoughts + answer
  const thoughtsAndAnswerFrame = [
    [
      'wrb.fr',
      null,
      JSON.stringify([
        null,
        null,
        null,
        null,
        [['rc_1', ['<ctrl94>thought\nInvestigating query thoroughly\n<ctrl95>\nFinal response text']]],
      ]),
    ],
  ];
  const genThoughts = parseGeneration([thoughtsAndAnswerFrame]);
  assert.equal(genThoughts.thinking, 'Investigating query thoroughly');
  assert.equal(genThoughts.text, 'Final response text');

  // Bare marker variant (<ctrl94> without 'thought')
  const bareMarkerFrame = [
    [
      'wrb.fr',
      null,
      JSON.stringify([
        null,
        null,
        null,
        null,
        [['rc_1', ['<ctrl94>\nBare marker thinking\n<ctrl95>\nDone']]],
      ]),
    ],
  ];
  const genBare = parseGeneration([bareMarkerFrame]);
  assert.equal(genBare.thinking, 'Bare marker thinking');
  assert.equal(genBare.text, 'Done');

  // No-marker preservation: quoted marker inside exact JSON is NOT extracted as thoughts
  const jsonWithMarker = '{"content": "<ctrl94>thought\\ninner\\n<ctrl95>"}';
  const genJson = parseGeneration([
    [['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', [jsonWithMarker]]]])]],
  ]);
  assert.equal(genJson.thinking, undefined);
  assert.equal(genJson.text, jsonWithMarker);

  // Prose explaining markers is preserved byte-for-byte
  const proseExplaining = 'Here is how to use <ctrl94>thought and <ctrl95> markers.';
  const genProse = parseGeneration([
    [['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', [proseExplaining]]]])]],
  ]);
  assert.equal(genProse.thinking, undefined);
  assert.equal(genProse.text, proseExplaining);

  // Cumulative snapshot: latest snapshot wins without duplicating earlier thoughts
  const cumulativeThoughts = [
    [['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', ['<ctrl94>thought\nStep 1\n<ctrl95>\n']]]])]],
    [['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', ['<ctrl94>thought\nStep 1 and Step 2\n<ctrl95>\nFinal answer']]]])]],
  ];
  const genCumul = parseGeneration(cumulativeThoughts);
  assert.equal(genCumul.thinking, 'Step 1 and Step 2');
  assert.equal(genCumul.text, 'Final answer');

  // Unicode in thoughts and text
  const unicodeFrame = [
    [
      'wrb.fr',
      null,
      JSON.stringify([
        null,
        null,
        null,
        null,
        [['rc_1', ['<ctrl94>thought\n🤔 Suy nghĩ bằng Tiếng Việt và emoji 🎉\n<ctrl95>\nCâu trả lời hoàn tất.']]],
      ]),
    ],
  ];
  const genUnicode = parseGeneration([unicodeFrame]);
  assert.equal(genUnicode.thinking, '🤔 Suy nghĩ bằng Tiếng Việt và emoji 🎉');
  assert.equal(genUnicode.text, 'Câu trả lời hoàn tất.');

  // Empty thoughts does not emit thinking property
  const emptyThoughtsFrame = [
    ['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', ['<ctrl94>thought<ctrl95>Plain answer']]]])],
  ];
  const genEmptyThoughts = parseGeneration([emptyThoughtsFrame]);
  assert.equal(genEmptyThoughts.thinking, undefined);
  assert.equal(genEmptyThoughts.text, 'Plain answer');

  // Closed thoughts-only response returns empty answer text
  const thoughtsOnlyFrame = [
    ['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', ['<ctrl94>thought\nThinking only\n<ctrl95>']]]])],
  ];
  const genThoughtsOnly = parseGeneration([thoughtsOnlyFrame]);
  assert.equal(genThoughtsOnly.thinking, 'Thinking only');
  assert.equal(genThoughtsOnly.text, '');

  // Unclosed leading thought marker fails safely with protocol error
  const unclosedFrame = [
    ['wrb.fr', null, JSON.stringify([null, null, null, null, [['rc_1', ['<ctrl94>thought\nThinking cut off midway...']]]])],
  ];
  assert.throws(() => parseGeneration([unclosedFrame]), (err: any) => err instanceof GeminiWebError && err.code === 'protocol');
});

test('preparePrompt: canonical Pi shapes, replaying system messages, all-tools-removed authoritative replay', () => {
  // 1. All tools removed in transcript: transcript wins over legacy context.tools
  const ctxToolsRemoved: Context = {
    systemPrompt: 'Legacy prompt',
    tools: [weatherTool], // legacy tools present
    messages: [
      {
        role: 'system',
        content: 'Base system prompt',
        toolsAdded: [weatherTool],
      } as any,
      {
        role: 'system',
        content: 'Removing tools now',
        toolsRemoved: [{ name: 'get_weather' }],
      } as any,
      {
        role: 'user',
        content: 'What is the weather?',
      },
    ],
  };

  const prep1 = preparePrompt(ctxToolsRemoved, 'auto');
  // Tools removed in transcript means resolved tools are EMPTY!
  // Legacy context.tools MUST NOT be resurrected!
  assert.equal(prep1.tools.length, 0);
  assert.match(prep1.payload.prompt, /Base system prompt/);
  assert.match(prep1.payload.prompt, /Removing tools now/);
  // Bridge instructions must NOT be present when tools are empty
  assert.doesNotMatch(prep1.payload.prompt, /RESPONSE FORMAT INSTRUCTIONS/);

  // 2. Section patching and null deletion in system messages
  const ctxSections: Context = {
    messages: [
      {
        role: 'system',
        content: 'Base prompt',
        sections: { sectionA: 'Content A', sectionB: 'Content B' },
      } as any,
      {
        role: 'system',
        content: 'Update prompt',
        sections: { sectionA: 'Updated A', sectionB: null }, // sectionB deleted!
      } as any,
    ],
  };
  const prep2 = preparePrompt(ctxSections);
  assert.match(prep2.payload.prompt, /## sectionA\n\nUpdated A/);
  assert.doesNotMatch(prep2.payload.prompt, /Content B/);

  // 3. toolChoice 'none' disables bridge even with active tools
  const ctxWithTools: Context = {
    messages: [
      {
        role: 'system',
        content: 'System with tools',
        toolsAdded: [weatherTool],
      } as any,
      {
        role: 'user',
        content: 'Hello',
      },
    ],
  };
  const prepChoiceNone = preparePrompt(ctxWithTools, 'none');
  assert.equal(prepChoiceNone.tools.length, 0);
  assert.doesNotMatch(prepChoiceNone.payload.prompt, /RESPONSE FORMAT INSTRUCTIONS/);
});

test('preparePrompt: canonical Pi content toolCall blocks, stopReason aborted/error skipping, and orphan toolResult', () => {
  const ctx: Context = {
    messages: [
      {
        role: 'user',
        content: 'First question',
      },
      // Successful assistant turn with canonical content block type:'toolCall'
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking weather' },
          {
            type: 'toolCall',
            id: 'call_success_1',
            name: 'get_weather',
            arguments: { location: 'Tokyo' },
          },
        ],
        stopReason: 'toolUse',
      } as any,
      // Canonical toolResult message
      {
        role: 'toolResult',
        toolCallId: 'call_success_1',
        toolName: 'get_weather',
        content: [{ type: 'text', text: 'Sunny 20C' }],
        isError: false,
      } as any,
      // Aborted assistant turn with tool call -> should be skipped along with its result!
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call_aborted_2',
            name: 'get_weather',
            arguments: { location: 'London' },
          },
        ],
        stopReason: 'aborted',
      } as any,
      {
        role: 'toolResult',
        toolCallId: 'call_aborted_2',
        toolName: 'get_weather',
        content: [{ type: 'text', text: 'User aborted' }],
        isError: true,
      } as any,
      // Error assistant turn -> should be skipped
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'An error occurred' }],
        stopReason: 'error',
      } as any,
      // Orphan toolResult (from compaction or foreign provider) -> preserved as context
      {
        role: 'toolResult',
        toolCallId: 'call_orphan_3',
        toolName: 'calculate',
        content: [{ type: 'text', text: '42' }],
        isError: false,
      } as any,
      {
        role: 'user',
        content: 'Final question',
      },
    ],
  };

  const prep = preparePrompt(ctx);
  const prompt = prep.payload.prompt;

  // Preserved successful call and result
  assert.match(prompt, /call_success_1/);
  assert.match(prompt, /Sunny 20C/);

  // Skipped aborted call and associated result
  assert.doesNotMatch(prompt, /call_aborted_2/);
  assert.doesNotMatch(prompt, /User aborted/);

  // Skipped error assistant content
  assert.doesNotMatch(prompt, /An error occurred/);

  // Preserved orphan toolResult
  assert.match(prompt, /call_orphan_3/);
  assert.match(prompt, /42/);

  // Reject actual image blocks in messages with unsupported error
  const ctxWithImage: Context = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', data: 'abc' } as any],
        timestamp: 0,
      },
    ],
  };
  assert.throws(() => preparePrompt(ctxWithImage), (err: any) => err instanceof GeminiWebError && err.code === 'unsupported');

  // Tool schema and tool call arguments containing { type: 'image' } are NOT rejected as unsupported
  const toolWithImageType: Tool = {
    name: 'classify_media',
    description: 'Classify media files',
    parameters: Type.Object({
      type: Type.String(),
    }),
  };
  const ctxWithToolArg: Context = {
    tools: [toolWithImageType],
    messages: [
      {
        role: 'user',
        content: 'Classify this input',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call_media_1',
            name: 'classify_media',
            arguments: { type: 'image' },
          },
        ],
      } as any,
    ],
  };
  const prepWithToolArg = preparePrompt(ctxWithToolArg);
  assert.match(prepWithToolArg.payload.prompt, /classify_media/);
});

test('decodeReply: exact content envelope, fenced JSON, and non-envelope prose', () => {
  const tools = [weatherTool];

  // Exact JSON content envelope
  const rep1 = decodeReply('{"content": "Just answering plain text"}', tools, 'resp');
  assert.equal(rep1.text, 'Just answering plain text');
  assert.deepEqual(rep1.toolCalls, []);

  // Fenced JSON content envelope
  const rep2 = decodeReply('```json\n{"content": "Fenced text response"}\n```', tools, 'resp');
  assert.equal(rep2.text, 'Fenced text response');
  assert.deepEqual(rep2.toolCalls, []);

  // Ordinary prose without envelope stays text
  const rep3 = decodeReply('Here is some ordinary helpful prose.', tools, 'resp');
  assert.equal(rep3.text, 'Here is some ordinary helpful prose.');
  assert.deepEqual(rep3.toolCalls, []);

  // Surrounding prose with embedded JSON stays text (never executes embedded JSON)
  const proseWithJson = 'I will run this tool for you: {"tool_calls": [{"name": "get_weather", "arguments": {"location": "Paris"}}]} Have a nice day!';
  const rep4 = decodeReply(proseWithJson, tools, 'resp');
  assert.equal(rep4.text, proseWithJson);
  assert.deepEqual(rep4.toolCalls, []);

  // Empty tools list can NEVER produce executable tool calls
  const callPayload = '{"tool_calls": [{"name": "get_weather", "arguments": {"location": "Paris"}}]}';
  const repNoTools = decodeReply(callPayload, [], 'resp');
  assert.equal(repNoTools.text, callPayload);
  assert.deepEqual(repNoTools.toolCalls, []);
});

test('decodeReply: executes valid tool calls with strict type: "toolCall" and assigned IDs', () => {
  const tools = [weatherTool, calcTool];

  const callJson = JSON.stringify({
    tool_calls: [
      { name: 'get_weather', arguments: { location: 'Berlin', unit: 'celsius' } },
      { name: 'calculate', arguments: { expression: '2 + 2' } },
    ],
  });

  const rep = decodeReply(callJson, tools, 'resp_uuid');
  assert.equal(rep.text, '');
  assert.equal(rep.toolCalls.length, 2);

  // Strict ToolCall shape verification
  const call0 = rep.toolCalls[0];
  assert.equal(call0.type, 'toolCall');
  assert.equal(call0.id, 'resp_uuid_0');
  assert.equal(call0.name, 'get_weather');
  assert.deepEqual(call0.arguments, { location: 'Berlin', unit: 'celsius' });

  const call1 = rep.toolCalls[1];
  assert.equal(call1.type, 'toolCall');
  assert.equal(call1.id, 'resp_uuid_1');
  assert.equal(call1.name, 'calculate');
  assert.deepEqual(call1.arguments, { expression: '2 + 2' });
});

test('decodeReply: rejects malformed envelopes, unadvertised tools, invalid schemas, and bad siblings', () => {
  const tools = [weatherTool];

  // Model-supplied ID is rejected
  assert.throws(
    () => decodeReply('{"tool_calls": [{"id": "model_id_1", "name": "get_weather", "arguments": {"location": "Rome"}}]}', tools, 'resp'),
    (err: any) => err instanceof GeminiWebError && err.code === 'tools',
  );

  // Unadvertised tool name
  assert.throws(
    () => decodeReply('{"tool_calls": [{"name": "unadvertised_tool", "arguments": {}}]}', tools, 'resp'),
    (err: any) => err instanceof GeminiWebError && err.code === 'tools',
  );

  // Schema validation failure (missing required location parameter)
  assert.throws(
    () => decodeReply('{"tool_calls": [{"name": "get_weather", "arguments": {}}]}', tools, 'resp'),
    (err: any) => err instanceof GeminiWebError && err.code === 'tools',
  );

  // Stringified arguments
  assert.throws(
    () => decodeReply('{"tool_calls": [{"name": "get_weather", "arguments": "location=Rome"}]}', tools, 'resp'),
    (err: any) => err instanceof GeminiWebError && err.code === 'tools',
  );

  // Mixed content and tool_calls
  assert.throws(
    () => decodeReply('{"content": "Hello", "tool_calls": [{"name": "get_weather", "arguments": {"location": "Rome"}}]}', tools, 'resp'),
    (err: any) => err instanceof GeminiWebError && err.code === 'tools',
  );

  // Unknown envelope keys alongside tool_calls
  assert.throws(
    () => decodeReply('{"tool_calls": [{"name": "get_weather", "arguments": {"location": "Rome"}}], "extra": 123}', tools, 'resp'),
    (err: any) => err instanceof GeminiWebError && err.code === 'tools',
  );

  // Empty tool_calls array
  assert.throws(
    () => decodeReply('{"tool_calls": []}', tools, 'resp'),
    (err: any) => err instanceof GeminiWebError && err.code === 'tools',
  );

  // More than 16 tool calls
  const manyCalls = new Array(17).fill({ name: 'get_weather', arguments: { location: 'Rome' } });
  assert.throws(
    () => decodeReply(JSON.stringify({ tool_calls: manyCalls }), tools, 'resp'),
    (err: any) => err instanceof GeminiWebError && err.code === 'tools',
  );

  // One bad sibling fails the entire batch
  const siblingCalls = {
    tool_calls: [
      { name: 'get_weather', arguments: { location: 'Rome' } },
      { name: 'get_weather', arguments: {} }, // bad sibling missing location
    ],
  };
  assert.throws(
    () => decodeReply(JSON.stringify(siblingCalls), tools, 'resp'),
    (err: any) => err instanceof GeminiWebError && err.code === 'tools',
  );

  // Recognizable malformed JSON envelope attempting tool calls
  assert.throws(
    () => decodeReply('{"tool_calls": [{"name": "get_weather", "arguments": {"location": "cut off', tools, 'resp'),
    (err: any) => err instanceof GeminiWebError && err.code === 'tools',
  );
});

test('model naming: user-observed pairs, existing Gemini prefix, reorder collision determinism, and fallbacks', () => {
  // Four user-observed discovered pairs
  const m1: WebModel = { id: '8c46e95b1a07cecc', name: '3.5 Flash-Lite', capacity: 1, capacityField: 13, modelNumber: 1 };
  const m2: WebModel = { id: '56fdd199312815e2', name: '3.8 Flash', capacity: 1, capacityField: 13, modelNumber: 1 };
  const m3: WebModel = { id: 'e6fa609c3fa255c0', name: '3.1 Pro', capacity: 1, capacityField: 13, modelNumber: 1 };
  const m4: WebModel = { id: '95a4c0abcba24364', name: '4 Argon', capacity: 1, capacityField: 13, modelNumber: 1 };

  const catalog = [m1, m2, m3, m4];

  // 1. User-observed discovered pairs map to expected friendly IDs and display names
  assert.equal(getFriendlyModelId(m1, catalog), 'gemini-3.5-flash-lite');
  assert.equal(getFriendlyModelName(m1), 'Gemini 3.5 Flash-Lite');

  assert.equal(getFriendlyModelId(m2, catalog), 'gemini-3.8-flash');
  assert.equal(getFriendlyModelName(m2), 'Gemini 3.8 Flash');

  assert.equal(getFriendlyModelId(m3, catalog), 'gemini-3.1-pro');
  assert.equal(getFriendlyModelName(m3), 'Gemini 3.1 Pro');

  assert.equal(getFriendlyModelId(m4, catalog), 'gemini-4-argon');
  assert.equal(getFriendlyModelName(m4), 'Gemini 4 Argon');

  // 2. Existing Gemini prefix in name is NOT duplicated
  const mPrefixed: WebModel = { id: 'abcd1234ef', name: 'Gemini 3.8 Flash', capacity: 1, capacityField: 13, modelNumber: 1 };
  assert.equal(getFriendlyModelName(mPrefixed), 'Gemini 3.8 Flash');
  assert.equal(getFriendlyModelId(mPrefixed, [mPrefixed]), 'gemini-3.8-flash');

  // 3. Collision resolution: entire raw ID is preserved injectively so models sharing first 8 chars are distinct
  const dupA: WebModel = { id: '1111222233334444', name: '3.8 Flash', capacity: 1, capacityField: 13, modelNumber: 1 };
  const dupB: WebModel = { id: '11112222aaaaaaaa', name: '3.8 Flash', capacity: 1, capacityField: 13, modelNumber: 1 };

  const catalogOrder1 = [dupA, dupB];
  const catalogOrder2 = [dupB, dupA];

  const idA1 = getFriendlyModelId(dupA, catalogOrder1);
  const idB1 = getFriendlyModelId(dupB, catalogOrder1);

  const idA2 = getFriendlyModelId(dupA, catalogOrder2);
  const idB2 = getFriendlyModelId(dupB, catalogOrder2);

  // Both orders yield identical deterministic IDs!
  assert.equal(idA1, idA2);
  assert.equal(idB1, idB2);
  assert.notEqual(idA1, idB1);
  assert.equal(idA1, 'gemini-3.8-flash-1111222233334444');
  assert.equal(idB1, 'gemini-3.8-flash-11112222aaaaaaaa');

  // 4. Missing or non-ASCII-only name falls back to raw ID deterministically
  const mNonAscii: WebModel = { id: 'aabbccdd1122', name: '???', capacity: 1, capacityField: 13, modelNumber: 1 };
  assert.equal(getFriendlyModelId(mNonAscii, [mNonAscii]), 'gemini-aabbccdd1122');
  assert.equal(getFriendlyModelName(mNonAscii), 'Gemini aabbccdd1122');

  const mEmpty: WebModel = { id: 'eeff00112233', name: '', capacity: 1, capacityField: 13, modelNumber: 1 };
  assert.equal(getFriendlyModelId(mEmpty, [mEmpty]), 'gemini-eeff00112233');
  assert.equal(getFriendlyModelName(mEmpty), 'Gemini eeff00112233');
});
