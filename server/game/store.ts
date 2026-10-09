import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { GameEvent, GameStatus, PlayerInfo, PostgameStatus, Role, Team } from '../../shared/types.ts';

// 游戏记录（含所有身份与私密信息）只由服务端读写，AI 进程无法访问
const DATA_DIR = join(import.meta.dirname, '..', '..', 'data', 'games');

export interface GameRecord {
  id: string;
  createdAt: number;
  status: GameStatus;
  winner?: Team;
  setup: Role[];
  players: PlayerInfo[];
  roles: Record<number, Role>;
  sessions: Record<number, string | null>; // 座位 -> Agent SDK session id（只有 AI 座位）
  humanTokens: Record<number, string>; // 座位 -> 人类玩家的凭证
  cursors?: Record<number, number>; // 座位 -> 该 AI 已经看过的最后一个事件序号（早期记录没有）
  postgame?: PostgameStatus;
}

export class GameStore {
  constructor(private dir = DATA_DIR) {
    mkdirSync(this.dir, { recursive: true });
  }

  private gameDir(id: string): string {
    return join(this.dir, id);
  }

  saveRecord(record: GameRecord): void {
    mkdirSync(this.gameDir(record.id), { recursive: true });
    writeFileSync(join(this.gameDir(record.id), 'game.json'), JSON.stringify(record, null, 2));
  }

  appendEvent(id: string, event: GameEvent): void {
    appendFileSync(join(this.gameDir(id), 'events.jsonl'), JSON.stringify(event) + '\n');
  }

  loadRecord(id: string): GameRecord | null {
    const file = join(this.gameDir(id), 'game.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as GameRecord;
  }

  loadEvents(id: string): GameEvent[] {
    const file = join(this.gameDir(id), 'events.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GameEvent);
  }

  deleteGame(id: string): void {
    const dir = resolve(this.gameDir(id));
    // 只允许删 games 目录下的直接子目录
    if (dirname(dir) !== resolve(this.dir)) throw new Error(`invalid game id: ${id}`);
    rmSync(dir, { recursive: true, force: true });
  }

  listRecords(): GameRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((id) => this.loadRecord(id))
      .filter((r): r is GameRecord => r !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}
