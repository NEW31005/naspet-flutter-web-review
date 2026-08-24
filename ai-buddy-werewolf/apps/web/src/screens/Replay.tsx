/** リプレイ/分析画面: 試合中に隠していた内部データを試合後に確認する */
import { useEffect, useState } from 'react';
import { api, type ReplayData } from '../api.js';
import { ErrorBox, LineChart, Spinner, TopBar, colorFor } from '../components.js';
import { describeAdvice } from './Result.js';

export function Replay({ matchId }: { matchId: string }) {
  const [data, setData] = useState<ReplayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    // 進行中の試合は lab=1 でのみ閲覧可(通常は試合後)
    api
      .replay(matchId, false)
      .then(setData)
      .catch(() => api.replay(matchId, true).then(setData).catch((e) => setError(String(e))));
  };
  useEffect(load, [matchId]);

  if (!data) {
    return (
      <>
        <TopBar title="リプレイ/分析" back={`/match/${matchId}/result`} />
        <div className="page">{error ? <ErrorBox error={error} onRetry={load} /> : <Spinner />}</div>
      </>
    );
  }

  const pairIds = Object.keys(data.roles);
  const nameOf = (id: string | null) => (id ? (data.roles[id]?.name ?? id) : '—');
  const roleLabelOf = (id: string) => data.roles[id]?.roleLabel ?? '?';

  // 各バディの怪しい度推移(評価ごと)
  const timelines = pairIds.map((pairId) => {
    const evals = data.evalTimeline.filter((e) => e.pairId === pairId);
    const series = pairIds
      .filter((t) => t !== pairId)
      .map((t) => ({
        name: nameOf(t),
        color: colorFor(pairIds.indexOf(t)),
        points: evals.map((e) => e.output.suspicions[t] ?? null),
        targetId: t,
      }));
    return { pairId, evals, series };
  });

  return (
    <>
      <TopBar title="リプレイ/分析(内部データ)" back={`/match/${matchId}/result`} />
      <div className="page">
        <div className="notice small">
          ここに表示される内部スコア・仮説は試合中には公開されないデータです(生のChain of
          Thoughtは保存していません)。
        </div>

        <div className="card">
          <h2>怪しい度の推移(各バディ視点)</h2>
          {timelines.map((t) => (
            <div key={t.pairId}>
              <h3>
                {nameOf(t.pairId)}
                <span className="badge" style={{ marginLeft: 6 }}>
                  {roleLabelOf(t.pairId)}
                </span>{' '}
                <span className="muted small">評価{t.evals.length}回</span>
              </h3>
              {t.evals.length > 0 ? (
                <LineChart
                  series={t.series}
                  labels={[`d${t.evals[0]?.day}`, `d${t.evals[t.evals.length - 1]?.day}`]}
                />
              ) : (
                <div className="muted small">評価なし</div>
              )}
            </div>
          ))}
        </div>

        <div className="card">
          <h2>裁判の詳細(補正前後)</h2>
          {data.trialDetails.map((t) => (
            <div key={t.day}>
              <h3>
                {t.day}日目 — 処刑: {nameOf(t.executionTargetId)}
                {t.tie ? '(同票抽選)' : ''}
              </h3>
              <div className="scrollx">
                <table className="data">
                  <thead>
                    <tr>
                      <th>バディ</th>
                      <th>主人の選択</th>
                      <th>補正</th>
                      <th>スコア(補正後)</th>
                      <th>投票</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.perPair.map((p) => (
                      <tr key={p.pairId}>
                        <td>{p.pairName}</td>
                        <td>{nameOf(p.masterChoiceId)}</td>
                        <td>+{p.trustBonusApplied.toFixed(1)}</td>
                        <td className="mono">
                          {Object.entries(p.adjustedScores)
                            .sort((a, b) => b[1] - a[1])
                            .map(([k, v]) => `${nameOf(k)}:${v.toFixed(0)}`)
                            .join(' ')}
                        </td>
                        <td>
                          <strong>{nameOf(p.voteTargetId)}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>

        <div className="card">
          <h2>夜の詳細(占い・襲撃統合)</h2>
          {data.nightDetails.map((n) => (
            <div key={n.day}>
              <h3>{n.day}日目の夜</h3>
              {n.divination && (
                <div className="muted small">
                  🔮 占い: {nameOf(n.divination.seerPairId)} → {nameOf(n.divination.targetId)}(
                  {n.divination.isWolf ? '狼憑き' : '人間'})
                  {n.divination.masterProposalId &&
                    ` / 主人の提案: ${nameOf(n.divination.masterProposalId)}`}
                </div>
              )}
              {n.attack && (
                <div className="scrollx">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>狼</th>
                        <th>主人の提案</th>
                        <th>補正後優先度</th>
                        <th>第一候補</th>
                      </tr>
                    </thead>
                    <tbody>
                      {n.attack.perWolf.map((w) => (
                        <tr key={w.pairId}>
                          <td>{nameOf(w.pairId)}</td>
                          <td>{nameOf(w.masterProposalId)}</td>
                          <td className="mono">
                            {Object.entries(w.adjustedPriorities)
                              .sort((a, b) => b[1] - a[1])
                              .map(([k, v]) => `${nameOf(k)}:${v.toFixed(0)}`)
                              .join(' ')}
                          </td>
                          <td>{nameOf(w.topCandidateId)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={2}>
                          <strong>統合結果</strong>
                        </td>
                        <td className="mono">
                          {Object.entries(n.attack.integrated)
                            .sort((a, b) => b[1] - a[1])
                            .map(([k, v]) => `${nameOf(k)}:${v.toFixed(2)}`)
                            .join(' ')}
                        </td>
                        <td>
                          <strong>{nameOf(n.attack.targetId)}</strong>
                          {n.attack.tie ? '(抽選)' : ''}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="card">
          <h2>助言(前後の変化はチャートと突き合わせ)</h2>
          {data.advices.length === 0 && <div className="muted small">助言なし</div>}
          {data.advices.map((a) => (
            <div key={a.seq} className="muted small">
              seq{a.seq} / {a.day}日目 [{a.pairName}の主人] {describeAdvice(a.advice, nameOf)}
            </div>
          ))}
        </div>

        <div className="card">
          <h2>公開発言と生成理由(要約)</h2>
          {data.speeches.map((s) => (
            <div key={s.seq}>
              <div>
                <strong>{s.pairName}</strong>
                <span className="muted small">
                  ({s.day}日目) {s.text}
                </span>
              </div>
              {s.reasonSummary && <div className="muted small">└ 判断理由: {s.reasonSummary}</div>}
            </div>
          ))}
        </div>

        <div className="card">
          <h2>仮説の推移</h2>
          {data.evalTimeline.map((e) => (
            <div key={`${e.seq}`} className="muted small">
              seq{e.seq} d{e.day} [{e.pairName}/{e.kind}] {e.output.primaryHypothesis}
              (確信度{e.output.confidence})
              {e.output.altHypotheses.length > 0 && ` / 別仮説: ${e.output.altHypotheses.join(' | ')}`}
            </div>
          ))}
        </div>

        <div className="card">
          <h2>時系列イベントログ</h2>
          <details>
            <summary>全イベント({data.events.length}件)をJSONで表示</summary>
            <pre className="json">{JSON.stringify(data.events, null, 1)}</pre>
          </details>
        </div>
      </div>
    </>
  );
}
