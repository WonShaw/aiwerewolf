import type { GameEvent, Role, SeatMark, Team, Viewer } from '../shared/types.ts';

export interface BoardState {
  phase: { kind: 'waiting' | 'night' | 'day' | 'over'; number: number };
  dead: number[]; // 公开已知出局的座位
  sheriff: number | null;
  candidates: number[]; // 上警的玩家（竞选结束前）
  electing: boolean; // 正在竞选警长
  idiotRevealed: number | null;
  lastVote: Record<number, number | null> | null; // 最近一次投票，显示在座位上
  knownRoles: Record<number, Role>; // 当前观看者知道的全部身份（观众是所有人的）
  publicRoles: Record<number, Role>; // 已公开的身份（猎人开枪、白痴翻牌、结束后的全部）
  myRole: { role: Role; knowledge: string } | null;
  marks: SeatMark[]; // 自己的私密标记：狼同伴、查验结果
  gameOver: { winner: Team; reason: string } | null;
  usage: { costUsd: number; calls: number; cacheRead: number; cacheWrite: number; input: number; output: number };
}

export function deriveBoard(events: GameEvent[], viewer: Viewer | null): BoardState {
  const s: BoardState = {
    phase: { kind: 'waiting', number: 0 },
    dead: [],
    sheriff: null,
    candidates: [],
    electing: false,
    idiotRevealed: null,
    lastVote: null,
    knownRoles: {},
    publicRoles: {},
    myRole: null,
    marks: [],
    gameOver: null,
    usage: { costUsd: 0, calls: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  };
  const mySeat = viewer?.kind === 'player' ? viewer.seat : null;
  const sessionCost: Record<number, number> = {}; // 每个 AI 会话上一次报告的累计费用
  const die = (seat: number) => {
    if (!s.dead.includes(seat)) s.dead.push(seat);
  };
  const reveal = (seat: number, role: Role) => {
    s.knownRoles[seat] = role;
    s.publicRoles[seat] = role;
  };

  for (const e of events) {
    switch (e.type) {
      case 'role_assigned':
        // 能看到全部信息的人会收到所有人的这一条；对局中的玩家只会收到自己的
        s.knownRoles[e.seat] = e.role;
        if (e.seat === mySeat) {
          s.myRole = { role: e.role, knowledge: e.knowledge };
          s.marks.push(...e.marks);
          for (const m of e.marks) if (m.tone === 'wolf') s.knownRoles[m.seat] = 'werewolf';
        }
        break;
      case 'night_start':
        s.phase = { kind: 'night', number: e.night };
        s.lastVote = null;
        break;
      case 'day_start':
        s.phase = { kind: 'day', number: e.day };
        break;
      case 'seer_check':
        if (mySeat !== null) {
          s.marks = s.marks.filter((m) => m.seat !== e.target);
          s.marks.push({ seat: e.target, label: e.result === 'wolf' ? '查杀' : '金水', tone: e.result });
        }
        break;
      case 'sheriff_start':
        s.electing = true;
        break;
      case 'sheriff_candidates':
        s.candidates = e.candidates;
        break;
      case 'sheriff_vote':
        s.lastVote = e.votes;
        break;
      case 'sheriff_result':
        s.sheriff = e.sheriff;
        s.electing = false;
        s.candidates = [];
        break;
      case 'night_result':
        e.dead.forEach(die);
        break;
      case 'badge_passed':
        s.sheriff = e.to;
        break;
      case 'hunter_shot':
        reveal(e.hunter, 'hunter');
        if (e.target) die(e.target);
        break;
      case 'discussion_start':
        s.lastVote = null;
        break;
      case 'exile_vote':
        s.lastVote = e.votes;
        break;
      case 'exiled':
        die(e.seat);
        break;
      case 'idiot_revealed':
        s.idiotRevealed = e.seat;
        reveal(e.seat, 'idiot');
        break;
      case 'game_over':
        s.phase = { kind: 'over', number: s.phase.number };
        s.gameOver = { winner: e.winner, reason: e.reason };
        for (const [seat, role] of Object.entries(e.roles)) reveal(Number(seat), role);
        break;
      case 'ai_usage': {
        // costUsd 是会话的累计值，这次调用的费用是和上一次的差值；变小说明累计值被重置了，按新值算
        const prev = sessionCost[e.seat] ?? 0;
        s.usage.costUsd += e.costUsd >= prev ? e.costUsd - prev : e.costUsd;
        sessionCost[e.seat] = e.costUsd;
        s.usage.calls += 1;
        s.usage.cacheRead += e.cacheRead;
        s.usage.cacheWrite += e.cacheWrite;
        s.usage.input += e.input;
        s.usage.output += e.output;
        break;
      }
    }
  }
  return s;
}

// 对局中玩家收到的身份本来就只有自己知道的和已公开的；能看到全部信息的人关掉上帝视角时只看已公开的
export function visibleRoles(board: BoardState, viewer: Viewer | null, godView: boolean): Record<number, Role> {
  return viewer?.kind === 'player' || godView ? board.knownRoles : board.publicRoles;
}
