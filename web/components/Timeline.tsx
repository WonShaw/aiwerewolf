import { useEffect, useRef, type ReactNode } from 'react';
import type { ActionType, GameEvent, PlayerInfo, Role, SpeechKind, Viewer } from '../../shared/types.ts';
import { TEAM_NAME } from '../../shared/types.ts';
import { describeSetup } from '../../shared/setup.ts';
import { ACTION_LABEL, playerName, roleLabel, roleTone, seatHue } from '../format.ts';

interface Props {
  events: GameEvent[];
  players: PlayerInfo[];
  viewer: Viewer | null;
  fullView: boolean; // 能看到全部信息：观众，或对局正常结束后的玩家
  godView: boolean; // 上帝视角：其他人的身份、夜里的行动和思考摘要
  roles: Record<number, Role>; // 当前观看者能看到的身份
  acting: Record<number, ActionType>;
  live: Record<number, { action: ActionType; speech: string }>;
  children?: ReactNode; // 放在时间线最后，例如"再来一局"
}

const SPEECH_KIND: Record<SpeechKind, string> = {
  wolf: '狼人夜聊',
  campaign: '警上发言',
  discuss: '',
  pk: 'PK 发言',
  last_words: '遗言',
  reflect: '赛后感想',
};

const SPEAKING_ACTIONS: ActionType[] = ['wolf_discuss', 'campaign', 'speak', 'pk_speech', 'dying', 'reflect'];
const VOTING_ACTIONS: ActionType[] = ['run_for_sheriff', 'sheriff_vote', 'exile_vote'];

