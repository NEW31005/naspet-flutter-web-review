/**
 * プロンプト組み立て。
 * BuddyContext(可視情報のみ)からLive AI用のプロンプトを生成する。
 * ここに GameState を渡してはならない(秘密情報分離の境界)。
 *
 * 分離方針:
 * - 評価プロンプト: 判断専用。人格・口調は含めない。
 * - 発言プロンプト: 表現専用。人格・口調・虚言力(狼のみ)を含める。
 */
import type { EvalOutput } from '@aibw/shared';
import type { BuddyContext, PublicLogEntry } from '@aibw/game-core';
import type { PromptSet } from './provider.js';

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

function renderLogEntry(e: PublicLogEntry): string {
  switch (e.t) {
    case 'day_start': {
      const deaths =
        e.deaths.length > 0
          ? ` 昨夜、${e.deaths.map((d) => d.name).join('と')}が襲撃されて死亡した。`
          : '';
      return `--- ${e.day}日目の朝 ---${deaths}`;
    }
    case 'phase':
      if (e.phase === 'discussion') return `(討論開始)`;
      if (e.phase === 'trial') return `--- ${e.day}日目の裁判 ---`;
      if (e.phase === 'night') return `--- ${e.day}日目の夜 ---`;
      return '';
    case 'discussion_stage':
      if (e.stage === 'advice') return '--- 主人からバディへの相談時間 ---';
      if (e.stage === 'response') return '--- 相談後の応答討論 ---';
      return '';
    case 'speech':
      return `${e.name}: ${e.text}`;
    case 'vote':
      return `[投票] ${e.name} → ${e.targetName}`;
    case 'execution':
      return e.targetId
        ? `[処刑] ${e.targetName}が処刑された${e.tie ? '(同票のため抽選)' : ''}${e.revealedRole ? `(役職: ${e.revealedRole})` : ''}`
        : '[処刑] 処刑は行われなかった';
    case 'finish':
      return `[終了] 勝者: ${e.winner} (${e.reason})`;
  }
}

export function renderPublicLog(log: PublicLogEntry[], limit?: number): string {
  const entries = limit ? log.slice(-limit) : log;
  const lines = entries.map(renderLogEntry).filter((s) => s.length > 0);
  return lines.length > 0 ? lines.join('\n') : '(まだ公開ログはありません)';
}

function roleBlock(ctx: BuddyContext, prompts: PromptSet): string {
  const role = ctx.self.role;
  if (role === 'werewolf') {
    return fill(prompts.roleWerewolf, {
      wolfPartners:
        ctx.wolfPartners.length > 0
          ? ctx.wolfPartners.map((w) => `${w.name}(${w.pairId})`).join('、')
          : 'いない(単独)',
      deception: String(ctx.self.abilities.deception),
      deceptionUnlocksBlock: ctx.self.unlockedDeception
        .map((u) => `- ${u.label}: ${u.promptHint}`)
        .join('\n'),
    });
  }
  if (role === 'seer') return prompts.roleSeer;
  return prompts.roleVillager;
}

function factsBlock(ctx: BuddyContext): string {
  if (ctx.sharedFacts.length === 0) {
    return '- 主人から共有された確定情報: なし';
  }
  const nameOf = (id: string) =>
    ctx.participants.find((p) => p.pairId === id)?.name ?? id;
  return (
    '- 主人から共有された確定情報(ゲームシステムが保証する事実。疑ってはならない):\n' +
    ctx.sharedFacts
      .map(
        (f) =>
          `  - ${f.day}日目の占い: ${nameOf(f.targetId)}(${f.targetId})は${f.isWolf ? '狼憑きである' : '狼憑きではない'}`,
      )
      .join('\n')
  );
}

