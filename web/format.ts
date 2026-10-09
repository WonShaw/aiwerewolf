import { ROLE_NAME, ROLE_TEAM, type ActionType, type PlayerInfo, type Role, type Team } from '../shared/types.ts';

export function playerName(players: PlayerInfo[], seat: number): string {
  return players.find((p) => p.seat === seat)?.name ?? `${seat}号`;
}

export function roleLabel(role: Role): string {
  return ROLE_NAME[role];
}

export function roleTone(role: Role): Team {
  return ROLE_TEAM[role];
}

export const ACTION_LABEL: Record<ActionType, string> = {
  wolf_discuss: '狼人夜聊',
  witch: '女巫用药',
  seer: '查验',
  run_for_sheriff: '决定是否上警',
  campaign: '警上发言',
  sheriff_vote: '投票选警长',
  speech_order: '决定发言顺序',
  speak: '发言',
  exile_vote: '放逐投票',
  pk_speech: 'PK 发言',
  dying: '出局',
  reflect: '赛后感想',
};

// 每个座位一个固定色相，用于头像
export function seatHue(seat: number): number {
  return [32, 200, 140, 280, 350, 90, 240, 170, 55, 315, 10, 120][(seat - 1) % 12];
}

export function seats(list: number[]): string {
  return list.length ? list.map((s) => `${s}号`).join('、') : '无';
}
