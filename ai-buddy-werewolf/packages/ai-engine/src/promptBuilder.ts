/**
 * プロンプト組み立て。
 * BuddyContext(可視情報のみ)からLive AI用のプロンプトを生成する。
 * ここに GameState を渡してはならない(秘密情報分離の境界)。
 *
 * 分離方針:
 * - 評価プロンプト: 判断専用。人格・口調は含めない。
 * - 発言プロンプト: 表現専用。人格・口調・虚言力(狼のみ)を含める。
 */
import { ROLE_LABEL, type EvalOutput } from '@aibw/shared';
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
          : e.day > 1
            ? ' 昨夜の犠牲者はいなかった。'
            : '';
      return `--- ${e.day}日目の朝 ---${deaths}`;
    }
    case 'phase':
      if (e.phase === 'discussion') return `(討論開始)`;
      if (e.phase === 'trial') return `--- ${e.day}日目の裁判 ---`;
      if (e.phase === 'night') return `--- ${e.day}日目の夜 ---`;
      return '';
    case 'discussion_focus':
      return `[初日の討論対象] ${e.pairs.map((pair) => pair.name).join('、')}。シード付き抽選で選ばれただけで、狼の証拠ではない。`;
    case 'discussion_stage':
      if (e.stage === 'advice') return '--- 主人からバディへの相談時間 ---';
      if (e.stage === 'response') return '--- 相談後の応答討論 ---';
      return '';
    case 'discussion_closed':
      return e.reason === 'time_up'
        ? '--- 討論時間終了 ---'
        : '--- 発言上限により討論終了 ---';
    case 'speech':
      return `${e.name}: ${e.text}`;
    case 'role_declared':
      return `[役職の名乗り] ${e.name}は「${ROLE_LABEL[e.claimedRole]}」として名乗り出た。本当の役職かどうかは公開されていない。`;
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

/**
 * 評価コール向けの圧縮ログ。
 * 投票・処刑・死亡など後から覆らない公開事実は残しつつ、会話だけを直近へ絞る。
 * 前回評価の短い要約も別枠で渡すため、推論材料を保ったまま入力の二次増加を防ぐ。
 */
export function renderEvalPublicLog(log: PublicLogEntry[], speechLimit = 24): string {
  const recentSpeeches = new Set(
    log.filter((entry) => entry.t === 'speech').slice(-speechLimit),
  );
  return renderPublicLog(
    log.filter((entry) => entry.t !== 'speech' || recentSpeeches.has(entry)),
  );
}