function advicesBlock(ctx: BuddyContext): string {
  const nameOf = (id: string) =>
    ctx.participants.find((p) => p.pairId === id)?.name ?? id;
  const lines: string[] = [];
  for (const a of ctx.advices) {
    const ad = a.advice;
    switch (ad.kind) {
      case 'suspicion':
        lines.push(
          `  - [${a.day}日目/主観] 主人は「${nameOf(ad.targetId)}(${ad.targetId})が怪しい」と考えている(確定情報ではない。信頼度に応じて判断材料にする)`,
        );
        break;
      case 'question':
        lines.push(`  - [${a.day}日目/質問指示] ${nameOf(ad.targetId)}へ質問してほしい`);
        break;
      case 'skill_target':
        lines.push(
          `  - [${a.day}日目/提案] 次のスキル対象として${nameOf(ad.targetId)}(${ad.targetId})を提案された(最終決定はあなた)`,
        );
        break;
      case 'behavior':
        lines.push(`  - [${a.day}日目/立ち回り] ${ad.directiveId}`);
        break;
      case 'fact_share':
        break; // factsBlockで表示済み
    }
  }
  if (lines.length === 0) return '- 主人からの助言: まだない';
  return '- 主人からの助言:\n' + lines.join('\n');
}

export function buildEvalPrompt(
  ctx: BuddyContext,
  prompts: PromptSet,
): { system: string; user: string } {
  const alive = ctx.participants.filter((p) => p.alive);
  const dead = ctx.participants.filter((p) => !p.alive);
  const system =
    fill(prompts.systemBase, {
      buddyName: ctx.self.buddyName,
      masterName: ctx.self.masterName,
      pairCount: String(ctx.participants.length),
      maxDays: String(ctx.matchInfo.maxDays),
      trust: String(ctx.self.abilities.trust),
    }) +
    '\n\n' +
    roleBlock(ctx, prompts);

  const user = fill(prompts.evalTemplate, {
    day: String(ctx.matchInfo.day),
    phase: ctx.matchInfo.phase,
    maxDays: String(ctx.matchInfo.maxDays),
    aliveList: alive.map((p) => `${p.name}(${p.pairId})`).join('、'),
    deadList:
      dead.length > 0
        ? dead
            .map((p) => `${p.name}(${p.deathDay}日目に${p.deathCause === 'attack' ? '襲撃' : '処刑'})`)
            .join('、')
        : 'なし',
    roleLabel: ctx.self.roleLabel,
    roleBlock: '',
    factsBlock: factsBlock(ctx),
    advicesBlock: advicesBlock(ctx),
    reasoning: String(ctx.self.abilities.reasoning),
    reasoningUnlocksBlock: ctx.self.unlockedReasoning
      .map((u) => `- ${u.label}: ${u.promptHint}`)
      .join('\n'),
    publicLogBlock: renderPublicLog(ctx.publicLog),
    previousEvalBlock: ctx.previousEval
      ? JSON.stringify(
          {
            suspicions: ctx.previousEval.suspicions,
            primaryHypothesis: ctx.previousEval.primaryHypothesis,
            confidence: ctx.previousEval.confidence,
          },
          null,
          0,
        )
      : '(初回のためなし)',
    candidateIds: ctx.candidates.map((c) => `${c.pairId}=${c.name}`).join(', '),
    attackPrioritiesHint:
      ctx.self.role === 'werewolf'
        ? 'attackPriorities: 夜に襲撃したい優先度0-100(仲間の狼は含めない)。'
        : 'attackPriorities: あなたは狼ではないため空配列でよい。',
    skillPrioritiesHint:
      ctx.self.role === 'seer'
        ? 'skillTargetPriorities: 次の夜に占いたい優先度0-100。'
        : 'skillTargetPriorities: あなたは占い役ではないため空配列でよい。',
  });
  return { system, user };
}

