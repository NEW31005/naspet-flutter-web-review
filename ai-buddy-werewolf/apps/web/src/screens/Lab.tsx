/** Lab/デバッグ画面: 全内部状態・ステップ実行・巻き戻し・生リクエスト確認・注入 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Advice, type AiCallRecord, type ViewResponse } from '../api.js';
import { ErrorBox, Sheet, Spinner, TopBar } from '../components.js';
import { pendingLabel, phaseLabel, providerLabel } from '../uiLabels.js';

export function Lab({ matchId }: { matchId: string }) {
  const [data, setData] = useState<ViewResponse | null>(null);
  const [calls, setCalls] = useState<AiCallRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [auto, setAuto] = useState(false);
  const [injectPair, setInjectPair] = useState<string>('p1');
  const [injectSheet, setInjectSheet] = useState<null | 'advice' | 'trial' | 'night'>(null);
  const autoRef = useRef(auto);
  autoRef.current = auto;

  const refresh = useCallback(async () => {
    try {
      const [v, c] = await Promise.all([api.view(matchId, 'gm'), api.calls(matchId)]);
      setData(v);
      setCalls(c);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [matchId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!auto || !data || acting) return;
    if (data.view.pending.type === 'finished') {
      setAuto(false);
      return;
    }
    const t = setTimeout(() => void step(), 250);
    return () => clearTimeout(t);
    // 依存を意図的に絞っている(dataの変化のみで駆動)
  }, [auto, data, acting]);

  const run = async (fn: () => Promise<unknown>) => {
    setActing(true);
    try {
      await fn();
      await refresh();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setActing(false);
    }
  };
  const step = () => run(() => api.advance(matchId));

  if (!data) {
    return (
      <>
        <TopBar title="検証室" back="/" />
        <div className="page">{error ? <ErrorBox error={error} onRetry={refresh} /> : <Spinner />}</div>
      </>
    );
  }

  const view = data.view;
  const alive = view.pairs.filter((p) => p.alive);
  const aliveOthers = (pairId: string) => alive.filter((p) => p.pairId !== pairId);

  return (
    <>
      <TopBar
        title={`検証室 — ${view.day}日目 ${phaseLabel(view.phase)}`}
        back="/"
        right={(acting || data.busy) ? <Spinner /> : <span className="badge">{providerLabel(view.provider)}</span>}
      />
      <div className="page">
        <div className="card">
          <h2>🎛 進行コントロール</h2>
          <div className="row">
            <button className="primary" onClick={step} disabled={acting}>
              ▶ 1ステップ
            </button>
            <button onClick={() => setAuto(!auto)}>{auto ? '⏸ 自動停止' : '⏩ 自動進行'}</button>
            <button onClick={() => run(() => api.rewind(matchId))} disabled={acting}>
              ⏪ フェーズ先頭へ巻き戻し
            </button>
          </div>
          <div className="row">
            <button
              onClick={() => run(() => api.reloadAi(matchId))}
              title="プロンプト/モデル設定をディスクから再読込"
            >
              ♻️ プロンプト/モデル再読込
            </button>
            <button
              onClick={() =>
                run(async () => {
                  const s = await api.createMatch({
                    presetId: '',
                    mode: view.mode,
                    rematchOf: matchId,
                    sameSeed: true,
                  });
                  location.hash = `/match/${s.matchId}/lab`;
                })
              }
            >
              🔁 同シードで再戦
            </button>
            <button
              onClick={() =>
                run(async () => {
                  const s = await api.createMatch({
                    presetId: '',
                    mode: view.mode,
                    rematchOf: matchId,
                    sameSeed: false,
                  });
                  location.hash = `/match/${s.matchId}/lab`;
                })
              }
            >
              🎲 新シードで再戦
            </button>
            <button
              className="danger"
              onClick={() => {
                if (confirm('この試合データを削除しますか?')) {
                  void run(async () => {
                    await api.deleteMatch(matchId);
                    location.hash = '/';
                  });
                }
              }}
            >
              🗑 削除
            </button>
          </div>
          <div className="muted small">
            現在の状態: {pendingLabel(view.pending.type)}
            {view.pending.type === 'wait_inputs' &&
              ' — ' +
                view.pending.missing.map((miss) => `${miss.pairId}:${miss.input}`).join(', ')}
          </div>
        </div>

        <div className="card">
          <h2>💉 任意の組へ注入</h2>
          <div className="row">
            <select value={injectPair} onChange={(e) => setInjectPair(e.target.value)}>
              {view.pairs.map((p) => (
                <option key={p.pairId} value={p.pairId} disabled={!p.alive}>
                  {p.pairId}: {p.buddyName}
                  {p.alive ? '' : '(死亡)'}
                </option>
              ))}
            </select>
            <button onClick={() => setInjectSheet('advice')}>助言</button>
            <button onClick={() => setInjectSheet('trial')}>裁判選択</button>
            <button onClick={() => setInjectSheet('night')}>夜襲提案</button>
          </div>
          <div className="muted small">
            フェーズ外・回数超過などはゲーム本体が拒否します（エラー表示で確認できます）。
          </div>
        </div>

        <div className="card">
          <h2>📊 指標</h2>
          <div className="muted small">
            コール{data.metrics.aiCallCount} / 入力{data.metrics.inputTokens}tok / 出力
            {data.metrics.outputTokens}tok / ${data.metrics.costUsd.toFixed(4)} / AI待機
            {(data.metrics.aiWaitMs / 1000).toFixed(1)}s / エラー{data.metrics.errorCount} / JSON失敗
            {data.metrics.jsonErrorCount} / 代替処理 {data.metrics.fallbackCount}
          </div>
          <div className="row">
            <button className="ghost" onClick={() => void api.downloadRecord(matchId)}>JSON</button>
            <button className="ghost" onClick={() => void api.downloadCsv(matchId, 'evals')}>
              評価CSV
            </button>
            <button className="ghost" onClick={() => void api.downloadCsv(matchId, 'calls')}>
              コールCSV
            </button>
            <button className="ghost" onClick={() => (location.hash = `/match/${matchId}/replay`)}>
              リプレイ画面
            </button>
          </div>
        </div>

        <div className="card">
          <h2>🤖 AIコール履歴({calls.length})</h2>
          {calls
            .slice(-30)
            .reverse()
            .map((c) => (
              <details key={c.id}>
                <summary>
                  {c.id} — {c.provider}/{c.model} {c.latencyMs}ms in:{c.inputTokens} out:
                  {c.outputTokens} ${c.costUsd.toFixed(5)}
                  {c.usedFallback && ' ⚠️代替処理'}
                  {c.jsonErrors > 0 && ` JSONエラー${c.jsonErrors}`}
                  {!c.ok && ' ❌'}
                </summary>
                {c.error && <div className="errorbox small">{c.error}</div>}
                <h3>AIへ送った内容</h3>
                <pre className="json">{JSON.stringify(c.rawRequest, null, 1)}</pre>
                <h3>AIから返った内容</h3>
                <pre className="json">{JSON.stringify(c.rawResponse, null, 1)}</pre>
              </details>
            ))}
        </div>

        <div className="card">
          <h2>🧠 全内部状態</h2>
          <details>
            <summary>ゲーム全状態（進行役の視点）を表示</summary>
            <pre className="json">{JSON.stringify(data.gm, null, 1)}</pre>
          </details>
        </div>

        {error && <ErrorBox error={error} />}
      </div>

      {injectSheet === 'trial' && (
        <LabTargetSheet
          title={`裁判選択を注入(${injectPair})`}
          candidates={aliveOthers(injectPair)}
          onClose={() => setInjectSheet(null)}
          onSubmit={(t) =>
            run(async () => {
              await api.trialChoice(matchId, injectPair, t);
              setInjectSheet(null);
            })
          }
        />
      )}
      {injectSheet === 'night' && (
        <LabTargetSheet
          title={`夜襲提案を注入(${injectPair})`}
          candidates={aliveOthers(injectPair)}
          onClose={() => setInjectSheet(null)}
          onSubmit={(t) =>
            run(async () => {
              await api.nightProposal(matchId, injectPair, t);
              setInjectSheet(null);
            })
          }
        />
      )}
      {injectSheet === 'advice' && (
        <LabAdviceSheet
          pairId={injectPair}
          candidates={aliveOthers(injectPair)}
          onClose={() => setInjectSheet(null)}
          onSubmit={(a) =>
            run(async () => {
              await api.advice(matchId, injectPair, a);
              setInjectSheet(null);
            })
          }
        />
      )}
    </>
  );
}

function LabTargetSheet({
  title,
  candidates,
  onClose,
  onSubmit,
}: {
  title: string;
  candidates: { pairId: string; buddyName: string }[];
  onClose: () => void;
  onSubmit: (targetId: string | null) => void;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="optlist">
        {candidates.map((c) => (
          <button key={c.pairId} onClick={() => onSubmit(c.pairId)}>
            {c.buddyName}({c.pairId})
          </button>
        ))}
        <button onClick={() => onSubmit(null)}>提案なし</button>
      </div>
    </Sheet>
  );
}

function LabAdviceSheet({
  pairId,
  candidates,
  onClose,
  onSubmit,
}: {
  pairId: string;
  candidates: { pairId: string; buddyName: string }[];
  onClose: () => void;
  onSubmit: (advice: Advice) => void;
}) {
  const [themes, setThemes] = useState<{ id: string; label: string }[]>([]);
  const [directives, setDirectives] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    void api.config().then((c) => {
      setThemes(c.advice.questionThemes);
      setDirectives(c.advice.behaviorDirectives);
    });
  }, []);
  const [target, setTarget] = useState(candidates[0]?.pairId ?? '');
  return (
    <Sheet title={`助言を注入(${pairId})`} onClose={onClose}>
      <label className="field">
        対象
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {candidates.map((c) => (
            <option key={c.pairId} value={c.pairId}>
              {c.buddyName}({c.pairId})
            </option>
          ))}
        </select>
      </label>
      <div className="optlist">
        <button onClick={() => onSubmit({ kind: 'suspicion', targetId: target })}>
          主観的な疑い → 対象
        </button>
        {themes.map((t) => (
          <button
            key={t.id}
            onClick={() => onSubmit({ kind: 'question', targetId: target, themeId: t.id })}
          >
            質問: {t.label}
          </button>
        ))}
        <button onClick={() => onSubmit({ kind: 'skill_target', targetId: target })}>
          スキル対象の提案 → 対象(占い役のみ)
        </button>
        {directives.map((d) => (
          <button key={d.id} onClick={() => onSubmit({ kind: 'behavior', directiveId: d.id })}>
            立ち回り: {d.label}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
