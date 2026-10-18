import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CookieCredential } from '../../extensions/gemini-web/auth.ts';
import type { WebModel } from '../../extensions/gemini-web/protocol.ts';

export const sampleWebModel: WebModel = {
  id: 'models/gemini-pro-web',
  name: 'Gemini Pro Web',
  capacity: 1,
  capacityField: 13,
  modelNumber: 1,
};

export function createTestCredential(overrides: Partial<CookieCredential> = {}): CookieCredential {
  return {
    version: 1,
    revision: 'rev-0',
    authUser: 0,
    cookieHeader: '__Secure-1PSID=val1; __Secure-1PSIDTS=val2',
    updatedAt: 1000000,
    models: [sampleWebModel],
    ...overrides,
  };
}

export function createTempDir(prefix = 'gemini-web-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export async function withTempDir<T>(
  fn: (dir: string) => Promise<T> | T,
  prefix = 'gemini-web-test-',
): Promise<T> {
  const dir = createTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    cleanTempDir(dir);
  }
}

export function makeSyntheticBootstrapHtml(
  at = 'tok_bootstrap_123',
  bl = 'bl_999',
  sid = 'sid_888',
): string {
  return `<html><head><script>window.WIZ_global_data = {"SNlM0e":"${at}","cfb2h":"${bl}","FdrFJe":"${sid}","TuX5cc":"en"};</script></head><body></body></html>`;
}

export function makeSyntheticDiscoveryPayload(
  models: Array<{
    id: string;
    name: string;
    capacity: number;
    capacityField: 12 | 13;
    modelNumber: number;
  }>,
): string {
  const entries = models.map((m) => [
    m.id,
    'Synthetic Label',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    m.modelNumber,
    null,
    m.name,
    null,
    null,
    null,
    null,
    null,
    m.modelNumber,
  ]);
  const status = new Array(18).fill(null);
  status[14] = 1000;
  status[15] = entries;
  // Tier 21 -> capacity 1, capacityField 13; capability 115 -> capacity 4, capacityField 12
  status[16] = [21];
  status[17] = [];
  const inner = JSON.stringify([
    ['wrb.fr', 'otAQ7b', JSON.stringify(status), null, null, null, 'generic'],
  ]);
  return `)]}'\n${Buffer.byteLength(inner, 'utf8')}\n${inner}\n`;
}

export function makeSyntheticGenerationPayload(text: string): string {
  const inner = JSON.stringify([
    [
      'wrb.fr',
      null,
      JSON.stringify([null, null, null, null, [['rc_test', [text]]]]),
    ],
  ]);
  return `)]}'\n${Buffer.byteLength(inner, 'utf8')}\n${inner}\n`;
}

export function createSyntheticGenerateFetch(
  generationText: string,
  options?: { bootstrapHtml?: string },
): typeof globalThis.fetch {
  const bootstrapHtml = options?.bootstrapHtml ?? makeSyntheticBootstrapHtml();
  return (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/app')) {
      return new Response(bootstrapHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (u.includes('StreamGenerate')) {
      return new Response(makeSyntheticGenerationPayload(generationText), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as typeof globalThis.fetch;
}

export function createSyntheticDiscoveryFetch(
  models: WebModel[] = [sampleWebModel],
  options?: { bootstrapHtml?: string },
): typeof globalThis.fetch {
  const bootstrapHtml = options?.bootstrapHtml ?? makeSyntheticBootstrapHtml();
  return (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/app')) {
      return new Response(bootstrapHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (u.includes('batchexecute') || u.includes('ListModels')) {
      return new Response(makeSyntheticDiscoveryPayload(models), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as typeof globalThis.fetch;
}
