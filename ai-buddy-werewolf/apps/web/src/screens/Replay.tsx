/** リプレイ/分析画面: 試合中に隠していた内部データを試合後に確認する */
import { useEffect, useState } from 'react';
import { api, type ReplayData } from '../api.js';
import { ErrorBox, LineChart, Spinner, TopBar, colorFor } from '../components.js';
import { roleLabel } from '../uiLabels.js';
import { describeAdvice } from './Result.js';

export function Replay({ matchId }: { matchId: string }) {
  const [data, setData] = useState<ReplayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    // 通常のリプレイは試合終了後だけ。検証室権限への自動切替は秘密情報漏えいになる。
    api.replay(matchId, false).then(setData).catch((e) => setError(String(e)));
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
          <h2>役職を名乗る相談と判断</h2>
          <p className="muted small">
            🔒は主人からバディだけへ届いた相談、🎭は円卓へ実際に公開された名乗りです。真偽は試合中には伏せられていました。
          </p>
          {data.roleClaimDetails.length === 0 && (
            <div className="muted small">この試合では役職を名乗る相談・公開の名乗りはありません。</div>
          )}
          {data.roleClaimDetails.map((detail) => (
            <div key={`${detail.day}-${detail.pairId}`} className="role-claim-result">
              <div className="row spread">
                <strong>{detail.day}日目・{detail.pairName}</strong>
                <span className="badge">本当の役職：{detail.trueRoleLabel}</span>
              </div>
              <div className="muted small">
                🔒 主人の相談：
                {!detail.masterProposalSet
                  ? '相談なし'
                  : detail.masterProposal == null
                    ? '今日はまだ名乗らないでほしい'
                    : `${roleLabel(detail.masterProposal)}として名乗ってほしい`}
              </div>
              {detail.publicClaims.length === 0 ? (
                <div className="muted small">🎭 実際の名乗り：なし（バディが見送った）</div>
              ) : (
                detail.publicClaims.map((claim) => (
                  <div key={claim.seq} className="muted small">
                    🎭 実際の名乗り：<strong>{claim.claimedRoleLabel}</strong>{' '}
                    <span className={`badge ${claim.isTruth ? 'ok' : 'warn'}`}>
                      {claim.isTruth ? '真実' : '別の役職として名乗った'}
                    </span>
                  </div>
                ))
              )}
            </div>
          ))}
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
          <h2>夜の詳細（占い・護衛・霊媒・襲撃）</h2>
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
              {data.events
                .filter((event) => event.type === 'guard_detail' && event.day === n.day)
                .map((event) =>
                  event.type === 'guard_detail' ? (
                    <div key={event.seq} className="muted small">
                      🛡️ 騎士: {nameOf(event.payload.guardianPairId)} →{' '}
                      {nameOf(event.payload.targetId)}
                      {event.payload.masterProposalId &&
                        ` / 主人の提案: ${nameOf(event.payload.masterProposalId)}`}
                      {event.payload.blockedAttack ? ' / 襲撃を防いだ' : ''}
                      <div className="mono">
                        補正後:{' '}
                        {Object.entries(event.payload.adjustedPriorities)
                          .sort((a, b) => b[1] - a[1])
                          .map(([pairId, score]) => `${nameOf(pairId)}:${score.toFixed(0)}`)
                          .join(' ')}
                      </div>
                    </div>
                  ) : null,
                )}
              {data.events
                .filter((event) => event.type === 'medium_result' && event.day === n.day)
                .map((event) =>
                  event.type === 'medium_result' ? (
                    <div key={event.seq} className="muted small">
                      🕯️ 霊媒: {nameOf(event.payload.mediumPairId)} →{' '}
                      {nameOf(event.payload.targetId)}は
                      {event.payload.fact.isWolf ? '狼憑き' : '狼憑きではない'}
                    </div>
                  ) : null,
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
