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
import advice from '../../../../config/advice.json?raw';
import abilities from '../../../../config/abilities.json?raw';
import models from '../../../../config/models.json?raw';
import buddies from '../../../../config/buddies.json?raw';
import systemBase from '../../../../prompts/system.base.md?raw';
import evalPrompt from '../../../../prompts/eval.md?raw';
import speechPrompt from '../../../../prompts/speech.md?raw';
import roleVillager from '../../../../prompts/role.villager.md?raw';
import roleSeer from '../../../../prompts/role.seer.md?raw';
import roleWerewolf from '../../../../prompts/role.werewolf.md?raw';
import promptVersion from '../../../../prompts/version.json?raw';

export type EditableKind = 'config' | 'prompt';
type HandoffPath = (typeof MOBILE_HANDOFF_FILE_PATHS)[number];

const DEFAULT_FILES: Record<(typeof MOBILE_HANDOFF_FILE_PATHS)[number], string> = {
  'config/presets/quick-test.json': quickTest,
  'config/presets/pack-test.json': packTest,
  'config/advice.json': advice,
  'config/abilities.json': abilities,
  'config/models.json': models,
  'config/buddies.json': buddies,
  'prompts/system.base.md': systemBase,
  'prompts/eval.md': evalPrompt,
  'prompts/speech.md': speechPrompt,
  'prompts/role.villager.md': roleVillager,
  'prompts/role.seer.md': roleSeer,
  'prompts/role.werewolf.md': roleWerewolf,
  'prompts/version.json': promptVersion,
};

const CONFIG_NAMES = [
  'presets/quick-test.json',
  'presets/pack-test.json',
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

export function readStaticFile(kind: EditableKind, name: string): string {
  const path = pathOf(kind, name);
  const saved = stored(path);
  // 旧公開Labで保存済みの既定プリセットだけは、焦点型の初日討論へ安全に移行する。
  // 他の数値・人格・プロンプトは保持し、明示的な旧バージョンだけを対象にする。
  if (saved && (path === 'config/presets/quick-test.json' || path === 'config/presets/pack-test.json')) {
    try {
      const value = JSON.parse(saved) as {
        version?: unknown;
        discussionRounds?: unknown;
        firstDayFocusCount?: unknown;
      };
      const quickLegacy = path === 'config/presets/quick-test.json' &&
        (value.version === '0.3.0-joint.1' || value.version === '0.4.0-dialogue.1' ||
          value.version === '0.5.0-focus.1');
      const packLegacy = path === 'config/presets/pack-test.json' &&
        (value.version === '0.1.1-joint.1' || value.version === '0.2.0-focus.1');
      if (quickLegacy || packLegacy) {
        const pairCount = typeof (value as { pairCount?: unknown }).pairCount === 'number'
          ? (value as { pairCount: number }).pairCount
          : quickLegacy ? 5 : 8;
        const migrated = JSON.stringify(
          {
            ...value,
            version: quickLegacy ? '0.6.0-timed.1' : '0.3.0-timed.1',
            firstDayFocusCount: 2,
            discussionMode: 'timed',
            discussionDurationSec: 150,
            discussionMaxMessages: pairCount <= 5 ? 30 : 48,
            discussionBatchSize: pairCount <= 5 ? 3 : 4,
            discussionRounds: 2,
          },
          null,
          2,
        );
        localStorage.setItem(storageKey(path), migrated);
        return migrated;
      }
    } catch {
      // 不正JSONは従来どおり後段の検証で利用者へ示す。
    }
  }
  if (path === 'prompts/version.json' && saved) {
    try {
      const value = JSON.parse(saved) as { version?: unknown };
      if (value.version === '0.4.0-dialogue.1' || value.version === '0.5.0-focus.1') {
        const migrated = JSON.stringify({ ...value, version: '0.6.0-timed.1' }, null, 2);
        localStorage.setItem(storageKey(path), migrated);
        return migrated;
      }
    } catch {
      // 不正JSONは従来どおり後段の検証で利用者へ示す。
    }
  }
  return saved ?? DEFAULT_FILES[path] ?? '';
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
  const version = parseJson(readStaticFile('prompt', 'version.json'), 'version.json') as {
    version: string;
  };
  return {
    rules: { [quick.presetId]: quick, [pack.presetId]: pack },
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
      .map((path) => [path, stored(path) ?? DEFAULT_FILES[path] ?? '']),
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
  return {
    schemaVersion: 1,
    kind: 'ai-buddy-werewolf-mobile-handoff',
    exportedAt: new Date().toISOString(),
    source: {
      app: 'ai-buddy-werewolf-phase0-web-lab',
      configVersions: {
        quickTest: versionOf(files, 'config/presets/quick-test.json'),
        packTest: versionOf(files, 'config/presets/pack-test.json'),
        advice: versionOf(files, 'config/advice.json'),
        abilities: versionOf(files, 'config/abilities.json'),
        models: versionOf(files, 'config/models.json'),
        buddies: versionOf(files, 'config/buddies.json'),
        prompts: versionOf(files, 'prompts/version.json'),
      },
    },
    files,
    integrity: {
      algorithm: 'SHA-256',
      digest: await sha256(canonicalizeMobileHandoffFiles(files)),
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
    validated.push({ kind, name, text });
  }
  for (const file of validated) writeStaticFile(file.kind, file.name, file.text);
}

export function resetStaticFiles(): void {
  for (const path of Object.keys(DEFAULT_FILES)) localStorage.removeItem(storageKey(path));
}
