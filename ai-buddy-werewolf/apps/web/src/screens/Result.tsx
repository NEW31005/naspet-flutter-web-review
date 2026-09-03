/** 結果画面: 勝敗・全役職・指標(トークン/原価/時間) */
import { useEffect, useState } from 'react';
import { api, type MatchRecord, type ReplayData, type ViewResponse } from '../api.js';
import { ErrorBox, Spinner, TopBar } from '../components.js';
import { configVersionLabel, providerLabel } from '../uiLabels.js';

export function Result({ matchId }: { matchId: string }) {
  const [data, setData] = useState<ViewResponse | null>(null);
  const [record, setRecord] = useState<MatchRecord | null>(null);
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api
      .view(matchId, null)
      .then(async (v) => {
        const as = v.view.humanPairId;
        setData(as ? await api.view(matchId, as) : v);
      })
      .catch((e) => setError(String(e)));
    api.exportRecord(matchId).then(setRecord).catch(() => {});
    api.replay(matchId, false).then(setReplay).catch(() => {});
  };
  useEffect(load, [matchId]);

  if (!data) {
    return (
      <>
        <TopBar title="結果" back="/" />
        <div className="page">{error ? <ErrorBox error={error} onRetry={load} /> : <Spinner />}</div>
      </>
    );
  }

  const view = data.view;
  const m = data.metrics;
  const roleOf = (pairId: string) => view.finalRoles?.[pairId] ?? '?';
  const nameOf = (pairId: string | null) =>
    view.pairs.find((p) => p.pairId === pairId)?.buddyName ?? '—';

  return (
    <>
      <TopBar title="試合結果" back="/" />
      <div className="page">
        <div className="card">
          <h1>
            {view.winner === 'citizens'
              ? '☀️ 市民陣営の勝利'
              : view.winner === 'wolves'
                ? '🐺 狼陣営の勝利'
                : view.winner === 'draw'
                  ? '🤝 引き分け'
                  : '進行中'}
          </h1>
          <div className="muted">{view.finishReason}</div>
          <div className="row">
            <span className="badge">{view.matchId}</span>
            <span className="badge">シード: {record?.seed}</span>
            <span className="badge">{providerLabel(record?.provider ?? '')}</span>
          </div>
        </div>

        <div className="card">
          <h2>役職公開</h2>
          {view.pairs.map((p) => (
            <div key={p.pairId} className="row spread">
              <span>
                {p.buddyName}
                {p.isSelf && <span className="badge accent" style={{ marginLeft: 6 }}>あなた</span>}
              </span>
              <span className="row">
                <span
                  className={`badge ${roleOf(p.pairId) === '狼憑き' ? 'wolf' : 'citizen'}`}
                >
                  {roleOf(p.pairId)}
                </span>
                <span className="muted small">
                  {p.alive
                    ? '生存'
                    : `${p.deathDay}日目に${p.deathCause === 'attack' ? '襲撃' : '処刑'}`}
                </span>
              </span>
            </div>
          ))}
        </div>

        {replay && (
          <div className="card">
            <h2>各日の裁判と夜</h2>
            {replay.trialDetails.map((t) => (
              <div key={t.day}>
                <h3>{t.day}日目の裁判 — 処刑: {nameOf(t.executionTargetId)}{t.tie ? '(同票抽選)' : ''}</h3>
                <div className="scrollx">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>バディ</th>
                        <th>主人の選択</th>
                        <th>バディの最終投票</th>
                        <th>一致</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.perPair.map((p) => (
                        <tr key={p.pairId}>
                          <td>{p.pairName}</td>
                          <td>{nameOf(p.masterChoiceId)}</td>
                          <td>{nameOf(p.voteTargetId)}</td>
                          <td>{p.masterChoiceId === p.voteTargetId ? '✔' : '✘'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {replay.nightDetails.map((n) => (
              <div key={n.day} className="muted small">
                🌙 {n.day}日目の夜:{' '}
                {n.attack
                  ? `襲撃 → ${nameOf(n.attack.targetId)}(狼${n.attack.perWolf.length}体の統合${n.attack.tie ? '/同点抽選' : ''})`
                  : '襲撃なし'}
                {n.divination && ` / 占い → ${nameOf(n.divination.targetId)}`}
              </div>
            ))}
          </div>
        )}

        {replay && replay.advices.length > 0 && (
          <div className="card">
            <h2>主人の助言履歴</h2>
            {replay.advices.map((a) => (
              <div key={a.seq} className="muted small">
                {a.day}日目 [{a.pairName}の主人] {describeAdvice(a.advice, nameOf)}
              </div>
            ))}
          </div>
        )}

        <div className="card">
          <h2>実験指標</h2>
          <div className="scrollx">
            <table className="data">
              <tbody>
                <tr>
                  <th>モデル/プロバイダー</th>
                  <td>
                    {providerLabel(record?.provider ?? '')}
                    {record && record.aiCalls[0] ? ` (${record.aiCalls[0].model})` : ''}
                  </td>
                </tr>
                <tr>
                  <th>設定バージョン</th>
                  <td className="mono">
                    {record
                      ? Object.entries(record.configSnapshot.versions)
                          .map(([k, v]) => `${configVersionLabel(k)}:${v}`)
                          .join(' ')
                      : '…'}
                  </td>
                </tr>
                <tr>
                  <th>AIコール数</th>
                  <td>
                    {m.aiCallCount}(エラー{m.errorCount} / リトライ{m.retryCount} / JSON失敗
                    {m.jsonErrorCount} / フォールバック{m.fallbackCount})
                  </td>
                </tr>
                <tr>
                  <th>トークン</th>
                  <td>
                    入力 {m.inputTokens.toLocaleString()} / 出力 {m.outputTokens.toLocaleString()}
                  </td>
                </tr>
                <tr>
                  <th>推定原価</th>
                  <td>${m.costUsd.toFixed(4)}</td>
                </tr>
                <tr>
                  <th>総試合時間</th>
                  <td>{m.wallClockMs != null ? `${(m.wallClockMs / 1000).toFixed(1)}秒` : '—'}</td>
                </tr>
                <tr>
                  <th>延べAI処理時間</th>
                  <td>
                    {(m.aiWaitMs / 1000).toFixed(1)}秒
                    <div className="muted small">並列コールも足した値で、実際の体感待機時間ではありません。</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h2>次のアクション</h2>
          <div className="row">
            <button className="primary" onClick={() => (location.hash = `/match/${matchId}/replay`)}>
              🔍 リプレイ/内部分析
            </button>
            <button onClick={() => (location.hash = `/match/${matchId}/lab`)}>検証室</button>
            <button className="ghost" onClick={() => void api.downloadRecord(matchId)}>
              JSON書き出し
            </button>
          </div>
          <p className="muted small">
            公開Webでは、再読み込み後の生リクエスト・応答は秘密保護と容量対策のため直近30コールのみ残ります。完全版は試合終了直後にJSONを書き出してください。
          </p>
        </div>
        {error && <ErrorBox error={error} onRetry={load} />}
      </div>
    </>
  );
}

export function describeAdvice(
  advice: { kind: string; targetId?: string; themeId?: string; factId?: string; directiveId?: string },
  nameOf: (id: string | null) => string,
): string {
  switch (advice.kind) {
    case 'suspicion':
      return `主観的な疑い → ${nameOf(advice.targetId ?? null)}`;
    case 'question':
      return `質問指定 → ${nameOf(advice.targetId ?? null)} (${advice.themeId})`;
    case 'fact_share':
      return `確定情報の共有 (${advice.factId})`;
    case 'skill_target':
      return `次回スキル対象の提案 → ${nameOf(advice.targetId ?? null)}`;
    case 'behavior':
      return `立ち回りの提案 (${advice.directiveId})`;
    default:
      return advice.kind;
  }
}
