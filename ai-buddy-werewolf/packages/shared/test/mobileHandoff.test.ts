import { describe, expect, it } from 'vitest';
import {
  MOBILE_HANDOFF_FILE_PATHS,
  canonicalizeMobileHandoffFiles,
  mobileHandoffBundleSchema,
} from '../src/index.js';

const files = Object.fromEntries(MOBILE_HANDOFF_FILE_PATHS.map((path) => [path, '{}']));

describe('モバイル引継ぎパッケージ', () => {
  it('秘密情報を含めない固定契約を検証する', () => {
    const parsed = mobileHandoffBundleSchema.parse({
      schemaVersion: 1,
      kind: 'ai-buddy-werewolf-mobile-handoff',
      exportedAt: '2026-08-25T00:00:00.000Z',
      source: {
        app: 'ai-buddy-werewolf-phase0-web-lab',
        configVersions: { prompts: '0.2.0' },
      },
      files,
      integrity: { algorithm: 'SHA-256', digest: 'a'.repeat(64) },
      implementationContract: {
        gameCore: 'authoritative-event-engine',
        prompts: 'server-side-only',
        secretsIncluded: false,
        mobileTransport: 'supabase-edge-function',
      },
    });
    expect(parsed.implementationContract.secretsIncluded).toBe(false);
  });

  it('秘密情報同梱フラグtrueを拒否する', () => {
    const result = mobileHandoffBundleSchema.safeParse({
      schemaVersion: 1,
      kind: 'ai-buddy-werewolf-mobile-handoff',
      exportedAt: '2026-08-25T00:00:00.000Z',
      source: { app: 'ai-buddy-werewolf-phase0-web-lab', configVersions: {} },
      files,
      integrity: { algorithm: 'SHA-256', digest: 'a'.repeat(64) },
      implementationContract: {
        gameCore: 'authoritative-event-engine',
        prompts: 'server-side-only',
        secretsIncluded: true,
        mobileTransport: 'server-api',
      },
    });
    expect(result.success).toBe(false);
  });

  it('固定契約にない不足ファイルを拒否する', () => {
    const incomplete = { ...files };
    delete incomplete['prompts/eval.md'];
    const result = mobileHandoffBundleSchema.safeParse({
      schemaVersion: 1,
      kind: 'ai-buddy-werewolf-mobile-handoff',
      exportedAt: '2026-08-25T00:00:00.000Z',
      source: { app: 'ai-buddy-werewolf-phase0-web-lab', configVersions: {} },
      files: incomplete,
      integrity: { algorithm: 'SHA-256', digest: 'a'.repeat(64) },
      implementationContract: {
        gameCore: 'authoritative-event-engine',
        prompts: 'server-side-only',
        secretsIncluded: false,
        mobileTransport: 'server-api',
      },
    });
    expect(result.success).toBe(false);
  });

  it('ファイルの入力順に関係なく同じ正規化文字列を作る', () => {
    expect(canonicalizeMobileHandoffFiles({ b: '2', a: '1' })).toBe(
      canonicalizeMobileHandoffFiles({ a: '1', b: '2' }),
    );
  });
});