export function Timeline(props: Props) {
  const { events, players, viewer, fullView, godView, acting, live } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const mySeat = viewer?.kind === 'player' ? viewer.seat : null;
  // 不公开的信息（狼人夜聊、女巫、预言家……）：对局中的玩家只会收到自己有权看的，直接显示；
  // 能看到全部信息的人只在打开上帝视角时显示
  const showPrivate = !fullView || godView;

  const roleOf = (seat: number): Role | undefined => props.roles[seat];
  const name = (seat: number) => playerName(players, seat);
  const who = (seat: number) => `${seat}号 ${name(seat)}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const speaker = (seat: number) => {
    const role = roleOf(seat);
    return (
      <>
        <b>{name(seat)}</b>
        <span className="muted">
          {seat}号{seat === mySeat ? '（你）' : ''}
        </span>
        {role && <span className={`badge small ${roleTone(role)}`}>{roleLabel(role)}</span>}
      </>
    );
  };

  const seatChips = (seats: number[]) => (
    <span className="chips">
      {seats.map((s) => (
        <span key={s} className="chip" style={{ '--hue': seatHue(s) } as React.CSSProperties}>
          {s} {name(s)}
        </span>
      ))}
    </span>
  );

  // 投票结果：按投给谁分组，附上得票（警长 1.5 票）
  const voteCard = (title: string, votes: Record<number, number | null>, tally: Record<number, number>, footer: ReactNode, ok: boolean) => {
    const groups = new Map<number, number[]>();
    for (const [voter, target] of Object.entries(votes)) groups.set(target ?? 0, [...(groups.get(target ?? 0) ?? []), Number(voter)]);
    const rows = [...groups.entries()].sort(([a], [b]) => (a === 0 ? 1 : b === 0 ? -1 : (tally[b] ?? 0) - (tally[a] ?? 0)));
    return (
      <div className={`vote-card ${ok ? 'ok' : 'bad'}`}>
        <div className="vote-title">{title}</div>
        <div className="vote-rows">
          {rows.map(([target, voters]) => (
            <div key={target} className="vote-row">
              <span className="vote-to">{target ? `${who(target)}（${tally[target]} 票）` : '弃票'}</span>
              <span className="vote-from">{voters.sort((a, b) => a - b).map((v) => `${v}号`).join('、')}</span>
            </div>
          ))}
          {rows.length === 0 && <div className="muted">没有人投票</div>}
        </div>
        <div className="vote-footer">{footer}</div>
      </div>
    );
  };

  const render = (e: GameEvent) => {
    switch (e.type) {
      case 'game_start':
        return (
          <div className="divider">
            游戏开始
            <div className="muted small-text">{describeSetup(e.setup)}</div>
          </div>
        );
      case 'role_assigned':
        if (e.seat === mySeat) {
          return (
            <div className={`role-card ${roleTone(e.role)}`}>
              <div className="role-card-title">你的身份：{roleLabel(e.role)}</div>
              <div>{e.knowledge}</div>
            </div>
          );
        }
        if (!fullView || !godView) return null;
        return (
          <div className="sys small">
            {who(e.seat)} 的身份：
            <span className={`badge small ${roleTone(e.role)}`}>{roleLabel(e.role)}</span>
          </div>
        );
      case 'night_start':
        return <div className="round-head night">🌙 第 {e.night} 夜 · 天黑请闭眼</div>;
      case 'day_start':
        return <div className="round-head day">☀️ 第 {e.day} 天 · 天亮了</div>;
      case 'speech': {
        if (e.kind === 'wolf' && !showPrivate) return null;
        const label = SPEECH_KIND[e.kind];
        return (
          <div className={`msg${e.seat === mySeat ? ' mine' : ''}${e.kind === 'wolf' ? ' wolf-chat' : ''}`}>
            <div className="avatar" style={{ '--hue': seatHue(e.seat) } as React.CSSProperties}>
              {e.seat}
            </div>
            <div className="msg-body">
              <div className="msg-head">
                {speaker(e.seat)}
                {label && <span className={`kind${e.kind === 'wolf' ? ' wolf' : ''}`}>{label}</span>}
              </div>
              <div className="msg-text">{e.text}</div>
            </div>
          </div>
        );
      }
      case 'thought':
        // 服务端只在允许时推送思考摘要：全 AI 对局的观众，或对局结束后的玩家
        if (!fullView || !godView) return null;
        return (
          <div className="thought">
            <div className="thought-head">
              思考摘要 · {who(e.seat)} · {ACTION_LABEL[e.action]}
            </div>
            <div className="thought-text">{e.summary}</div>
          </div>
        );
      case 'wolf_kill':
        if (!showPrivate) return null;
        return (
          <div className="sys night-info wolf">
            🐺 狼人决定袭击 <b>{who(e.target)}</b>
            <span className="muted">
              （投票：
              {Object.entries(e.votes)
                .map(([w, t]) => `${w}号→${t}号`)
                .join('，')}
              ）
            </span>
          </div>
        );
      case 'witch_info':
        if (!showPrivate) return null;
        return (
          <div className="sys night-info">
            🧪 女巫：
            {!e.antidote ? '解药已用完，看不到今晚谁被袭击' : e.victim ? `今晚被袭击的是 ${who(e.victim)}` : '今晚没有人被袭击'}
            <span className="muted">
              （解药{e.antidote ? '还在' : '已用完'}，毒药{e.poison ? '还在' : '已用完'}）
            </span>
          </div>
        );
      case 'witch_action':
        if (!showPrivate) return null;
        return (
          <div className="sys night-info">
            🧪 女巫
            {e.save ? `用解药救了 ${who(e.save)}` : ''}
            {e.poison ? `用毒药毒了 ${who(e.poison)}` : ''}
            {!e.save && !e.poison ? '没有用药' : ''}
          </div>
        );
      case 'seer_check':
        if (!showPrivate) return null;
        return (
          <div className="sys night-info">
            🔮 预言家查验 {who(e.target)}：
            <span className={`badge small ${e.result}`}>{TEAM_NAME[e.result]}</span>
          </div>
        );
      case 'night_summary':
        if (!fullView || !godView) return null;
        return (
          <div className="sys small muted">
            夜里结算：
            {e.deaths.length
              ? e.deaths.map((d) => `${who(d.seat)}${d.cause === 'poison' ? '被毒死' : '被狼人袭击'}`).join('，')
              : '没有人死亡'}
          </div>
        );
      case 'sheriff_start':
        return <div className="divider">警长竞选</div>;
      case 'sheriff_candidates':
        return (
          <div className="sys">{e.candidates.length ? <>上警：{seatChips(e.candidates)}</> : '没有人上警'}</div>
        );
      case 'sheriff_vote':
        return voteCard(
          `警长${e.round > 1 ? ' PK ' : ''}投票`,
          e.votes,
          e.tally,
          e.pk.length ? <>平票，{seatChips(e.pk)} 进入 PK</> : null,
          e.pk.length === 0,
        );
      case 'sheriff_result':
        return e.sheriff ? (
          <div className="banner gold">
            {who(e.sheriff)} 当选警长
            <div className="banner-sub">{e.reason}</div>
          </div>
        ) : (
          <div className="sys strong">本局没有警长：{e.reason}</div>
        );
      case 'night_result':
        return (
          <div className={`banner ${e.dead.length ? 'wolf' : 'good'}`}>
            {e.dead.length ? '昨晚死亡' : '昨晚是平安夜'}
            {e.dead.length > 0 && <div className="banner-sub">{seatChips(e.dead)}</div>}
          </div>
        );
      case 'badge_passed':
        return <div className="sys strong">{e.to ? `${who(e.from)} 把警徽移交给 ${who(e.to)}` : `${who(e.from)} 的警徽流失`}</div>;
      case 'hunter_shot':
        if (!e.target) return null;
        return (
          <div className="banner wolf">
            {who(e.hunter)} 亮明猎人身份，开枪带走了 {who(e.target)}
          </div>
        );
      case 'discussion_start':
        return (
          <div className="sys">
            发言顺序{e.chosenBy ? `（警长 ${e.chosenBy}号 决定）` : ''}：{e.order.map((s) => `${s}`).join(' → ')}
          </div>
        );
      case 'exile_vote':
        return voteCard(
          `第 ${e.day} 天放逐${e.round > 1 ? ' PK ' : ''}投票（警长 1.5 票）`,
          e.votes,
          e.tally,
          e.pk.length ? <>平票，{seatChips(e.pk)} 进入 PK</> : e.result ? <>{who(e.result)} 得票最多</> : '今天没有人被放逐',
          !!e.result,
        );
      case 'exiled':
        return <div className="banner wolf">{who(e.seat)} 被放逐出局</div>;
      case 'idiot_revealed':
        return (
          <div className="banner good">
            {who(e.seat)} 翻牌：白痴，免于出局
            <div className="banner-sub">之后可以发言，但不能再投票</div>
          </div>
        );
      case 'game_over':
        return (
          <div className={`banner big ${e.winner}`}>
            {TEAM_NAME[e.winner]}阵营获胜
            <div className="banner-sub">{e.reason}</div>
            <div className="banner-sub">
              {Object.entries(e.roles).map(([s, r]) => (
                <span key={s} className={`badge small ${roleTone(r)}`}>
                  {s}号 {name(Number(s))} · {roleLabel(r)}
                </span>
              ))}
            </div>
          </div>
        );
      case 'postgame_start':
        return (
          <div className="round-head">
            赛后交流{e.round > 1 && ` · 第 ${e.round} 轮`} · 每人发言一次
          </div>
        );
      case 'postgame_end':
        return <div className="divider">赛后交流结束</div>;
      case 'ai_error':
        if (!fullView) return null;
        return (
          <div className="sys small error">
            {who(e.seat)}（{ACTION_LABEL[e.action]}）：{e.message}
          </div>
        );
      case 'ai_usage':
        return null;
    }
  };

  // 底部：正在进行中的动作
  const actingSeats = Object.entries(acting).map(([s, a]) => [Number(s), a] as const);
  const voting = actingSeats.filter(([, a]) => VOTING_ACTIONS.includes(a));
  const speakingSeats = actingSeats
    .filter(([s, a]) => SPEAKING_ACTIONS.includes(a) && (a !== 'wolf_discuss' || showPrivate || s === mySeat))
    .map(([s]) => s);
  const lastPhase = events.findLast((e) => e.type === 'night_start' || e.type === 'day_start' || e.type === 'game_over');
  const night = lastPhase?.type === 'night_start';

  return (
    <div className="timeline" ref={scrollRef} onScroll={onScroll}>
      {events.map((e) => {
        const node = render(e);
        return node ? <div key={e.seq}>{node}</div> : null;
      })}

      {speakingSeats.map((seat) => {
        const text = live[seat]?.speech;
        const isHuman = players.find((p) => p.seat === seat)?.kind === 'human';
        return (
          <div key={`live-${seat}`} className={`msg pending${acting[seat] === 'wolf_discuss' ? ' wolf-chat' : ''}`}>
            <div className="avatar" style={{ '--hue': seatHue(seat) } as React.CSSProperties}>
              {seat}
            </div>
            <div className="msg-body">
              <div className="msg-head">
                {speaker(seat)}
                <span className="kind">{ACTION_LABEL[acting[seat]]}</span>
              </div>
              <div className="msg-text">
                {text ? (
                  <>
                    {text}
                    <span className="caret" />
                  </>
                ) : (
                  <span className="muted dots">{isHuman ? (seat === mySeat ? '轮到你了' : '正在输入') : '正在思考'}</span>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {voting.length > 0 && <div className="sys muted dots">正在同时决定，还有 {voting.length} 人未提交</div>}
      {night && speakingSeats.length === 0 && <div className="sys muted dots">夜里，有人正在行动</div>}
      {props.children}
    </div>
  );
}
