// Tool-pair safety for the Antigravity (Google Generative AI) converter.
//
// Google rejects a request whose functionResponse count does not match its
// functionCall count, so a result whose call never made it into the payload
// must degrade to a plain observation instead of an orphan functionResponse.
import assert from 'node:assert/strict';
import test from 'node:test';

import { convertMessages } from '../extensions/antigravity/stream/stream.ts';

const MODEL = { id: 'gemini-2.5-pro', provider: 'antigravity', api: 'google-generative-ai' } as any;

function turns(messages: any[], runtimeModel = 'gemini-2.5-pro') {
  return convertMessages(MODEL, { messages } as any, runtimeModel) as any[];
}

function hasFunctionResponse(contents: any[]): boolean {
  return contents.some((turn) => turn.parts.some((part: any) => 'functionResponse' in part));
}

function hasFunctionCall(contents: any[]): boolean {
  return contents.some((turn) => turn.parts.some((part: any) => 'functionCall' in part));
}

test('antigravity: a result whose assistant turn errored becomes an observation, not an orphan functionResponse', () => {
  const contents = turns([
    { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
    {
      role: 'assistant',
      provider: 'antigravity',
      model: MODEL.id,
      stopReason: 'error',
      content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'npm test' } }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    },
  ]);

  assert.equal(hasFunctionCall(contents), false, 'the errored turn must not be sent');
  assert.equal(hasFunctionResponse(contents), false, 'its result must not be sent as a functionResponse');
  const observation = contents
    .flatMap((turn) => turn.parts)
    .find((part: any) => typeof part.text === 'string' && part.text.includes('boom'));
  assert.ok(observation, 'the result text must survive as an observation');
  assert.match(observation.text, /Observation from `bash`/);
});

test('antigravity: an aborted turn is treated the same way', () => {
  const contents = turns([
    { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
    {
      role: 'assistant',
      provider: 'antigravity',
      model: MODEL.id,
      stopReason: 'aborted',
      content: [{ type: 'toolCall', id: 'call_2', name: 'bash', arguments: { command: 'npm test' } }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call_2',
      toolName: 'bash',
      content: [{ type: 'text', text: 'killed' }],
      isError: true,
    },
  ]);

  assert.equal(hasFunctionResponse(contents), false);
  assert.ok(contents.flatMap((turn) => turn.parts).some((part: any) => String(part.text ?? '').includes('killed')));
});

test('antigravity: a healthy pair still converts to functionCall + functionResponse', () => {
  const contents = turns([
    { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
    {
      role: 'assistant',
      provider: 'antigravity',
      model: MODEL.id,
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call_3', name: 'bash', arguments: { command: 'npm test' } }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call_3',
      toolName: 'bash',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    },
  ]);

  assert.equal(hasFunctionCall(contents), true);
  assert.equal(hasFunctionResponse(contents), true);
  const response = contents.flatMap((turn) => turn.parts).find((part: any) => 'functionResponse' in part);
  assert.equal(response.functionResponse.name, 'bash');
  assert.equal(response.functionResponse.response.output, 'ok');
});

test('antigravity: signature-gated drops still degrade to observations (regression)', () => {
  // gemini-3 requires a thought signature; a signature-less call is dropped and
  // its result must take the observation path.
  const contents = turns(
    [
      { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
      {
        role: 'assistant',
        provider: 'antigravity',
        model: 'gemini-3-pro-preview',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'call_4', name: 'bash', arguments: { command: 'npm test' } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call_4',
        toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
    ],
    'gemini-3-pro-preview',
  );

  assert.equal(hasFunctionCall(contents), false);
  assert.equal(hasFunctionResponse(contents), false);
  assert.ok(
    contents.flatMap((turn) => turn.parts).some((part: any) => String(part.text ?? '').includes('Observation from')),
  );
});
