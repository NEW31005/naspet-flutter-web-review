import {
  abilitiesConfigSchema,
  adviceConfigSchema,
  buddiesConfigSchema,
  mobileHandoffBundleSchema,
  MOBILE_HANDOFF_FILE_PATHS,
  canonicalizeMobileHandoffFiles,
  modelsConfigSchema,
  rulesConfigSchema,
  type AbilitiesConfig,
  type AdviceConfig,
  type BuddiesConfig,
  type ConfigSnapshot,
  type MobileHandoffBundle,
  type ModelsConfig,
  type RulesConfig,
} from '@aibw/shared';
import type { PromptSet } from '@aibw/ai-engine/browser';

import quickTest from '../../../../config/presets/quick-test.json?raw';
import packTest from '../../../../config/presets/pack-test.json?raw';
import standardNine from '../../../../config/presets/standard-nine.json?raw';
import advice from '../../../../config/advice.json?raw';
import abilities from '../../../../config/abilities.json?raw';
import models from '../../../../config/models.json?raw';
import buddies from '../../../../config/buddies.json?raw';
import systemBase from '../../../../prompts/system.base.md?raw';
import evalPrompt from '../../../../prompts/eval.md?raw';
import speechPrompt from '../../../../prompts/speech.md?raw';
import roleVillager from '../../../../prompts/role.villager.md?raw';
import roleSeer from '../../../../prompts/role.seer.md?raw';
import roleGuardian from '../../../../prompts/role.guardian.md?raw';
import roleMedium from '../../../../prompts/role.medium.md?raw';
import roleWerewolf from '../../../../prompts/role.werewolf.md?raw';
import promptVersion from '../../../../prompts/version.json?raw';

export type EditableKind = 'config' | 'prompt';
type HandoffPath = (typeof MOBILE_HANDOFF_FILE_PATHS)[number];

const DEFAULT_FILES: Record<(typeof MOBILE_HANDOFF_FILE_PATHS)[number], string> = {
  'config/presets/quick-test.json': quickTest,
  'config/presets/pack-test.json': packTest,
  'config/presets/standard-nine.json': standardNine,
  'config/advice.json': advice,
  'config/abilities.json': abilities,
  'config/models.json': models,
  'config/buddies.json': buddies,
  'prompts/system.base.md': systemBase,
  'prompts/eval.md': evalPrompt,
  'prompts/speech.md': speechPrompt,
  'prompts/role.villager.md': roleVillager,
  'prompts/role.seer.md': roleSeer,
  'prompts/role.guardian.md': roleGuardian,
  'prompts/role.medium.md': roleMedium,
  'prompts/role.werewolf.md': roleWerewolf,
  'prompts/version.json': promptVersion,
};

const CONFIG_NAMES = [
  'presets/quick-test.json',
  'presets/pack-test.json',
  'presets/standard-nine.json',
  'advice.json',
  'abilities.json',
  'models.json',
  'buddies.json',
] as const;

const PROMPT_NAMES = [
  'system.base.md',
  'eval.md',
  'speech.md',
  'role.villager.md',
  'role.seer.md',
  'role.guardian.md',
  'role.medium.md',
  'role.werewolf.md',
  'version.json',
] as const;

const storageKey = (path: string) => `aibw.lab.file.v1:${path}`;

function pathOf(kind: EditableKind, name: string): HandoffPath {
  const allowed = kind === 'config' ? CONFIG_NAMES : PROMPT_NAMES;
  if (!(allowed as readonly string[]).includes(name)) {
    throw new Error(`編集できない${kind === 'config' ? '設定' : 'プロンプト'}: ${name}`);
  }
  return `${kind === 'config' ? 'config' : 'prompts'}/${name}` as HandoffPath;
}

function stored(path: string): string | null {
  try {
    return localStorage.getItem(storageKey(path));
  } catch {
    return null;
  }
}

/**
 * 役職を名乗る相談の導入前に保存されたadvice.jsonへ、新しい既定項目だけを補う。
 * 既存メニューの文言・有効/無効や利用者が追加した項目は変更しない。
 */
