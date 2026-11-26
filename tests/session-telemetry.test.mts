import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderModelHealth, renderSessionTelemetry, type SessionTelemetry } from '../extensions/subscription-usage.ts';

const plain = { fg: (_color: string, text: string) => text };
const colored = { fg: (_color: string, text: string) => `[36m${text}[39m` };
const compact = { tokens: 146_076, limit: 300_000, contextWindow: 1_000_000 };
const health = new Map([
  ['hms/deepseek-v4.1-flash-free', { ok: true, elapsed: 8805 }],
  ['xingchiapi/gpt-6.1-sol', { ok: true, elapsed: 23840 }],
  ['xingchiapi/gpt-6-astra', { ok: false, elapsed: 969 }],
]);

test('Compact and Fast share the existing health dock heading and value columns', () => {
  const result = renderModelHealth(health, plain, 80, { compact, fast: 'off' });
  assert.equal(result.length, 2);
  for (const [heading, body] of [['HMS', 'Flash'], ['XINGCHI', 'Sol'], ['COMPACT @30%', '~153.9k left'], ['FAST', 'Off ○']]) {
    assert.ok(result[0]!.includes(heading!) && result[1]!.includes(body!));
    assert.equal(result[0]!.indexOf(heading!), result[1]!.indexOf(body!), heading);
  }
  assert.doesNotMatch(result.join(''), /█|░|\[|49%/);
  const ansi = renderModelHealth(health, colored, 80, { compact, fast: 'on' }).join('');
  for (const heading of ['XINGCHI', 'COMPACT @30%', 'FAST']) {
    assert.ok(ansi.includes(`38;2;203;166;247m${heading}`), 'reuse the dock heading color');
  }
  assert.ok(ansi.includes('38;2;166;227;161m✓'), 'reuse the dock enabled state');
  assert.match(stripVTControlCharacters(ansi), /On ✓/);
  assert.equal(renderModelHealth(health, plain, 40, { compact, fast: 'off' }).length, 4);
});

test('combined dock preserves all values without overflow from one to 120 columns', () => {
  for (const tokens of [299_999, 300_000, 300_001, null]) {
    for (let width = 1; width <= 120; width++) {
      const state: SessionTelemetry = { compact: { ...compact, tokens }, fast: 'n/a' };
      const lines = renderModelHealth(health, colored, width, state);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
      const text = lines.map(stripVTControlCharacters).join('').replaceAll(' ', '');
      for (const label of ['HMS', 'Flash', 'XINGCHI', 'Sol', 'Astra', 'COMPACT@30%', 'FAST', 'N/A']) assert.ok(text.includes(label), label);
      if (tokens === null) assert.ok(text.includes('usagepending○'));
      if (tokens === 299_999) assert.ok(text.includes('~2left'));
      if (tokens === 300_000) assert.ok(text.includes('~1left'));
      if (tokens === 300_001) assert.ok(text.includes('Ready!') && !text.includes('-1'));
    }
  }
  assert.deepEqual(renderSessionTelemetry({ compact, fast: 'on' }, plain, 0), []);
  assert.deepEqual(renderSessionTelemetry({}, plain, 80), []);
  assert.deepEqual(renderSessionTelemetry({ fast: 'off' }, plain, 20), ['FAST', 'Off ○']);
  assert.deepEqual(renderSessionTelemetry({ compact, fast: 'on' }, plain, 80), renderModelHealth(new Map(), plain, 80, { compact, fast: 'on' }));
});
