import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderModelHealth, renderSessionTelemetry, xingchiapiCfg, type SessionTelemetry } from '../extensions/subscription-usage.ts';

const plain = { fg: (_color: string, text: string) => text };
const colored = { fg: (_color: string, text: string) => `[36m${text}[39m` };
const compact = { tokens: 146_076, limit: 300_000, contextWindow: 1_000_000 };
const health = new Map([
  ['hms/deepseek-v4.1-flash-free', { ok: true, elapsed: 8805 }],
  ['xingchiapi/gpt-6.1-sol', { ok: true, elapsed: 23840 }],
  ['xingchiapi/gpt-6-astra', { ok: false, elapsed: 969 }],
]);

test('dock separates model health and session controls with inline label/value groups', () => {
  const result = renderModelHealth(health, plain, 80, { compact, fast: 'off' });
  assert.deepEqual(result, [
    'health   hms/Flash ✓ 8.8s   xingchi/Sol ✓ 23.8s   xingchi/Astra !',
    'session  compact in 153.9k (30%)   fast ○',
  ]);
  assert.deepEqual(renderModelHealth(health, plain, 120, { compact, fast: 'off' }), result);
  assert.doesNotMatch(result.join(''), /█|░|\[|49%/);
  const ansi = renderModelHealth(health, colored, 80, { compact, fast: 'on' }).join('');
  assert.ok(ansi.includes(colored.fg('success', '●')), 'use native theme roles for status');
  assert.match(stripVTControlCharacters(ansi), /fast ●/);
  assert.doesNotMatch(stripVTControlCharacters(ansi), /[│:]|\b(?:ON|OFF|N\/A)\b/);
  assert.ok(!stripVTControlCharacters(ansi).includes('○'), 'healthy models have no inactive indicator');
  assert.equal(renderModelHealth(health, plain, 40, { compact, fast: 'off' }).length, 5);
  assert.deepEqual(renderSessionTelemetry({ compact: { ...compact, tokens: 215701 } }, plain, 80), ['session  compact in 84.3k (30%)']);
});

test('assembled account, health and session rows share a gutter at terminal widths', () => {
  const account = { windows: {}, balance: { currency: 'USD', total: 880.96 }, plan: 'xingchiapi · unrestricted · 871 requests today' };
  const checks = new Map([['hms/deepseek-v4.1-flash-free', { ok: true, elapsed: 27700 }], ['xingchiapi/gpt-6.1-sol', { ok: true, elapsed: 7000 }]]);
  for (const width of [76, 120]) {
    const result = [xingchiapiCfg.render(account, plain), ...renderModelHealth(checks, plain, width, { compact: { ...compact, tokens: 155301 }, fast: 'off' })];
    assert.deepEqual(result, [
      'xingchi  $880.96 balance   871 req today   unrestricted',
      'health   hms/Flash ✓ 27.7s   xingchi/Sol ✓ 7.0s',
      'session  compact in 144.7k (30%)   fast ○',
    ]);
    assert.ok(result.every((line) => visibleWidth(line) <= width));
    assert.deepEqual([result[0]!.indexOf('$'), result[1]!.indexOf('hms/'), result[2]!.indexOf('compact')], [9, 9, 9]);
    assert.doesNotMatch(result.join(''), /[│:]|[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]/u);
  }
});

test('combined dock preserves all values without overflow from one to 120 columns', () => {
  for (const tokens of [0, 299_999, 300_000, 300_001, null]) {
    for (let width = 1; width <= 120; width++) {
      const state: SessionTelemetry = { compact: { ...compact, tokens }, fast: 'n/a' };
      const lines = renderModelHealth(health, colored, width, state);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
      const text = lines.map(stripVTControlCharacters).join('').replaceAll(' ', '');
      for (const label of ['health', 'hms/', 'Flash', 'xingchi/', 'Sol', 'Astra', 'session', 'compact', '(30%)', 'fast', '—']) assert.ok(text.includes(label), label);
      if (tokens === null) assert.ok(text.includes('usagepending○'));
      if (tokens === 0) assert.ok(text.includes('in300k'));
      if (tokens === 299_999) assert.ok(text.includes('in2'));
      if (tokens === 300_000) assert.ok(text.includes('in1'));
      if (tokens === 300_001) assert.ok(text.includes('Ready!') && !text.includes('-1'));
    }
  }
  assert.deepEqual(renderSessionTelemetry({ compact, fast: 'on' }, plain, 0), []);
  assert.deepEqual(renderSessionTelemetry({}, plain, 80), []);
  assert.deepEqual(renderSessionTelemetry({ fast: 'off' }, plain, 20), ['session  fast ○']);
  assert.deepEqual(renderSessionTelemetry({ compact, fast: 'on' }, plain, 80), renderModelHealth(new Map(), plain, 80, { compact, fast: 'on' }));
});