export function renderQuestionThemes(
  themes: BuddyContext['questionThemes'],
): string {
  return themes.length > 0
    ? themes.map((theme) => `- ${theme.id}: ${theme.label}`).join('\n')
    : '- 利用可能な質問テーマなし';
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
  if (role === 'guardian') {
    return prompts.roleGuardian ?? [
      '# あなたの役職: 騎士',
      '夜に生存者を1人護衛する。自分自身と前夜と同じ相手は護衛できない。',
      '主人の対象提案は判断材料だが、最終対象は自分で決める。役職と護衛先は公開情報ではない。',
    ].join('\n');
  }
  if (role === 'medium') {
    return prompts.roleMedium ?? [
      '# あなたの役職: 霊媒師',
      '処刑された相手が狼憑きかどうかを主人が知る。主人から共有された結果だけを確定情報として扱う。',
      '役職をいつ公開するかは盤面を見て判断する。',
    ].join('\n');
  }
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
      .map((f) => {
        const source = f.source === 'medium' ? '霊媒' : '占い';
        return `  - ${f.day}日目の${source}: ${nameOf(f.targetId)}(${f.targetId})は${f.isWolf ? '狼憑きである' : '狼憑きではない'}`;
      })
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
      case 'role_claim':
        lines.push(
          ad.claimedRole === null
            ? `  - [${a.day}日目/役職の名乗り方] 主人は今日はまだ役職を名乗らないでほしいと考えている`
            : `  - [${a.day}日目/役職の名乗り方] 主人は${ROLE_LABEL[ad.claimedRole]}として名乗ってほしいと考えている（本当の役職と異なる場合もある。最終判断はあなた）`,
        );
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
  const analysisLens = ctx.matchInfo.phase === 'night'
    ? '夜フェーズでは討論の観察担当を置かず、役職ごとの夜行動優先度だけを評価する。'
    : selectAnalysisLens(ctx);
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
    publicLogBlock: renderEvalPublicLog(ctx.publicLog),
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
    analysisLensBlock: analysisLens,
    questionThemesBlock: renderQuestionThemes(ctx.questionThemes),
    candidateIds: ctx.candidates.map((c) => `${c.pairId}=${c.name}`).join(', '),
    attackPrioritiesHint:
      ctx.self.role === 'werewolf'
        ? 'attackPriorities: 次の夜に襲撃したい優先度0-100(仲間の狼は含めない)。夜の主人提案にも使うため討論・裁判でも更新する。'
        : 'attackPriorities: あなたは狼憑きではないため空配列。',
    skillPrioritiesHint:
      ctx.matchInfo.phase === 'night' && ctx.self.role === 'seer'
        ? 'skillTargetPriorities: 次の夜に占いたい優先度0-100。'
        : ctx.matchInfo.phase === 'night' && ctx.self.role === 'guardian'
          ? `skillTargetPriorities: 今夜護衛したい優先度0-100。自分自身${ctx.lastGuardTarget ? `と前夜の護衛先${ctx.lastGuardTarget.name}(${ctx.lastGuardTarget.pairId})` : ''}は候補に含めない。`
          : 'skillTargetPriorities: 討論・裁判では評価し直さず空配列。夜フェーズの占い師・騎士だけが記入する。',
  }) + (ctx.discussionFocus.length > 0
    ? `\n\n# 初日の討論対象\n${ctx.discussionFocus.map((pair) => `${pair.name}(${pair.pairId})`).join('、')}。抽選で選ばれただけなので、その事実自体を狼の根拠にしてはならない。弁明内容と他者の反応を評価すること。`
    : '');
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
  const analysisLens = selectAnalysisLens(ctx);
  const themeLabel = (id: string | null) =>
    id ? (ctx.questionThemes.find((theme) => theme.id === id)?.label ?? '質問内容') : '';
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
    short: '1文、34文字以内を目安にする',
    medium: '1〜2文、44文字以内を目安にする',
    long: '1〜2文、52文字以内を目安にする',
  } as const;
  const turnKind = ctx.discussionTurn?.kind;
  const lengthHint =
    ctx.pendingQuestion || turnKind === 'question'
      ? '質問だけを1文、36文字以内にする'
      : turnKind === 'answer'
        ? '聞かれたことへの答えだけを1文、40文字以内にする'
        : turnKind === 'follow_up'
          ? '回答への判断だけを1〜2文、46文字以内にする'
          : ctx.roleClaimProposal?.day === ctx.matchInfo.day
            ? '役職を名乗る場合も1文、48文字以内にする'
            : verbosityHints[persona.verbosity];

  const renderedTemplate = fill(prompts.speechTemplate, {
    buddyName: persona.name,
    firstPerson: persona.firstPerson,
    masterCall: persona.masterCall,
    look: persona.look,
    personality: persona.personality,
    speechStyle: persona.speechStyle,
    emotion: persona.emotion,
    archetype: persona.archetype,
    verbosityHint: lengthHint,
    primaryHypothesis: ev.primaryHypothesis,
    voteCandidateName: nameOf(ev.voteCandidateId),
    toShare: ev.toShare.join(' / ') || 'なし',
    toWithhold: ev.toWithhold.join(' / ') || 'なし',
    questionPlan: ev.questionTargetId
      ? `${nameOf(ev.questionTargetId)} / ${themeLabel(ev.questionTheme)}`
      : 'なし',
    deceptionBlock:
      ctx.self.role === 'werewolf'
        ? '# 注意\nあなたは狼憑きだが、市民のふりをして発言する。使える騙しの技術はシステムプロンプトのリストに限る。'
        : '',
    directiveBlock: buildDirectiveBlock(ctx),
    roleClaimBlock: buildRoleClaimBlock(ctx),
    analysisLensBlock: analysisLens,
    echoGuardBlock: buildEchoGuard(ctx),
    recentLogBlock: renderPublicLog(ctx.publicLog, 20),
    lengthLimit: `${lengthHint}。絶対に60文字を超えない`,
    candidateIds: ctx.candidates.map((c) => `${c.pairId}=${c.name}`).join(', '),
  });
  // 公開Labは利用者が編集した旧プロンプトをlocalStorageへ保持する。
  // 速度と用語の契約だけはテンプレート外にも置き、旧設定のままでも長文化させない。
  const user = `${renderedTemplate}\n\n# 公開発言の固定契約
- 日本語60文字以下、原則1〜2文。最初の15文字ほどで結論・直接回答・質問を出す。
- 1発言1論点、公開根拠は1つ。挨拶・内容のない相づち・儀礼的な共感・礼儀だけの前置き・自己説明・今後の抱負は削る。判断が変わった理由になる同意や納得は残す。
- 人格は一人称・相手への敬称・最後の語尾のうち1〜2個で残す。専門用語のCO・白・黒・盤面・吊る・ロラ・ライン・視点漏れ・身内切り・村目・狼目・グレー・縄・精査・囲いは普通の日本語へ置き換える。`;
  return { system, user };
}