export function buildSpeechPrompt(
  ctx: BuddyContext,
  ev: EvalOutput,
  prompts: PromptSet,
): { system: string; user: string } {
  const nameOf = (id: string | null) =>
    id ? (ctx.participants.find((p) => p.pairId === id)?.name ?? id) : 'なし';
  const persona = ctx.self.persona;
  const system =
    fill(prompts.systemBase, {
      buddyName: ctx.self.buddyName,
      masterName: ctx.self.masterName,
      pairCount: String(ctx.participants.length),
      maxDays: String(ctx.matchInfo.maxDays),
      trust: String(ctx.self.abilities.trust),
    }) +
    '\n\n' +
    roleBlock(ctx, prompts);

  const verbosityHints = {
    short: '1〜2文の短い発言',
    medium: '2〜4文程度',
    long: '4〜6文程度のよく喋る発言',
  } as const;

  const user = fill(prompts.speechTemplate, {
    buddyName: persona.name,
    firstPerson: persona.firstPerson,
    masterCall: persona.masterCall,
    look: persona.look,
    personality: persona.personality,
    speechStyle: persona.speechStyle,
    emotion: persona.emotion,
    archetype: persona.archetype,
    verbosityHint: verbosityHints[persona.verbosity],
    primaryHypothesis: ev.primaryHypothesis,
    voteCandidateName: nameOf(ev.voteCandidateId),
    toShare: ev.toShare.join(' / ') || 'なし',
    toWithhold: ev.toWithhold.join(' / ') || 'なし',
    questionPlan: ev.questionTargetId
      ? `${nameOf(ev.questionTargetId)} / ${ev.questionTheme ?? ''}`
      : 'なし',
    deceptionBlock:
      ctx.self.role === 'werewolf'
        ? '# 注意\nあなたは狼憑きだが、市民のふりをして発言する。使える騙しの技術はシステムプロンプトのリストに限る。'
        : '',
    directiveBlock: buildDirectiveBlock(ctx),
    recentLogBlock: renderPublicLog(ctx.publicLog, 20),
    lengthLimit: verbosityHints[persona.verbosity],
    candidateIds: ctx.candidates.map((c) => `${c.pairId}=${c.name}`).join(', '),
  });
  return { system, user };
}

function buildDirectiveBlock(ctx: BuddyContext): string {
  const parts: string[] = [];
  const turn = ctx.discussionTurn;
  if (turn?.kind === 'opening') {
    parts.push(
      '# 今回の会話役割\nこれは冒頭討論。現時点の仮説と根拠を1つ出し、後の相手が反応できる論点を残す。',
    );
  } else if (turn?.kind === 'question' && turn.targetName && turn.theme) {
    parts.push(
      `# 今回の会話役割: 指名質問\n${turn.targetName}へ「${turn.theme.label}」を尋ねる。質問を1つに絞り、相手が答えられる短い聞き方にする。別の相手へ話題を広げない。`,
    );
  } else if (turn?.kind === 'answer' && turn.askerName && turn.theme) {
    parts.push(
      `# 今回の会話役割: 単独回答\n${turn.askerName}から「${turn.theme.label}」を聞かれている。まずその問いだけに具体的に答える。新しい質問や別の論点は追加しない。役職上の欺瞞は許されるが、公開ログにない出来事は作らない。`,
    );
  } else if (turn?.kind === 'follow_up' && turn.targetName) {
    parts.push(
      `# 今回の会話役割: 返答の受け止め\n${turn.targetName}の直前の回答を具体的に取り上げ、納得した点か残った矛盾を1つだけ述べる。`,
    );
  } else if (turn?.kind === 'reaction') {
    parts.push(
      '# 今回の会話役割: 応答討論\n冒頭討論または直前の質疑から具体的な発言を1つ取り上げ、賛成・反論・評価更新のいずれかを示す。',
    );
  }
  if (ctx.pendingQuestion) {
    parts.push(
      `# 主人からの質問指示\n主人は「${ctx.pendingQuestion.targetName}に${ctx.pendingQuestion.theme.label}を聞いてほしい」と言っている(${ctx.pendingQuestion.theme.promptHint})。この発言の中で、あなたの口調で自然に質問すること。`,
    );
  }
  if (ctx.behaviorDirective) {
    parts.push(
      `# 主人からの立ち回り提案\n「${ctx.behaviorDirective.label}」(${ctx.behaviorDirective.promptHint})。命令ではないが、信頼度に応じて発言の姿勢へ反映する。`,
    );
  }
  return parts.join('\n\n');
}
