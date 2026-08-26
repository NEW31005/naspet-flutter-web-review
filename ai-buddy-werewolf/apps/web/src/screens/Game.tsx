/** ゲーム画面(Play Test用・モバイル前提) */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicLogEntry } from '@aibw/game-core';
import { api, type Advice, type ViewResponse } from '../api.js';
import { ErrorBox, Sheet, Spinner, TopBar } from '../components.js';
import {
  nextPlayPace,
  normalizePlayPace,
  playPaceDelay,
  playPaceLabel,
  type PlayPace,
} from '../playPace.js';
import { providerLabel } from '../uiLabels.js';
import { isCompletedVoteMismatch } from '../voteComparison.js';

const PLAY_PACE_STORAGE_KEY = 'ai-buddy-werewolf:play-pace';

const PHASE_LABEL: Record<string, string> = {
  day_start: '朝',
  discussion: '討論',
  trial: '裁判',
  night: '夜',
  finished: '終了',
};

export function Game({ matchId }: { matchId: string }) {
  const [data, setData] = useState<ViewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playPace, setPlayPace] = useState<PlayPace>(() => {
    if (typeof window === 'undefined') return 'standard';
    return normalizePlayPace(window.localStorage.getItem(PLAY_PACE_STORAGE_KEY));
  });
  const [acting, setActing] = useState(false);
  const [sheet, setSheet] = useState<null | 'advice' | 'trial' | 'night'>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const asRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // 初回は視点不明のためまず素のビューを取り、humanPairIdで再取得する
      const res = await api.view(matchId, asRef.current);
      if (!asRef.current && res.view.humanPairId) {
        asRef.current = res.view.humanPairId;
        setData(await api.view(matchId, asRef.current));
      } else {
        setData(res);
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [matchId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (!acting) void refresh();
    }, 2500);
    return () => clearInterval(t);
  }, [refresh, acting]);

  const me = data?.view.me ?? null;
  const pending = data?.view.pending;
  const mustAct = !!me && (me.needTrialChoice || me.needNightProposal);
  const finished = pending?.type === 'finished';

  // 自動進行: AI処理/他主人の自動入力は進め、人間の入力が必要なら止める
  useEffect(() => {
    if (!data || acting || finished || data.busy || mustAct || sheet !== null) return;
    const isSpeechStep = data.view.phase === 'discussion' && pending?.type === 'ai_step';
    const delay = playPaceDelay(playPace, isSpeechStep);
    if (delay === null) return;
    const t = setTimeout(() => void doAdvance(), delay);
    return () => clearTimeout(t);
    // 依存を意図的に絞っている(dataの変化のみで駆動)
  }, [data, playPace, acting, finished, mustAct, sheet]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.view.publicLog.length]);

  const doAdvance = async () => {
    if (acting) return;
    setActing(true);
    try {
      await api.advance(matchId);
      await refresh();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setActing(false);
    }
  };

  const submit = async (fn: () => Promise<unknown>) => {
    setActing(true);
    try {
      await fn();
      setSheet(null);
      await refresh();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setActing(false);
    }
  };

  const cyclePlayPace = () => {
    setPlayPace((current) => {
      const next = nextPlayPace(current);
      window.localStorage.setItem(PLAY_PACE_STORAGE_KEY, next);
      return next;
    });
  };

  if (!data) {
    return (
      <>
        <TopBar title="読み込み中…" back="/" />
        <div className="page">{error ? <ErrorBox error={error} onRetry={refresh} /> : <Spinner />}</div>
      </>
    );
  }

  const view = data.view;
  const aliveOthers = view.pairs.filter((p) => p.alive && !p.isSelf);
  const lastComparison = me?.voteComparisons[me.voteComparisons.length - 1];
  const lastWolfReport = me?.wolfReports[me.wolfReports.length - 1];

  return (
    <>
      <TopBar
        title={`${view.day}日目 / ${PHASE_LABEL[view.phase] ?? view.phase}(最大${view.maxDays}日)`}
        back="/"
        right={
          <span className="row" style={{ gap: 6 }}>
            {(data.busy || acting) && <Spinner />}
            <span className="badge">{providerLabel(view.provider)}</span>
          </span>
        }
      />
      <div className="page">
        {/* 生存者 */}
        <div className="pairstrip">
          {view.pairs.map((p) => (
            <div
              key={p.pairId}
              className={`pairchip ${p.alive ? '' : 'dead'} ${p.isSelf ? 'self' : ''}`}
            >
              <span className="face">{p.alive ? '🧑' : p.deathCause === 'attack' ? '🩸' : '⚰️'}</span>
              <span>{p.buddyName}</span>
            </div>
          ))}
        </div>

        {/* 自分だけの情報 */}
        {me && (
          <div className="card">
            <div className="row spread">
              <div className="row">
                <strong>{me.buddyName}</strong>
                <span className={`badge ${me.team === 'wolves' ? 'wolf' : 'citizen'}`}>
                  {me.roleLabel}
                </span>
              </div>
              <span className="muted small">
                助言 {me.adviceUsedToday}/{me.advicePerDay} 使用
              </span>
            </div>
            {me.wolfPartners.length > 0 && (
              <div className="muted small">🐺 仲間の狼: {me.wolfPartners.map((w) => w.name).join('、')}</div>
            )}
            {me.facts.map((f) => (
              <div key={f.id} className="factbox">
                🔮 {f.day === 0 ? '初日の占い' : `${f.day}日目の占い`}: <strong>{f.targetName}</strong> は
                {f.isWolf ? ' 狼憑き' : ' 狼憑きではない'}
                {f.shared ? (
                  <span className="badge ok" style={{ marginLeft: 6 }}>
                    共有済み
                  </span>
                ) : (
                  <span className="badge warn" style={{ marginLeft: 6 }}>
                    あなただけが知っている
                  </span>
                )}
              </div>
            ))}
            {lastComparison && (
              <div className="muted small">
                ⚖️ {lastComparison.day}日目の裁判 — あなた:{' '}
                {lastComparison.myChoiceName ?? '(選択なし)'} / バディの投票:{' '}
                {lastComparison.buddyVoteName ?? '—'}
                {lastComparison.buddyVoteId != null &&
                  (isCompletedVoteMismatch(
                    lastComparison.myChoiceId,
                    lastComparison.buddyVoteId,
                  ) ? (
                    <span className="badge warn" style={{ marginLeft: 6 }}>
                      バディは別の判断
                    </span>
                  ) : (
                    <span className="badge ok" style={{ marginLeft: 6 }}>
                      意見が一致
                    </span>
                  ))}
              </div>
            )}
            {lastWolfReport && (
              <div className="muted small">
                🌙 {lastWolfReport.day}日目の襲撃 — 提案: {lastWolfReport.proposalName ?? 'なし'} /
                バディ第一候補: {lastWolfReport.buddyTopName ?? '—'} / 最終:{' '}
                <strong>{lastWolfReport.finalName ?? '—'}</strong>
              </div>
            )}
          </div>
        )}

        {/* 公開ログ */}
        <div className="chatlog">
          {view.publicLog.map((e, i) => (
            <LogEntry key={`${e.seq}-${i}`} entry={e} selfPairId={me?.pairId ?? null} />
          ))}
          {(data.busy || acting) && !finished && (
            <div className="sysline">
              <Spinner label="AIが考えています…" />
            </div>
          )}
          <div ref={logEndRef} />
        </div>

        {mustAct && (
          <div className="notice">
            {me?.needTrialChoice
              ? '討論はここで一時停止中。内容を読み返してから、下の「処刑先を選ぶ」を押してください。'
              : '夜の行動前で一時停止中。内容を確認してから、下の「襲撃を提案する」を押してください。'}
          </div>
        )}

        {finished && (
          <div className="card">
            <h2>試合終了</h2>
            <p>
              {view.winner === 'citizens'
                ? '☀️ 市民陣営の勝利'
                : view.winner === 'wolves'
                  ? '🐺 狼陣営の勝利'
                  : '引き分け'}{' '}
              — {view.finishReason}
            </p>
            <button className="primary" onClick={() => (location.hash = `/match/${matchId}/result`)}>
              結果を見る
            </button>
          </div>
        )}

        {error && <ErrorBox error={error} onRetry={doAdvance} />}
      </div>

      {/* 下部操作バー */}
      {!finished && (
        <div className="actionbar">
          {me && view.phase === 'discussion' && (
            <button
              className={me.canAdvise ? 'primary' : ''}
              disabled={!me.canAdvise}
              onClick={() => setSheet('advice')}
            >
              🗣 助言 {me.canAdvise ? '' : '(使用済み)'}
            </button>
          )}
          {me?.needTrialChoice && (
            <button className="primary" onClick={() => setSheet('trial')}>
              ⚖️ 処刑先を選ぶ
            </button>
          )}
          {me?.needNightProposal && (
            <button className="primary" onClick={() => setSheet('night')}>
              🌙 襲撃を提案する
            </button>
          )}
          {!mustAct && (
            <button onClick={doAdvance} disabled={acting || data.busy}>
              ▶ 進める
            </button>
          )}
          <button
            className={playPace === 'manual' ? '' : 'ghost'}
            onClick={cyclePlayPace}
            title="押すたびに再生速度を変更"
          >
            ⏱ {playPaceLabel(playPace)}
          </button>
        </div>
      )}

      {/* 助言シート */}
      {sheet === 'advice' && me && (
        <AdviceSheet
          matchId={matchId}
          me={me}
          aliveOthers={aliveOthers}
          onClose={() => setSheet(null)}
          onSubmit={(advice) => submit(() => api.advice(matchId, me.pairId, advice))}
        />
      )}

      {/* 裁判シート */}
      {sheet === 'trial' && me && (
        <TargetSheet
          title="⚖️ 裁判 — あなたなら誰を処刑する?"
          description="これは直接の一票ではなく、バディへの最後の意思表示。最終投票はバディ自身が決める。この場で新しい確定情報は共有できない。"
          candidates={aliveOthers}
          onClose={() => setSheet(null)}
          onSubmit={(targetId) => submit(() => api.trialChoice(matchId, me.pairId, targetId))}
        />
      )}

      {/* 夜襲提案シート */}
      {sheet === 'night' && me && (
        <TargetSheet
          title="🌙 夜 — 襲撃すべき相手を提案"
          description="提案は主人との親密度に応じて狼バディの評価へ加算される。最終襲撃先は狼バディたち(複数いる場合は統合)が決める。"
          candidates={aliveOthers.filter(
            (p) => !me.wolfPartners.some((w) => w.pairId === p.pairId),
          )}
          onClose={() => setSheet(null)}
          onSubmit={(targetId) => submit(() => api.nightProposal(matchId, me.pairId, targetId))}
        />
      )}
    </>
  );
}

