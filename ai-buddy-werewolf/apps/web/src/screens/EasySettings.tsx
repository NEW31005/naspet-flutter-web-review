/** 日常的な実験調整を、JSONを触らず日本語で行う画面。 */
import { useEffect, useMemo, useState } from 'react';
import type {
  AdviceConfig,
  ModelsConfig,
  ProviderConfig,
  RulesConfig,
  TrustFnConfig,
} from '@aibw/shared';
import { api } from '../api.js';
import { ErrorBox, Spinner } from '../components.js';
import { masterPolicyLabel, modelLabel, providerLabel } from '../uiLabels.js';

type PresetKey = 'quick' | 'pack';
type Draft = {
  quick: RulesConfig;
  pack: RulesConfig;
  advice: AdviceConfig;
  models: ModelsConfig;
};
type LiveProvider = Exclude<ProviderConfig, { type: 'mock' }>;

const PRESET_META: Record<PresetKey, { label: string; file: string }> = {
  quick: { label: 'クイックテスト', file: 'presets/quick-test.json' },
  pack: { label: '群れテスト（狼2組）', file: 'presets/pack-test.json' },
};

const TRUST_META: {
  key: keyof RulesConfig['trust'];
  label: string;
  help: string;
}[] = [
  {
    key: 'trialChoice',
    label: '裁判で主人が選んだ相手',
    help: '主人の処刑希望を、バディの最終投票へどれだけ加味するか。',
  },
  {
    key: 'nightProposal',
    label: '主人の夜襲提案',
    help: '狼憑きの主人が提案した襲撃先を、候補評価へどれだけ加味するか。',
  },
  {
    key: 'skillProposal',
    label: '次回スキル対象の提案',
    help: '主人が提案した占い先などを、バディがどれだけ重く見るか。',
  },
  {
    key: 'subjectiveAdvice',
    label: '「この人が怪しい」という助言',
    help: '主人の主観的な疑いを、バディの怪しさ評価へどれだけ加味するか。',
  },
];

function parseFile<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`${label}を読み取れませんでした: ${String(cause)}`);
  }
}

function isLiveProvider(provider: ProviderConfig | undefined): provider is LiveProvider {
  return !!provider && provider.type !== 'mock';
}

function validateRules(rules: RulesConfig, label: string): void {
  if (!Number.isInteger(rules.pairCount) || rules.pairCount < 3 || rules.pairCount > 20) {
    throw new Error(`${label}の参加ペア数は3〜20組にしてください。`);
  }
  if (!Number.isInteger(rules.roleSetup.werewolf) || rules.roleSetup.werewolf < 1) {
    throw new Error(`${label}の狼憑きは1組以上にしてください。`);
  }
  if (!Number.isInteger(rules.roleSetup.seer) || rules.roleSetup.seer < 0) {
    throw new Error(`${label}の占い役は0組以上にしてください。`);
  }
  if (rules.roleSetup.werewolf + rules.roleSetup.seer > rules.pairCount) {
    throw new Error(`${label}の狼憑きと占い役の合計が、参加ペア数を超えています。`);
  }
  if (
    rules.firstNightDivination === 'white' &&
    rules.roleSetup.seer > 0 &&
    rules.pairCount - rules.roleSetup.werewolf < 2
  ) {
    throw new Error(`${label}の初日白通知には、占い役以外の市民陣営が1組以上必要です。`);
  }
  if (rules.maxDays < 1 || rules.maxDays > 20) {
    throw new Error(`${label}の最大日数は1〜20日にしてください。`);
  }
  if (rules.discussionRounds < 1 || rules.discussionRounds > 10) {
    throw new Error(`${label}の討論回数は1〜10周にしてください。`);
  }
  if (rules.speechesPerBuddyPerRound < 1 || rules.speechesPerBuddyPerRound > 3) {
    throw new Error(`${label}の1周あたり発言回数は1〜3回にしてください。`);
  }
  if (rules.advicePerDay < 0 || rules.advicePerDay > 10) {
    throw new Error(`${label}の助言回数は0〜10回にしてください。`);
  }
}

