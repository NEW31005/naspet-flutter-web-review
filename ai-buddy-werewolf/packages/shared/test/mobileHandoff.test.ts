import { describe, expect, it } from 'vitest';
import {
  MOBILE_HANDOFF_FILE_PATHS,
  MOBILE_HANDOFF_V1_FILE_PATHS,
  canonicalizeMobileHandoffFiles,
  mobileHandoffBundleSchema,
} from '../src/index.js';

const v1Files = Object.fromEntries(MOBILE_HANDOFF_V1_FILE_PATHS.map((path) => [path, '{}']));
const v2Files = Object.fromEntries(MOBILE_HANDOFF_FILE_PATHS.map((path) => [path, '{}']));

const bundle = (schemaVersion: 1 | 2, files: Record<string, string>) => ({
  schemaVersion,
  kind: 'ai-buddy-werewolf-mobile-handoff' as const,
  exportedAt: '2026-08-25T00:00:00.000Z',
  source: {
    app: 'ai-buddy-werewolf-phase0-web-lab' as const,
    configVersions: { prompts: '0.2.0' },
  },
  files,
  integrity: { algorithm: 'SHA-256' as const, digest: 'a'.repeat(64) },
  implementationContract: {
    gameCore: 'authoritative-event-engine' as const,
    prompts: 'server-side-only' as const,
    secretsIncluded: false as const,
    mobileTransport: 'supabase-edge-function' as const,
  },
});

describe('モバイル引継ぎパッケージ', () => {
  it('v1の旧13ファイルとv2の現行16ファイルを後方互換で検証する', () => {
    const v1 = mobileHandoffBundleSchema.parse(bundle(1, v1Files));
    const v2 = mobileHandoffBundleSchema.parse(bundle(2, v2Files));
    expect(v1.implementationContract.secretsIncluded).toBe(false);
    expect(v2.implementationContract.secretsIncluded).toBe(false);
  });

  it('秘密情報同梱フラグtrueを拒否する', () => {
    const result = mobileHandoffBundleSchema.safeParse({
      schemaVersion: 2,
      kind: 'ai-buddy-werewolf-mobile-handoff',
      exportedAt: '2026-08-25T00:00:00.000Z',
      source: { app: 'ai-buddy-werewolf-phase0-web-lab', configVersions: {} },
      files: v2Files,
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
    const incomplete = { ...v2Files };
    delete incomplete['prompts/eval.md'];
    const result = mobileHandoffBundleSchema.safeParse({
      schemaVersion: 2,
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