export function supplementLegacyAdviceConfig(saved: string): string {
  try {
    const legacy = JSON.parse(saved) as Record<string, unknown>;
    const current = JSON.parse(advice) as Record<string, unknown>;
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return saved;

    let changed = false;
    const currentMenu = Array.isArray(current.menu) ? current.menu : [];
    const legacyMenu = Array.isArray(legacy.menu) ? [...legacy.menu] : null;
    if (legacyMenu) {
      const hasRoleClaim = legacyMenu.some((item) =>
        item && typeof item === 'object' && !Array.isArray(item) &&
        (item as Record<string, unknown>).kind === 'role_claim'
      );
      if (!hasRoleClaim) {
        const defaultRoleClaim = currentMenu.find((item) =>
          item && typeof item === 'object' && !Array.isArray(item) &&
          (item as Record<string, unknown>).kind === 'role_claim'
        );
        if (defaultRoleClaim) {
          legacy.menu = [...legacyMenu, defaultRoleClaim];
          changed = true;
        }
      }
    }

    if (!Object.hasOwn(legacy, 'roleClaimOptions') && Array.isArray(current.roleClaimOptions)) {
      legacy.roleClaimOptions = current.roleClaimOptions;
      changed = true;
    }
    if (!changed) return saved;

    const legacyVersion = typeof legacy.version === 'string' && legacy.version.trim()
      ? legacy.version
      : 'legacy';
    legacy.version = legacyVersion.endsWith('+role-claim-compat.1')
      ? legacyVersion
      : `${legacyVersion}+role-claim-compat.1`;
    return JSON.stringify(legacy, null, 2);
  } catch {
    // 不正JSONはここで握りつぶさず、通常の検証経路で利用者へ知らせる。
    return saved;
  }
}

function effectiveTextForPath(path: HandoffPath): string {
  const saved = stored(path);
  if (saved === null) return DEFAULT_FILES[path] ?? '';
  return path === 'config/advice.json' ? supplementLegacyAdviceConfig(saved) : saved;
}