function NumberSetting({
  label,
  help,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  help?: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field setting-field">
      <span>{label}</span>
      {help && <span className="setting-help">{help}</span>}
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

function trustTypeLabel(type: TrustFnConfig['type']): string {
  if (type === 'linear') return '親密度に比例して強くする';
  if (type === 'quadratic') return '高い親密度で一気に強くする';
  return 'この助言は判断へ加味しない';
}

export function EasySettings({ onSaved }: { onSaved?: () => void | Promise<void> }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [presetKey, setPresetKey] = useState<PresetKey>('quick');
  const [liveProviderName, setLiveProviderName] = useState('lab-live');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      api.readFile('config', PRESET_META.quick.file),
      api.readFile('config', PRESET_META.pack.file),
      api.readFile('config', 'advice.json'),
      api.readFile('config', 'models.json'),
    ])
      .then(([quick, pack, advice, models]) => {
        const next: Draft = {
          quick: parseFile(quick.text, 'クイックテスト'),
          pack: parseFile(pack.text, '群れテスト'),
          advice: parseFile(advice.text, '助言設定'),
          models: parseFile(models.text, 'AIモデル設定'),
        };
        setDraft(next);
        const names = Object.entries(next.models.providers)
          .filter(([, provider]) => provider.type !== 'mock')
          .map(([name]) => name);
        setLiveProviderName(names.includes('lab-live') ? 'lab-live' : names[0] ?? '');
      })
      .catch((cause) => setError(String(cause)));
  }, []);

  const change = (mutate: (next: Draft) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutate(next);
      return next;
    });
    setDirty(true);
    setStatus(null);
  };

  const liveEntries = useMemo(
    () =>
      draft
        ? Object.entries(draft.models.providers).filter((entry): entry is [string, LiveProvider] =>
            isLiveProvider(entry[1]),
          )
        : [],
    [draft],
  );
  const liveProvider = draft?.models.providers[liveProviderName];

  const updateRules = (mutate: (rules: RulesConfig) => void) =>
    change((next) => mutate(next[presetKey]));

  const updateLive = (mutate: (provider: LiveProvider) => void) =>
    change((next) => {
      const provider = next.models.providers[liveProviderName];
      if (isLiveProvider(provider)) mutate(provider);
    });

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      validateRules(draft.quick, PRESET_META.quick.label);
      validateRules(draft.pack, PRESET_META.pack.label);
      for (const [name, provider] of Object.entries(draft.models.providers)) {
        if (!isLiveProvider(provider)) continue;
        if (provider.maxTokensEval < 256 || provider.maxTokensSpeech < 128) {
          throw new Error(`${providerLabel(name, provider.type)}の最大出力量が小さすぎます。`);
        }
        if (provider.timeoutMs < 1000) {
          throw new Error(`${providerLabel(name, provider.type)}の待ち時間上限は1秒以上にしてください。`);
        }
      }
      await api.writeFile('config', PRESET_META.quick.file, JSON.stringify(draft.quick, null, 2));
      await api.writeFile('config', PRESET_META.pack.file, JSON.stringify(draft.pack, null, 2));
      await api.writeFile('config', 'advice.json', JSON.stringify(draft.advice, null, 2));
      await api.writeFile('config', 'models.json', JSON.stringify(draft.models, null, 2));
      await onSaved?.();
      setDirty(false);
      setStatus('かんたん設定を保存しました。次の新規試合から反映されます。');
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!draft) {
    return <div className="card">{error ? <ErrorBox error={error} /> : <Spinner label="設定を読み込み中…" />}</div>;
  }

  const rules = draft[presetKey];

  return (
    <div className="card easy-settings">
      <div>
        <h2>🎛 かんたん設定</h2>
        <div className="muted small">
          よく調整するルール・助言・AIモデルだけを日本語で変更できます。保存形式は本番モバイルへ渡せる従来のJSONのままです。
        </div>
      </div>

      <section className="settings-section">
        <h3>試合ルール</h3>
        <div className="segmented" role="tablist" aria-label="編集する試験">
          {(Object.keys(PRESET_META) as PresetKey[]).map((key) => (
            <button
              type="button"
              role="tab"
              aria-selected={presetKey === key}
              className={presetKey === key ? 'primary' : 'ghost'}
              key={key}
              onClick={() => setPresetKey(key)}
            >
              {PRESET_META[key].label}
            </button>
          ))}
        </div>
        <label className="field">
          試験名
          <input value={rules.label} onChange={(event) => updateRules((r) => (r.label = event.target.value))} />
        </label>
        <label className="field">
          このルールの版番号
          <span className="setting-help">比較しやすいよう、条件を変えたら番号も更新してください。</span>
          <input value={rules.version} onChange={(event) => updateRules((r) => (r.version = event.target.value))} />
        </label>
        <div className="settings-grid">
          <NumberSetting
            label="参加ペア数"
            help="人間の主人とAIバディで1組です。"
            value={rules.pairCount}
            min={3}
            max={20}
            onChange={(value) => updateRules((r) => (r.pairCount = value))}
          />
          <NumberSetting
            label="狼憑きの組数"
            value={rules.roleSetup.werewolf}
            min={1}
            max={rules.pairCount}
            onChange={(value) => updateRules((r) => (r.roleSetup.werewolf = value))}
          />
          <NumberSetting
            label="占い役の組数"
            help="残りはすべて市民になります。"
            value={rules.roleSetup.seer}
            min={0}
            max={rules.pairCount}
            onChange={(value) => updateRules((r) => (r.roleSetup.seer = value))}
          />
          <NumberSetting
            label="最大日数"
            value={rules.maxDays}
            min={1}
            max={20}
            onChange={(value) => updateRules((r) => (r.maxDays = value))}
          />
          <NumberSetting
            label="1日の討論段階数"
            help="2以上なら「AIだけの冒頭討論 → 主人の相談 → 応答討論」になります。3以上は応答討論を追加します。"
            value={rules.discussionRounds}
            min={1}
            max={10}
            onChange={(value) => updateRules((r) => (r.discussionRounds = value))}
          />
          <NumberSetting
            label="各段階でバディが話す回数"
            help="指名質問の日は、質問・単独回答・受け止め・周囲の反応を優先します。"
            value={rules.speechesPerBuddyPerRound}
            min={1}
            max={3}
            onChange={(value) => updateRules((r) => (r.speechesPerBuddyPerRound = value))}
          />
          <NumberSetting
            label="主人が1日に助言できる回数"
            value={rules.advicePerDay}
            min={0}
            max={10}
            onChange={(value) => updateRules((r) => (r.advicePerDay = value))}
          />
          <label className="field setting-field">
            他の主人の動き方
            <span className="setting-help">自分以外の組を誰が操作するか。</span>
            <select
              value={rules.otherMastersPolicy}
              onChange={(event) =>
                updateRules((r) =>
                  (r.otherMastersPolicy = event.target.value as RulesConfig['otherMastersPolicy']))
              }
            >
              {(['none', 'random', 'simple', 'ai'] as const).map((policy) => (
                <option key={policy} value={policy}>{masterPolicyLabel(policy)}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="toggle-setting">
          <input
            type="checkbox"
            checked={rules.revealRoleOnDeath}
            onChange={(event) => updateRules((r) => (r.revealRoleOnDeath = event.target.checked))}
          />
          <span>
            <strong>脱落したときに役職を公開する</strong>
            <small>オフなら役職は試合終了まで伏せられます。</small>
          </span>
        </label>
        <label className="toggle-setting">
          <input
            type="checkbox"
            checked={rules.firstNightDivination === true || rules.firstNightDivination === 'white'}
            disabled={rules.roleSetup.seer === 0}
            onChange={(event) =>
              updateRules((r) => (r.firstNightDivination = event.target.checked ? 'white' : false))
            }
          />
          <span>
            <strong>初日の朝に、占い主人へ白結果を1件届ける</strong>
            <small>
              「占う→主人が共有を選ぶ→卓が反応する」を初日から試せます。市民側が有利になりやすいため、情報共有ループの検証用です。
            </small>
          </span>
        </label>
        <div className="factbox small">
          同票は同票者からシード付き抽選。複数の狼憑きの夜襲は、各バディの候補評価を公平にそろえて合算します。
        </div>
      </section>

      <details className="settings-details">
        <summary>主人との親密度が判断へ与える強さ</summary>
        <div className="muted small settings-details-intro">
          「最大影響値」は親密度100の主人が選んだ候補へ加える点数です。親密度が高いほど、バディは自分と異なる意見でも主人を優先します。確定情報との矛盾や大きな評価差があれば別の判断もできるため、命令や確定票にはなりません。裁判は32を現在の比較候補にしています。
        </div>
        {TRUST_META.map((meta) => {
          const trust = rules.trust[meta.key];
          return (
            <div className="trust-setting" key={meta.key}>
              <strong>{meta.label}</strong>
              <span className="setting-help">{meta.help}</span>
              <div className="settings-grid">
                <label className="field">
                  効かせ方
                  <select
                    value={trust.type}
                    onChange={(event) =>
                      updateRules((r) =>
                        (r.trust[meta.key].type = event.target.value as TrustFnConfig['type']))
                    }
                  >
                    {(['linear', 'quadratic', 'none'] as const).map((type) => (
                      <option key={type} value={type}>{trustTypeLabel(type)}</option>
                    ))}
                  </select>
                </label>
                <NumberSetting
                  label="最大影響値"
                  value={trust.maxBonus}
                  min={0}
                  max={100}
                  onChange={(value) => updateRules((r) => (r.trust[meta.key].maxBonus = value))}
                />
              </div>
            </div>
          );
        })}
      </details>

      <section className="settings-section">
        <h3>主人から送れる助言</h3>
        <label className="field compact-version">
          助言設定の版番号
          <input
            value={draft.advice.version}
            onChange={(event) => change((next) => (next.advice.version = event.target.value))}
          />
        </label>
        <div className="advice-settings">
          {draft.advice.menu.map((item, index) => (
            <div className="advice-setting" key={item.kind}>
              <label className="toggle-setting">
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={(event) =>
                    change((next) => (next.advice.menu[index]!.enabled = event.target.checked))
                  }
                />
                <span><strong>{item.label}</strong><small>{item.description}</small></span>
              </label>
            </div>
          ))}
        </div>
        <details className="settings-details">
          <summary>質問と立ち回りの表示文を変更する</summary>
          <div className="settings-list">
            {draft.advice.questionThemes.map((theme, index) => (
              <label className="field" key={theme.id}>
                質問 {index + 1}
                <input
                  value={theme.label}
                  onChange={(event) =>
                    change((next) => (next.advice.questionThemes[index]!.label = event.target.value))
                  }
                />
              </label>
            ))}
            {draft.advice.behaviorDirectives.map((directive, index) => (
              <label className="field" key={directive.id}>
                立ち回り {index + 1}
                <input
                  value={directive.label}
                  onChange={(event) =>
                    change((next) =>
                      (next.advice.behaviorDirectives[index]!.label = event.target.value))
                  }
                />
              </label>
            ))}
          </div>
        </details>
      </section>

      <section className="settings-section">
        <h3>試合で使うAI</h3>
        <label className="field">
          通常使うAI
          <select
            value={draft.models.defaultProvider}
            onChange={(event) => change((next) => (next.models.defaultProvider = event.target.value))}
          >
            {Object.entries(draft.models.providers).map(([name, provider]) => (
              <option key={name} value={name}>{providerLabel(name, provider.type)}</option>
            ))}
          </select>
        </label>
        <label className="field compact-version">
          AIモデル設定の版番号
          <input
            value={draft.models.version}
            onChange={(event) => change((next) => (next.models.version = event.target.value))}
          />
        </label>

        {liveEntries.length > 0 && (
          <details className="settings-details" open>
            <summary>実際のAI（Live）の品質・待ち時間・原価</summary>
            {liveEntries.length > 1 && (
              <label className="field settings-details-intro">
                調整する接続先
                <select value={liveProviderName} onChange={(event) => setLiveProviderName(event.target.value)}>
                  {liveEntries.map(([name, provider]) => (
                    <option key={name} value={name}>{providerLabel(name, provider.type)}</option>
                  ))}
                </select>
              </label>
            )}
            {isLiveProvider(liveProvider) && (
              <>
                <label className="field">
                  使用モデル
                  <select value={liveProvider.model} onChange={(event) => updateLive((p) => (p.model = event.target.value))}>
                    {Object.keys(liveProvider.prices).map((model) => (
                      <option key={model} value={model}>{modelLabel(model)}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  考える深さ
                  <select
                    value={liveProvider.effort}
                    onChange={(event) =>
                      updateLive((p) => (p.effort = event.target.value as LiveProvider['effort']))
                    }
                  >
                    <option value="low">軽め（速さ優先）</option>
                    <option value="medium">標準</option>
                    <option value="high">深く考える（品質優先）</option>
                  </select>
                </label>
                <div className="settings-grid">
                  <NumberSetting
                    label="内部評価の最大出力量"
                    help="長くすると詳しくなりますが、原価と待ち時間が増えます。"
                    value={liveProvider.maxTokensEval}
                    min={256}
                    max={20000}
                    onChange={(value) => updateLive((p) => (p.maxTokensEval = value))}
                  />
                  <NumberSetting
                    label="公開発言の最大出力量"
                    value={liveProvider.maxTokensSpeech}
                    min={128}
                    max={10000}
                    onChange={(value) => updateLive((p) => (p.maxTokensSpeech = value))}
                  />
                  <NumberSetting
                    label="1回の待ち時間上限（秒）"
                    value={Math.round(liveProvider.timeoutMs / 1000)}
                    min={1}
                    max={300}
                    onChange={(value) => updateLive((p) => (p.timeoutMs = value * 1000))}
                  />
                  <NumberSetting
                    label="形式エラー時の再試行回数"
                    value={liveProvider.jsonRetries}
                    min={0}
                    max={5}
                    onChange={(value) => updateLive((p) => (p.jsonRetries = value))}
                  />
                </div>
                <details className="settings-details nested-details">
                  <summary>モデル単価を変更する</summary>
                  <div className="muted small settings-details-intro">
                    1,000,000トークンあたりの米ドル単価です。試合結果の推定原価に使われます。
                  </div>
                  {Object.entries(liveProvider.prices).map(([model, price]) => (
                    <div className="price-setting" key={model}>
                      <strong>{modelLabel(model)}</strong>
                      <div className="settings-grid">
                        <NumberSetting
                          label="入力単価（米ドル）"
                          value={price.inputPerMTok}
                          min={0}
                          step={0.01}
                          onChange={(value) =>
                            updateLive((p) => (p.prices[model]!.inputPerMTok = value))
                          }
                        />
                        <NumberSetting
                          label="出力単価（米ドル）"
                          value={price.outputPerMTok}
                          min={0}
                          step={0.01}
                          onChange={(value) =>
                            updateLive((p) => (p.prices[model]!.outputPerMTok = value))
                          }
                        />
                      </div>
                    </div>
                  ))}
                </details>
              </>
            )}
          </details>
        )}
      </section>

      <button className="primary save-settings" onClick={() => void save()} disabled={!dirty || saving}>
        {saving ? '保存中…' : dirty ? 'かんたん設定を保存' : '保存済み'}
      </button>
      {status && <div className="factbox">{status}</div>}
      {error && <ErrorBox error={error} />}
    </div>
  );
}
