// 前后端共享的类型定义

export type Role = 'werewolf' | 'seer' | 'witch' | 'hunter' | 'idiot' | 'villager';

// 两个阵营：好人（神职 + 平民）和狼人
export type Team = 'good' | 'wolf';

export const ROLE_TEAM: Record<Role, Team> = {
  werewolf: 'wolf',
  seer: 'good',
  witch: 'good',
  hunter: 'good',
  idiot: 'good',
  villager: 'good',
};

export const ROLE_NAME: Record<Role, string> = {
  werewolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  idiot: '白痴',
  villager: '平民',
};

export const TEAM_NAME: Record<Team, string> = { good: '好人', wolf: '狼人' };

// 神职：屠边规则里和平民分开计算
export const GOD_ROLES: Role[] = ['seer', 'witch', 'hunter', 'idiot'];

export function isGod(role: Role): boolean {
  return GOD_ROLES.includes(role);
}

export interface PlayerInfo {
  seat: number; // 1-12
  name: string;
  kind: 'ai' | 'human';
}

// 座位上的私密标记，例如狼人看到的同伴、预言家的查验结果
export interface SeatMark {
  seat: number;
  label: string;
  tone: 'good' | 'wolf' | 'unknown';
}

export type Visibility =
  | { kind: 'public' }
  | { kind: 'players'; seats: number[] }
  | { kind: 'spectator' };

export type SpeechKind =
  | 'wolf' // 夜里狼人之间的讨论
  | 'campaign' // 警上发言
  | 'discuss' // 白天发言
  | 'pk' // PK 发言（警长或放逐）
  | 'last_words' // 遗言
  | 'reflect'; // 赛后感想

export type Direction = 'cw' | 'ccw'; // 发言顺序：顺时针（座位号递增）/ 逆时针

// 死亡原因只对观众和赛后公开；对局中白天只公布谁死了
export type DeathCause = 'wolf' | 'poison' | 'exile' | 'shot';

export type GameEventBody =
  | { type: 'game_start'; players: PlayerInfo[]; setup: Role[] }
  | { type: 'role_assigned'; seat: number; role: Role; knowledge: string; marks: SeatMark[] }
  | { type: 'night_start'; night: number }
  | { type: 'speech'; seat: number; kind: SpeechKind; text: string }
  // 狼人最终决定袭击的目标（只有狼人看得到）
  | { type: 'wolf_kill'; night: number; target: number; votes: Record<number, number> }
  // 女巫看到的信息：有解药时才知道今晚谁被袭击
  | { type: 'witch_info'; night: number; victim: number | null; antidote: boolean; poison: boolean }
  | { type: 'witch_action'; night: number; save: number | null; poison: number | null }
  | { type: 'seer_check'; night: number; target: number; result: Team }
  // 夜里的真实结算（只有观众看得到）
  | { type: 'night_summary'; night: number; deaths: { seat: number; cause: DeathCause }[] }
  | { type: 'day_start'; day: number }
  | { type: 'sheriff_start' }
  | { type: 'sheriff_candidates'; candidates: number[] }
  // round 2 是 PK；pk 非空表示平票，接着进入 PK
  | { type: 'sheriff_vote'; round: number; votes: Record<number, number | null>; tally: Record<number, number>; pk: number[] }
  | { type: 'sheriff_result'; sheriff: number | null; reason: string }
  | { type: 'night_result'; night: number; dead: number[] } // 天亮公布昨晚死亡的玩家，不公布死因
  | { type: 'badge_passed'; from: number; to: number | null } // 警长死亡或白痴翻牌后警徽移交（null 表示警徽流失）
  | { type: 'hunter_shot'; hunter: number; target: number | null } // 猎人开枪（亮明身份），target 为 null 表示不开枪
  | { type: 'discussion_start'; day: number; order: number[]; chosenBy: number | null }
  | {
      type: 'exile_vote';
      day: number;
      round: number;
      votes: Record<number, number | null>;
      tally: Record<number, number>; // 警长的票按 1.5 计
      pk: number[];
      result: number | null;
    }
  | { type: 'exiled'; seat: number }
  | { type: 'idiot_revealed'; seat: number } // 白痴被放逐时翻牌免死，之后不能投票
  | { type: 'game_over'; winner: Team; reason: string; roles: Record<number, Role> }
  | { type: 'postgame_start'; round: number }
  | { type: 'postgame_end' }
  // 以下仅观众可见
  | { type: 'thought'; seat: number; action: ActionType; summary: string }
  | { type: 'ai_error'; seat: number; action: ActionType; message: string }
  // costUsd 是这个 AI 的会话到这次调用为止的累计估算费用（SDK 续接会话时会带上之前的轮次），
  // 不是这一次的费用；token 数是这一次调用的
  | { type: 'ai_usage'; seat: number; action: ActionType; costUsd: number; durationMs: number; cacheRead: number; cacheWrite: number; input: number; output: number };

export type GameEvent = GameEventBody & {
  seq: number;
  ts: number;
  visibility: Visibility;
};