export function readStaticFile(kind: EditableKind, name: string): string {
  const path = pathOf(kind, name);
  // 保存済みの内容は利用者の実験成果であり、版番号だけを根拠に上書きしない。
  // ただし旧advice.jsonに存在しない新機能は、既存値を保ったまま既定項目だけ補完する。
  return effectiveTextForPath(path);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}のJSONが不正です: ${String(error)}`);
  }
}

export function validateStaticFile(kind: EditableKind, name: string, text: string): void {
  const data = name.endsWith('.json') ? parseJson(text, name) : null;
  if (kind === 'config') {
    if (name.startsWith('presets/')) rulesConfigSchema.parse(data);
    else if (name === 'advice.json') adviceConfigSchema.parse(data);
    else if (name === 'abilities.json') abilitiesConfigSchema.parse(data);
    else if (name === 'models.json') modelsConfigSchema.parse(data);
    else if (name === 'buddies.json') buddiesConfigSchema.parse(data);
  } else if (name === 'version.json') {
    const version = data as { version?: unknown };
    if (typeof version.version !== 'string' || !version.version.trim()) {
      throw new Error('version.jsonには空でないversionが必要です');
    }
  } else if (!text.trim()) {
    throw new Error(`${name}を空にはできません`);
  }
}

export function writeStaticFile(kind: EditableKind, name: string, text: string): void {
  validateStaticFile(kind, name, text);
  localStorage.setItem(storageKey(pathOf(kind, name)), text);
}

export interface LoadedStaticConfig {
  rules: Record<string, RulesConfig>;
  advice: AdviceConfig;
  abilities: AbilitiesConfig;
  models: ModelsConfig;
  buddies: BuddiesConfig;
  prompts: PromptSet;
}

export function loadStaticConfig(): LoadedStaticConfig {
  const quick = rulesConfigSchema.parse(
    parseJson(readStaticFile('config', 'presets/quick-test.json'), 'quick-test'),
  );
  const pack = rulesConfigSchema.parse(
    parseJson(readStaticFile('config', 'presets/pack-test.json'), 'pack-test'),
  );
  const standard = rulesConfigSchema.parse(
    parseJson(readStaticFile('config', 'presets/standard-nine.json'), 'standard-nine'),
  );
  const version = parseJson(readStaticFile('prompt', 'version.json'), 'version.json') as {
    version: string;
  };
  return {
    rules: {
      [quick.presetId]: quick,
      [pack.presetId]: pack,
      [standard.presetId]: standard,
    },
    advice: adviceConfigSchema.parse(parseJson(readStaticFile('config', 'advice.json'), 'advice')),
    abilities: abilitiesConfigSchema.parse(
      parseJson(readStaticFile('config', 'abilities.json'), 'abilities'),
    ),
    models: modelsConfigSchema.parse(parseJson(readStaticFile('config', 'models.json'), 'models')),
    buddies: buddiesConfigSchema.parse(
      parseJson(readStaticFile('config', 'buddies.json'), 'buddies'),
    ),
    prompts: {
      version: version.version,
      systemBase: readStaticFile('prompt', 'system.base.md'),
      evalTemplate: readStaticFile('prompt', 'eval.md'),
      speechTemplate: readStaticFile('prompt', 'speech.md'),
      roleVillager: readStaticFile('prompt', 'role.villager.md'),
      roleSeer: readStaticFile('prompt', 'role.seer.md'),
      roleGuardian: readStaticFile('prompt', 'role.guardian.md'),
      roleMedium: readStaticFile('prompt', 'role.medium.md'),
      roleWerewolf: readStaticFile('prompt', 'role.werewolf.md'),
    },
  };
}

export function buildStaticSnapshot(
  loaded: LoadedStaticConfig,
  presetId: string,
): ConfigSnapshot {
  const rules = loaded.rules[presetId];
  if (!rules) throw new Error(`不明なプリセット: ${presetId}`);
  return {
    rules,
    advice: loaded.advice,
    abilities: loaded.abilities,
    models: loaded.models,
    buddies: loaded.buddies.roster,
    promptVersion: loaded.prompts.version,
    versions: {
      rules: rules.version,
      advice: loaded.advice.version,
      abilities: loaded.abilities.version,
      models: loaded.models.version,
      buddies: loaded.buddies.version,
      prompts: loaded.prompts.version,
    },
  };
}

export function editableFiles(): { config: string[]; prompts: string[] } {
  return { config: [...CONFIG_NAMES], prompts: [...PROMPT_NAMES] };
}

export function allEffectiveFiles(): Record<string, string> {
  return Object.fromEntries(
    [...MOBILE_HANDOFF_FILE_PATHS]
      .sort()
      .map((path) => [path, effectiveTextForPath(path)]),
  );
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function versionOf(files: Record<string, string>, path: string): string {
  const value = parseJson(files[path] ?? '{}', path) as { version?: unknown };
  return typeof value.version === 'string' ? value.version : '';
}

export async function createMobileHandoffBundleFromFiles(
  files: Record<string, string>,
): Promise<MobileHandoffBundle> {
  // Node版では編集可能なquick-info等も渡されるため、固定v2契約の16ファイルだけを選ぶ。
  const currentFiles = Object.fromEntries(MOBILE_HANDOFF_FILE_PATHS.map((path) => {
    const text = files[path];
    if (typeof text !== 'string') throw new Error(`引継ぎに必要なファイルがありません: ${path}`);
    return [path, text];
  }));
  return {
    schemaVersion: 2,
    kind: 'ai-buddy-werewolf-mobile-handoff',
    exportedAt: new Date().toISOString(),
    source: {
      app: 'ai-buddy-werewolf-phase0-web-lab',
      configVersions: {
        quickTest: versionOf(files, 'config/presets/quick-test.json'),
        packTest: versionOf(files, 'config/presets/pack-test.json'),
        standardNine: versionOf(files, 'config/presets/standard-nine.json'),
        advice: versionOf(files, 'config/advice.json'),
        abilities: versionOf(files, 'config/abilities.json'),
        models: versionOf(files, 'config/models.json'),
        buddies: versionOf(files, 'config/buddies.json'),
        prompts: versionOf(files, 'prompts/version.json'),
      },
    },
    files: currentFiles,
    integrity: {
      algorithm: 'SHA-256',
      digest: await sha256(canonicalizeMobileHandoffFiles(currentFiles)),
    },
    implementationContract: {
      gameCore: 'authoritative-event-engine',
      prompts: 'server-side-only',
      secretsIncluded: false,
      mobileTransport: 'supabase-edge-function',
    },
  };
}

export function createMobileHandoffBundle(): Promise<MobileHandoffBundle> {
  return createMobileHandoffBundleFromFiles(allEffectiveFiles());
}

export async function validateMobileHandoffBundle(
  value: unknown,
): Promise<MobileHandoffBundle> {
  const bundle = mobileHandoffBundleSchema.parse(value);
  const digest = await sha256(canonicalizeMobileHandoffFiles(bundle.files));
  if (digest !== bundle.integrity.digest) {
    throw new Error('引継ぎパッケージのSHA-256が一致しません');
  }

  const validated: { kind: EditableKind; name: string; text: string }[] = [];
  for (const [path, text] of Object.entries(bundle.files)) {
    const kind: EditableKind = path.startsWith('config/') ? 'config' : 'prompt';
    const name = path.replace(/^config\//, '').replace(/^prompts\//, '');
    validateStaticFile(kind, name, text);
    validated.push({ kind, name, text });
  }
  return bundle;
}

export async function importMobileHandoffBundle(value: unknown): Promise<void> {
  const bundle = await validateMobileHandoffBundle(value);
  const validated: { kind: EditableKind; name: string; text: string }[] = [];
  for (const [path, text] of Object.entries(bundle.files)) {
    const kind: EditableKind = path.startsWith('config/') ? 'config' : 'prompt';
    const name = path.replace(/^config\//, '').replace(/^prompts\//, '');
    const migratedText = bundle.schemaVersion === 1 && path === 'config/advice.json'
      ? supplementLegacyAdviceConfig(text)
      : text;
    validated.push({ kind, name, text: migratedText });
  }
  for (const file of validated) writeStaticFile(file.kind, file.name, file.text);
}

export function resetStaticFiles(): void {
  for (const path of Object.keys(DEFAULT_FILES)) localStorage.removeItem(storageKey(path));
}