function LogEntry({ entry, selfPairId }: { entry: PublicLogEntry; selfPairId: string | null }) {
  switch (entry.t) {
    case 'day_start':
      return (
        <div className="sysline strong">
          ☀️ {entry.day}日目の朝
          {entry.deaths.length > 0 && (
            <div>🩸 昨夜、{entry.deaths.map((d) => d.name).join('と')}が襲撃された</div>
          )}
        </div>
      );
    case 'phase':
      if (entry.phase === 'trial') return <div className="sysline strong">⚖️ {entry.day}日目の裁判</div>;
      if (entry.phase === 'night') return <div className="sysline strong">🌙 夜が訪れた</div>;
      if (entry.phase === 'discussion') return <div className="sysline">💬 討論開始</div>;
      return null;
    case 'speech': {
      const self = entry.pairId === selfPairId;
      return (
        <div className={`bubble ${self ? 'self' : ''}`}>
          <div className="who">
            {entry.name}
            {self ? '(あなたのバディ)' : ''}
          </div>
          <div>{entry.text}</div>
        </div>
      );
    }
    case 'vote':
      return (
        <div className="sysline">
          🗳 {entry.name} → {entry.targetName}
        </div>
      );
    case 'execution':
      return (
        <div className="sysline strong">
          ⚰️ {entry.targetName ?? '(なし)'}が処刑された{entry.tie ? '(同票のため抽選)' : ''}
        </div>
      );
    case 'finish':
      return (
        <div className="sysline strong">
          🏁 試合終了 —{' '}
          {entry.winner === 'citizens' ? '市民勝利' : entry.winner === 'wolves' ? '狼勝利' : '引分'}
        </div>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// シート部品
// ---------------------------------------------------------------------------

interface PairOption {
  pairId: string;
  buddyName: string;
}

function TargetSheet({
  title,
  description,
  candidates,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  candidates: PairOption[];
  onClose: () => void;
  onSubmit: (targetId: string) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  return (
    <Sheet title={title} onClose={onClose}>
      <p className="muted small">{description}</p>
      <div className="optlist">
        {candidates.map((c) => (
          <button
            key={c.pairId}
            className={target === c.pairId ? 'selected' : ''}
            onClick={() => setTarget(c.pairId)}
          >
            {c.buddyName}
          </button>
        ))}
      </div>
      <button className="primary" disabled={!target} onClick={() => target && onSubmit(target)}>
        決定
      </button>
    </Sheet>
  );
}

type Me = NonNullable<ViewResponse['view']['me']>;

function AdviceSheet({
  me,
  aliveOthers,
  onClose,
  onSubmit,
}: {
  matchId: string;
  me: Me;
  aliveOthers: PairOption[];
  onClose: () => void;
  onSubmit: (advice: Advice) => void;
}) {
  const [menu, setMenu] = useState<
    { kind: string; label: string; description: string; enabled: boolean }[]
  >([]);
  const [themes, setThemes] = useState<{ id: string; label: string }[]>([]);
  const [directives, setDirectives] = useState<{ id: string; label: string }[]>([]);
  const [kind, setKind] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [themeId, setThemeId] = useState<string | null>(null);
  const [directiveId, setDirectiveId] = useState<string | null>(null);
  const [factId, setFactId] = useState<string | null>(null);

  useEffect(() => {
    void api.config().then((c) => {
      setMenu(c.advice.menu);
      setThemes(c.advice.questionThemes);
      setDirectives(c.advice.behaviorDirectives);
    });
  }, []);

  const unsharedFacts = me.facts.filter((f) => !f.shared);
  const availableMenu = menu.filter((m) => {
    if (!m.enabled) return false;
    if (m.kind === 'fact_share') return unsharedFacts.length > 0;
    if (m.kind === 'skill_target') return me.role === 'seer';
    return true;
  });

  const needsTarget = kind === 'suspicion' || kind === 'question' || kind === 'skill_target';
  const canSubmit =
    (kind === 'suspicion' && target) ||
    (kind === 'question' && target && themeId) ||
    (kind === 'fact_share' && factId) ||
    (kind === 'skill_target' && target) ||
    (kind === 'behavior' && directiveId);

  const buildAdvice = (): Advice | null => {
    if (kind === 'suspicion' && target) return { kind: 'suspicion', targetId: target };
    if (kind === 'question' && target && themeId)
      return { kind: 'question', targetId: target, themeId };
    if (kind === 'fact_share' && factId) return { kind: 'fact_share', factId };
    if (kind === 'skill_target' && target) return { kind: 'skill_target', targetId: target };
    if (kind === 'behavior' && directiveId) return { kind: 'behavior', directiveId };
    return null;
  };

  return (
    <Sheet title="🗣 バディへの助言(本日残り1回)" onClose={onClose}>
      {!kind && (
        <div className="optlist">
          {availableMenu.map((m) => (
            <button key={m.kind} onClick={() => setKind(m.kind)}>
              {m.label}
              <span className="sub">{m.description}</span>
            </button>
          ))}
        </div>
      )}
      {kind && (
        <>
          <div className="row spread">
            <span className="badge accent">{menu.find((m) => m.kind === kind)?.label}</span>
            <button className="ghost small" onClick={() => setKind(null)}>
              種類を選び直す
            </button>
          </div>
          {needsTarget && (
            <div className="optlist">
              {aliveOthers.map((c) => (
                <button
                  key={c.pairId}
                  className={target === c.pairId ? 'selected' : ''}
                  onClick={() => setTarget(c.pairId)}
                >
                  {c.buddyName}
                </button>
              ))}
            </div>
          )}
          {kind === 'question' && (
            <label className="field">
              質問テーマ
              <select value={themeId ?? ''} onChange={(e) => setThemeId(e.target.value || null)}>
                <option value="">選択してください</option>
                {themes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === 'fact_share' && (
            <div className="optlist">
              {unsharedFacts.map((f) => (
                <button
                  key={f.id}
                  className={factId === f.id ? 'selected' : ''}
                  onClick={() => setFactId(f.id)}
                >
                  {f.day}日目の占い: {f.targetName}は{f.isWolf ? '狼憑き' : '狼憑きではない'}
                  <span className="sub">共有すると事実としてバディに登録される</span>
                </button>
              ))}
            </div>
          )}
          {kind === 'behavior' && (
            <div className="optlist">
              {directives.map((d) => (
                <button
                  key={d.id}
                  className={directiveId === d.id ? 'selected' : ''}
                  onClick={() => setDirectiveId(d.id)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}
          <button
            className="primary"
            disabled={!canSubmit}
            onClick={() => {
              const advice = buildAdvice();
              if (advice) onSubmit(advice);
            }}
          >
            この助言を送る
          </button>
          <p className="muted small">
            親密度 {me.abilities.trust}/100。高いほど、バディは自分と異なる考えでも主人の意見を優先する。確定情報との矛盾や大きな評価差がある場合は、自分の判断を選ぶこともある。
          </p>
        </>
      )}
    </Sheet>
  );
}
