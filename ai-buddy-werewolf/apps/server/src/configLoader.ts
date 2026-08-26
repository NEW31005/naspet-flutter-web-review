/**
 * 設定・プロンプトの読み込み。
 * すべてファイルから毎回読み直すため、ファイル編集(または管理画面からのPUT)後に
 * 新しい試合を作れば、アプリ再起動なしで反映される。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  abilitiesConfigSchema,
  adviceConfigSchema,
  buddiesConfigSchema,
  modelsConfigSchema,
  rulesConfigSchema,
  type AbilitiesConfig,
  type AdviceConfig,
  type BuddiesConfig,
  type ConfigSnapshot,
  type ModelsConfig,
  type RulesConfig,
} from '@aibw/shared';
import type { PromptSet } from '@aibw/ai-engine';

export interface LoadedConfig {
  rules: Record<string, RulesConfig>; // presetId -> rules
  advice: AdviceConfig;
  abilities: AbilitiesConfig;
  models: ModelsConfig;
  buddies: BuddiesConfig;
  prompts: PromptSet;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function loadConfig(rootDir: string): LoadedConfig {
  const configDir = path.join(rootDir, 'config');
  const promptsDir = path.join(rootDir, 'prompts');

  const presetsDir = path.join(configDir, 'presets');
  const rules: Record<string, RulesConfig> = {};
  for (const file of fs.readdirSync(presetsDir)) {
    if (!file.endsWith('.json')) continue;
    const parsed = rulesConfigSchema.parse(readJson(path.join(presetsDir, file)));
    rules[parsed.presetId] = parsed;
  }

  const advice = adviceConfigSchema.parse(readJson(path.join(configDir, 'advice.json')));
  const abilities = abilitiesConfigSchema.parse(readJson(path.join(configDir, 'abilities.json')));
  const models = modelsConfigSchema.parse(readJson(path.join(configDir, 'models.json')));
  const buddies = buddiesConfigSchema.parse(readJson(path.join(configDir, 'buddies.json')));

  const promptVersion = (readJson(path.join(promptsDir, 'version.json')) as { version: string })
    .version;
  const readPrompt = (name: string) => fs.readFileSync(path.join(promptsDir, name), 'utf-8');
  const prompts: PromptSet = {
    version: promptVersion,
    systemBase: readPrompt('system.base.md'),
    evalTemplate: readPrompt('eval.md'),
    speechTemplate: readPrompt('speech.md'),
    roleVillager: readPrompt('role.villager.md'),
    roleSeer: readPrompt('role.seer.md'),
    roleWerewolf: readPrompt('role.werewolf.md'),
  };

  return { rules, advice, abilities, models, buddies, prompts };
}

/** 試合作成時に固定するスナップショットを作る */
export function buildSnapshot(
  loaded: LoadedConfig,
  presetId: string,
  overrides?: { buddies?: BuddiesConfig['roster'] },
): ConfigSnapshot {
  const rules = loaded.rules[presetId];
  if (!rules) throw new Error(`不明なプリセット: ${presetId}`);
  const roster = overrides?.buddies ?? loaded.buddies.roster;
  return {
    rules,
    advice: loaded.advice,
    abilities: loaded.abilities,
    models: loaded.models,
    buddies: roster,
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

// ---------------------------------------------------------------------------
// 管理画面からの編集(ホワイトリスト方式)
// ---------------------------------------------------------------------------

const EDITABLE_CONFIG: Record<string, { file: string; validate: (data: unknown) => void }> = {
  'presets/quick-test.json': {
    file: 'config/presets/quick-test.json',
    validate: (d) => rulesConfigSchema.parse(d),
  },
  'presets/pack-test.json': {
    file: 'config/presets/pack-test.json',
    validate: (d) => rulesConfigSchema.parse(d),
  },
  'presets/quick-info.json': {
    file: 'config/presets/quick-info.json',
    validate: (d) => rulesConfigSchema.parse(d),
  },
  'advice.json': { file: 'config/advice.json', validate: (d) => adviceConfigSchema.parse(d) },
  'abilities.json': {
    file: 'config/abilities.json',
    validate: (d) => abilitiesConfigSchema.parse(d),
  },
  'models.json': { file: 'config/models.json', validate: (d) => modelsConfigSchema.parse(d) },
  'buddies.json': { file: 'config/buddies.json', validate: (d) => buddiesConfigSchema.parse(d) },
};

const EDITABLE_PROMPTS = [
  'system.base.md',
  'eval.md',
  'speech.md',
  'role.villager.md',
  'role.seer.md',
  'role.werewolf.md',
  'version.json',
];

export function listEditableFiles(): { config: string[]; prompts: string[] } {
  return { config: Object.keys(EDITABLE_CONFIG), prompts: EDITABLE_PROMPTS };
}

export function readEditableFile(rootDir: string, kind: 'config' | 'prompt', name: string): string {
  const rel = resolveEditable(kind, name);
  return fs.readFileSync(path.join(rootDir, rel), 'utf-8');
}

export function writeEditableFile(
  rootDir: string,
  kind: 'config' | 'prompt',
  name: string,
  text: string,
): void {
  const rel = resolveEditable(kind, name);
  if (kind === 'config' || name.endsWith('.json')) {
    const data = JSON.parse(text); // JSONとして妥当か
    const entry = EDITABLE_CONFIG[name];
    if (entry) entry.validate(data);
  }
  fs.writeFileSync(path.join(rootDir, rel), text, 'utf-8');
}

function resolveEditable(kind: 'config' | 'prompt', name: string): string {
  if (kind === 'config') {
    const entry = EDITABLE_CONFIG[name];
    if (!entry) throw new Error(`編集できない設定ファイル: ${name}`);
    return entry.file;
  }
  if (!EDITABLE_PROMPTS.includes(name)) {
    throw new Error(`編集できないプロンプト: ${name}`);
  }
  return path.posix.join('prompts', name);
}