interface AnalysisLens {
  minReasoning: number;
  prompt: string;
  dayTwoOnly?: boolean;
}

const ANALYSIS_LENSES: readonly AnalysisLens[] = [
  {
    minReasoning: 0,
    prompt: '質問へ正面から答えたか、聞かれていない話へ逃げたかを見る。答えているならその点は認める。',
  },
  {
    minReasoning: 0,
    prompt: '二人以上の主張を比べ、同じ点ではなく違いを1つ拾う。弱い側を機械的に疑わない。',
  },
  {
    minReasoning: 10,
    prompt: '同じ日の前の発言、または前日までの発言・投票と今の主張が整合するかを見る。',
  },
  {
    minReasoning: 20,
    prompt: '誰かへの同意が出たタイミングと、その同意に新しい根拠が加わったかを見る。単なる便乗と妥当な同意を区別する。',
  },
  {
    minReasoning: 30,
    prompt: 'なぜその相手を「このタイミングで」疑い始めたのかを見る。直前の流れで得をする疑い先変更か、自然な更新かを比べる。',
  },
  {
    minReasoning: 30,
    prompt: '多数派の疑いに対する市民側の反対仮説を1つ置き、白く見える点または見落としを探す。',
  },
  {
    minReasoning: 10,
    dayTwoOnly: true,
    prompt: '前日の投票先と現在の疑い先が一致するか、変わったなら説明があるかを見る。',
  },
  {
    minReasoning: 50,
    prompt: '誰が誰を庇い、誰と距離を取ったかを見る。ただし自然な反論まで仲間扱いしない。',
  },
  {
    minReasoning: 60,
    prompt: '強すぎない仲間疑いによる身内切りの可能性と、本気の対立を比較する。',
  },
  {
    minReasoning: 70,
    prompt: '議論の焦点を動かした人と、その移動で得をする人を見る。印象だけで誘導と断定しない。',
  },
];

function selectAnalysisLens(ctx: BuddyContext): string {
  const reasoning = ctx.self.abilities.reasoning;
  const eligible = ANALYSIS_LENSES.filter(
    (lens) => lens.minReasoning <= reasoning && (!lens.dayTwoOnly || ctx.matchInfo.day > 1),
  );
  const speechCount = ctx.publicLog.filter((entry) => entry.t === 'speech').length;
  const pairIndex = Math.max(
    0,
    ctx.participants.findIndex((participant) => participant.pairId === ctx.self.pairId),
  );
  const selected = eligible[
    (pairIndex + speechCount + ctx.matchInfo.day * 3 + ctx.matchInfo.analysisLensRotation) %
      eligible.length
  ];
  return selected
    ? selected.prompt
    : '直近の発言へ短く反応し、公開情報のない疑いは作らない。';
}

function buildEchoGuard(ctx: BuddyContext): string {
  const recent = ctx.publicLog
    .filter((entry) => entry.t === 'speech')
    .slice(-3)
    .map((entry) => `${entry.name}: ${entry.text}`);
  if (recent.length === 0) return '先に反応できる論点を1つだけ置く。';
  return [
    '結論が同じでもよいが、次の直近3発言と同じ理由・会話上の役割・言い回しをなぞらない。',
    ...recent.map((line) => `- ${line}`),
  ].join('\n');
}