export type ActionType =
  | 'wolf_discuss' // 狼人夜里讨论并提议袭击目标
  | 'witch' // 女巫用药
  | 'seer' // 预言家查验
  | 'run_for_sheriff' // 是否上警
  | 'campaign' // 警上发言
  | 'sheriff_vote' // 警下投票选警长
  | 'speech_order' // 警长决定发言顺序
  | 'speak' // 白天发言
  | 'exile_vote' // 放逐投票
  | 'pk_speech' // PK 发言
  | 'dying' // 死亡时：遗言、猎人开枪、移交警徽
  | 'reflect'; // 赛后感想

// 夜里的动作：谁在行动、发言过程都不能让其他玩家看到
export const NIGHT_ACTIONS: ActionType[] = ['wolf_discuss', 'witch', 'seer'];

export type GameStatus = 'running' | 'finished' | 'aborted' | 'error';

// 赛后交流的状态：还没开始 / 进行中 / 已结束（可以再开一轮）
export type PostgameStatus = 'none' | 'running' | 'done';

export interface GameSummary {
  id: string;
  createdAt: number;
  status: GameStatus;
  winner?: Team;
  players: PlayerInfo[];
  hasHumans: boolean;
  setup: Role[];
  postgame: PostgameStatus;
}

// 谁在看：全 AI 对局的上帝视角观众，或者某个座位上的人类玩家
export type Viewer = { kind: 'spectator' } | { kind: 'player'; seat: number };

// 能看到全部信息（所有人的身份、夜里的行动、AI 的思考摘要和调用统计）：全 AI 对局的观众一直可以；
// 玩家在出局后（遗言、开枪、移交警徽都处理完）或对局正常结束后也可以。服务端据此过滤推送，
// 并在 hello 里告诉网页。只影响推给网页的内容，AI 的上下文由 engine.ts 的 visibleTo 单独过滤
export function seesEverything(viewer: Viewer, status: GameStatus, observer = false): boolean {
  return viewer.kind === 'spectator' || status === 'finished' || observer;
}

// 做一个动作需要的信息：AI 的指令和人类的操作面板用的是同一份
export interface ActionInfo {
  night?: number;
  day?: number;
  targets?: number[]; // 可选的目标座位
  victim?: number | null; // 女巫：今晚被袭击的人（解药用完后不告诉）
  canSave?: boolean; // 女巫：今晚能不能用解药
  canPoison?: boolean; // 女巫：还有没有毒药
  pk?: number[]; // PK 的玩家
  pkFor?: 'sheriff' | 'exile';
  isSheriff?: boolean; // 放逐投票：自己是警长，票算 1.5
  lastWords?: boolean; // 死亡：有没有遗言
  canShoot?: boolean; // 死亡：猎人能不能开枪
  hasBadge?: boolean; // 死亡：是警长，要移交警徽
  deathNote?: string; // 死亡：怎么出局的（只给本人看）
  cw?: number; // 发言顺序：顺时针第一位
  ccw?: number; // 发言顺序：逆时针第一位
  recap?: string; // 赛后交流：本局结果和全部身份
  round?: number; // 赛后交流：第几轮
}

// 等待人类玩家做的动作
export interface HumanRequest extends ActionInfo {
  id: string;
  seat: number;
  action: ActionType;
}

// 人类玩家提交的动作，字段与 AI 的结构化输出一致。
// 座位号字段用 0 表示"不选"（弃票、不开枪、撕毁警徽、不用毒药）
export interface ActionSubmission {
  action: ActionType;
  speech?: string;
  target?: number;
  save?: boolean;
  poison?: number;
  run?: boolean;
  direction?: Direction;
  shoot?: number;
  badge?: number;
}

// 人类玩家想玩的身份：随机、随机某个阵营，或指定身份
export type RolePreference = 'random' | Team | Role;

export interface HumanSeatRequest {
  name: string;
  role: RolePreference;
}

export interface CreateGameRequest {
  humans: HumanSeatRequest[]; // 空数组表示全 AI 对局
}

export interface CreateGameResponse {
  summary: GameSummary;
  seats: { seat: number; name: string; token: string }[]; // 每个人类玩家的专属凭证
}

// 通过 SSE 推给前端的消息
export type StreamMessage =
  | { kind: 'hello'; viewer: Viewer; fullView: boolean } // fullView 见 seesEverything
  | { kind: 'event'; event: GameEvent }
  // 正在生成中的发言（流式）；seats 存在时只推给这些座位（例如夜里狼人的讨论）
  | { kind: 'live'; seat: number; action: ActionType; speech: string; seats?: number[] }
  // 谁正在行动；hidden 时只推给行动者本人（夜里的动作）
  | { kind: 'status'; seat: number; action: ActionType; active: boolean; hidden?: boolean }
  | { kind: 'game'; summary: GameSummary }
  | { kind: 'request'; request: HumanRequest } // 轮到你了
  | { kind: 'request_done'; seat: number; id: string };
