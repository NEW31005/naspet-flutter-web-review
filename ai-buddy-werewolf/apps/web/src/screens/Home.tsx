/** ホーム/実験開始画面 */
import { useEffect, useState } from 'react';
import { api, type ConfigResponse, type MatchSummary } from '../api.js';
import { ErrorBox, TopBar } from '../components.js';
import { isStaticLab } from '../runtime/access.js';
import {
  masterPolicyLabel,
  modeLabel,
  phaseLabel,
  presetIdLabel,
  providerLabel,
} from '../uiLabels.js';

export function Home() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [presetId, setPresetId] = useState('quick-test');
  const [mode, setMode] = useState<'play' | 'lab'>('play');
  const [provider, setProvider] = useState('mock');
  const [seed, setSeed] = useState('');
  const [humanPairIndex, setHumanPairIndex] = useState(0);

  const load = () => {
    api
      .config()
      .then((c) => {
        setConfig(c);
        setProvider(c.models.defaultProvider);
      })
      .catch((e) => setError(String(e)));
    api
      .matches()
      .then(setMatches)
      .catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const start = async () => {
    setCreating(true);
    setError(null);
    try {
      const summary = await api.createMatch({
        presetId,
        mode,
        provider,
        seed: seed || undefined,
        humanPairIndex: mode === 'play' ? humanPairIndex : null,
      });
      location.hash = mode === 'lab' ? `/match/${summary.matchId}/lab` : `/match/${summary.matchId}`;
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const preset = config?.presets.find((p) => p.presetId === presetId);

  return (
    <>
      <TopBar title="AIバディ人狼 — Phase0 実験" />
      <div className="page">
        <div className="card">
          <h2>🌙 新規試合</h2>
          <p className="muted small">
            裏切りか、信頼か。2人で力を合わせて生き残れ。あなたは断頭台から、円卓のバディへ限られた助言を送る。
          </p>
          <label className="field">
            プリセット
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {config?.presets.map((p) => (
                <option key={p.presetId} value={p.presetId}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {preset && (
            <div className="muted small">
              {preset.pairCount}組 / 狼憑き{preset.roleSetup.werewolf}組 / 占い役
              {preset.roleSetup.seer}組 / 最大{preset.maxDays}日 / 助言{preset.advicePerDay}回/日
              <br />討論:{' '}
              {preset.discussionMode === 'timed'
                ? `${preset.discussionDurationSec}秒の自由討論 / AI最大${preset.discussionBatchSize}人が同時に考える`
                : preset.discussionRounds === 1
                  ? '1段階'
                  : `初日2人の弁明 → 全員評価 → 相談 → 応答（${preset.discussionRounds}段階）`}
              <br />他の主人: {masterPolicyLabel(preset.otherMastersPolicy)}
            </div>
          )}
          <div className="grid2">
            <label className="field">
              モード
              <select value={mode} onChange={(e) => setMode(e.target.value === 'lab' ? 'lab' : 'play')}>
                <option value="play">プレイテスト（1組の主人として遊ぶ）</option>
                <option value="lab">検証室（全組を観察・操作）</option>
              </select>
            </label>
            <label className="field">
              AIプロバイダー
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {config &&
                  Object.entries(config.models.providers).map(([name, p]) => (
                    <option key={name} value={name}>
                      {providerLabel(name, p.type)}
                      {p.type === 'labProxy'
                        ? ` — ${p.model}`
                        : p.type === 'anthropic'
                        ? ` — ${p.model}${p.hasKey ? '' : '（接続キー未設定）'}`
                        : ''}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="grid2">
            <label className="field">
              シード(空欄で自動)
              <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="例: exp-1" />
            </label>
            {mode === 'play' && (
              <label className="field">
                担当する組(バディ)
                <select
                  value={humanPairIndex}
                  onChange={(e) => setHumanPairIndex(Number(e.target.value))}
                >
                  {config?.buddies.roster.slice(0, preset?.pairCount ?? 5).map((b, i) => (
                    <option key={b.id} value={i}>
                      {b.persona.name}({b.persona.archetype})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {config &&
            provider !== 'mock' &&
            config.models.providers[provider]?.type === 'anthropic' &&
            !config.models.providers[provider]?.hasKey && (
              <div className="notice">
                環境変数 {config.models.providers[provider]?.apiKeyEnv}
                が未設定です。Live実行は失敗し、モックへフォールバックされます。
              </div>
            )}
          <button className="primary" onClick={start} disabled={creating || !config}>
            {creating ? '作成中…' : '呪われた村へ入る(試合開始)'}
          </button>
        </div>

        <div className="card">
          <h2>⚙️ 実験設定</h2>
          <div className="row">
            <button onClick={() => (location.hash = '/buddies')}>バディ設定</button>
            <button onClick={() => (location.hash = '/settings')}>かんたん設定・AIへの指示文</button>
          </div>
          <div className="muted small">
            設定バージョン: プロンプト v{config?.promptVersion ?? '…'} / モデル設定 v
            {config?.models.version ?? '…'}
          </div>
          {isStaticLab && (
            <div className="notice small">
              この公開Labの設定・試合はこのブラウザだけに保存されます。調整結果は設定画面から
              「モバイル引継ぎパッケージ」として書き出してください。
            </div>
          )}
        </div>

        <div className="card">
          <h2>📜 過去試合一覧</h2>
          {matches.length === 0 && <div className="muted small">まだ試合がありません</div>}
          {matches.map((m) => (
            <div key={m.matchId} className="listitem">
              <div>
                <div className="row" style={{ gap: 6 }}>
                  <span className="mono">{m.matchId}</span>
                  <span className="badge">{presetIdLabel(m.presetId)}</span>
                  <span className="badge">{providerLabel(m.provider)}</span>
                  <span className="badge">{modeLabel(m.mode)}</span>
                </div>
                <div className="muted small">
                  {new Date(m.createdAt).toLocaleString('ja-JP')} /{' '}
                  {m.winner
                    ? `決着: ${m.winner === 'citizens' ? '市民勝利' : m.winner === 'wolves' ? '狼勝利' : '引分'}`
                    : `${m.day}日目 ${phaseLabel(m.phase)}`}{' '}
                  / 推定原価 ${m.costUsd.toFixed(4)}
                </div>
              </div>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <button
                  className="ghost"
                  onClick={() =>
                    (location.hash = m.winner ? `/match/${m.matchId}/result` : `/match/${m.matchId}`)
                  }
                >
                  {m.winner ? '結果' : '再開'}
                </button>
                <button className="ghost" onClick={() => (location.hash = `/match/${m.matchId}/lab`)}>
                  検証室
                </button>
              </div>
            </div>
          ))}
        </div>
        {error && <ErrorBox error={error} onRetry={load} />}
      </div>
    </>
  );
}