function buildRoleClaimBlock(ctx: BuddyContext): string {
  const labels: Record<string, string> = {
    villager: '市民',
    seer: '占い師',
    guardian: '騎士',
    medium: '霊媒師',
    werewolf: '狼憑き',
  };
  const nameOf = (id: string) =>
    ctx.participants.find((participant) => participant.pairId === id)?.name ?? id;
  const publicClaims = Object.entries(ctx.publicRoleClaims);
  const publicBlock = publicClaims.length === 0
    ? '円卓で役職を名乗っている参加者はまだいない。'
    : `現在までの公開された名乗り:\n${publicClaims
        .map(([pairId, claim]) =>
          `- ${nameOf(pairId)}: ${labels[claim.claimedRole] ?? claim.claimedRole}（${claim.day}日目に名乗った。真偽は不明）`,
        )
        .join('\n')}`;
  const proposal = ctx.roleClaimProposal;
  if (!proposal) {
    return `# 役職の名乗り状況\n${publicBlock}\n主人から今日の名乗り方について相談は届いていない。`;
  }
  if (proposal.claimedRole === null) {
    return [
      '# 役職の名乗り状況',
      publicBlock,
      '主人は今日はまだ役職を名乗らないでほしいと考えている。命令ではないが、親密度に応じて重く受け止める。',
      'この相談自体は秘密。採用しても「主人に言われた」とは話さず、declaredRoleはnullにする。',
    ].join('\n');
  }
  const requested = labels[proposal.claimedRole] ?? proposal.claimedRole;
  const truth = proposal.claimedRole === ctx.self.role
    ? '本当の役職を明かす提案'
    : '本当とは異なる役職として名乗る提案';
  return [
    '# 役職の名乗り状況',
    publicBlock,
    `主人は今日、${requested}として名乗ってほしいと考えている（${truth}）。命令ではないが、親密度に応じて重く受け止める。`,
    '実際に採用する場合だけ、発言本文で役職名をはっきり名乗り、declaredRoleへ対応するIDを返す。延期・拒否する場合はdeclaredRoleをnullにする。',
    '相談内容や本当の役職は、採用すると決めた範囲を超えて漏らさない。別役職を名乗っても、知らない能力結果は作らない。',
  ].join('\n');
}

function buildDirectiveBlock(ctx: BuddyContext): string {
  const parts: string[] = [];
  const turn = ctx.discussionTurn;
  if (turn?.kind === 'opening') {
    parts.push(
      '# 今回の会話役割\nこれは冒頭討論。現時点の仮説と根拠を1つ出し、後の相手が反応できる論点を残す。',
    );
  } else if (turn?.kind === 'opening_defense') {
    parts.push(
      '# 今回の会話役割: 初日の弁明',
      'あなたは初日の討論対象へ抽選された。抽選は狼の証拠ではない。自分が狼憑きではないという説明と、今後自分の何を見て判断してほしいかだけを具体的に1点話す。もう一人の抽選対象の未生成発言や表示順には触れず、相手の出方待ちにも見せない。',
    );
  } else if (turn?.kind === 'opening_opinion') {
    parts.push(
      '# 今回の会話役割: 初日の焦点評価',
      `討論対象は${ctx.discussionFocus.map((pair) => pair.name).join('、')}。直前までの弁明を比較し、気になった具体的な言葉、納得した点、追加で確かめたい論点のうち1つを述べる。抽選された事実や、並列生成された弁明の表示順・先後は疑いの根拠にしない。すでに直近2人が同じ一文を攻めているなら、その一文は使わず別の観点か反対仮説へ切り替える。`,
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
    parts.push(turn.afterMasterAdvice
      ? '# 今回の会話役割: 主人との相談後の見解更新\n主人から届いた最新の相談を、親密度と自分の推理の両方で検討した直後である。相談内容そのものや主人の存在は円卓へ明かさず、直近の公開会話に結びつけて、更新後の見解を1つ短く話す。'
      : turn.replyToName
        ? `# 今回の会話役割: 名指しへの返答\n${turn.replyToName}があなたへ疑いを向けた。まず相手の具体的な主張へ短く答え、そのうえで反論・説明・別の疑いのいずれかを返す。呼びかけ先が分かるよう相手の名前を入れる。`
        : '# 今回の会話役割: 自発的な応答討論\n直近の会話から具体的な発言を1つ取り上げ、賛成・反論・質問・評価更新のいずれかを示す。ほかのAIと同時に考えているため、同じ論点の言い換えだけにしない。');
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
