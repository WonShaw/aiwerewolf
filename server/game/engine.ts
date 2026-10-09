import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { NIGHT_ACTIONS, ROLE_NAME, TEAM_NAME } from '../../shared/types.ts';
import type {
  ActionInfo,
  ActionSubmission,
  ActionType,
  CreateGameRequest,
  DeathCause,
  GameEvent,
  GameEventBody,
  GameSummary,
  HumanRequest,
  PlayerInfo,
  PostgameStatus,
  Role,
  StreamMessage,
  Team,
  Visibility,
} from '../../shared/types.ts';
import { SETUP } from '../../shared/setup.ts';
import { AIPlayer, type ActResult } from '../ai/player.ts';
import { AI_NAMES } from '../ai/names.ts';
import { actionInstruction, invalidInstruction, renderEvent, sanitizeSpeech } from '../ai/prompts.ts';
import { assignRoles, checkWinner, isWolf, knowledgeFor, nextSeat, seatsFrom, shuffle } from './rules.ts';
import type { GameRecord, GameStore } from './store.ts';

const PUBLIC: Visibility = { kind: 'public' };
const SPECTATOR: Visibility = { kind: 'spectator' };
const group = (seats: number[]): Visibility => ({ kind: 'players', seats });
const only = (seat: number): Visibility => group([seat]);

const MAX_SPEECH_CHARS = 1000;
const MAX_INVALID_RETRIES = 2; // AI 提交不合法时最多再问几次
const MAX_CALL_RETRIES = 3; // 调用出错（网络、限流等）时最多重试几次
// 有人类玩家时，夜里每一步至少等这么久。女巫、预言家已经出局时这一步也照常等，
// 避免从夜里的快慢推断谁还活着、谁是人类
const NIGHT_MIN_MS = Number(process.env.AIWEREWOLF_NIGHT_MIN_MS ?? 6000);
const NIGHT_JITTER_MS = NIGHT_MIN_MS / 2;
const MAX_DAYS = 30; // 正常对局远到不了，防止死循环

class GameAborted extends Error {}

// 胜负条件达成，游戏立即结束
class GameOver extends Error {
  constructor(
    readonly winner: Team,
    readonly reason: string,
  ) {
    super(reason);
  }
}

type Validator = (o: ActionSubmission) => string | null;

interface PendingHuman {
  request: HumanRequest;
  validate: Validator;
  resolve: (o: ActionSubmission) => void;
  reject: (e: Error) => void;
}

interface Death {
  seat: number;
  cause: DeathCause;
  lastWords: boolean;
}

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Game {
  readonly bus = new EventEmitter();
  readonly events: GameEvent[] = [];
  private readonly ais: Record<number, AIPlayer> = {};
  private readonly cursors: Record<number, number> = {};
  private readonly acting = new Map<number, { action: ActionType; hidden: boolean }>();
  private readonly liveScope = new Map<number, number[] | 'public' | 'none'>(); // 正在生成的发言推给谁
  private readonly pendingHumans = new Map<number, PendingHuman>();
  private abortController = new AbortController(); // 当前阶段（对局 / 赛后交流）的中止信号

  // 对局状态（只在内存里，进程重启后对局会被标记为中止）
  private readonly alive = new Set<number>();
  private sheriff: number | null = null;
  private idiotRevealed: number | null = null;
  private readonly observers = new Set<number>(); // 出局并处理完遗言等的玩家，网页上进入旁观视角
  private antidote = true;
  private poison = true;

  // 人类玩家的身份偏好无法满足时抛出错误
  static create(store: GameStore, req: CreateGameRequest): Game {
    const setup = SETUP;
    const n = setup.length;
    const { humans: humanRoles, rest } = assignRoles(setup, req.humans.map((h) => h.role));
    const humanSeats = shuffle(seatsFrom(1, n)).slice(0, req.humans.length);
    // 和人类重名的 AI 名字这局不用，避免桌上出现两个同名玩家
    const humanNames = new Set(req.humans.map((h) => h.name));
    const aiNames = shuffle(AI_NAMES.filter((name) => !humanNames.has(name)));
    const aiRoles = shuffle(rest);

    const players: PlayerInfo[] = [];
    const roles: Record<number, Role> = {};
    const humanTokens: Record<number, string> = {};
    let a = 0;
    for (const seat of seatsFrom(1, n)) {
      const h = humanSeats.indexOf(seat);
      if (h >= 0) {
        players.push({ seat, name: req.humans[h].name, kind: 'human' });
        roles[seat] = humanRoles[h];
        humanTokens[seat] = randomBytes(16).toString('hex');
      } else {
        players.push({ seat, name: aiNames[a], kind: 'ai' });
        roles[seat] = aiRoles[a];
        a++;
      }
    }

    const record: GameRecord = {
      id: new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '') + '-' + randomUUID().slice(0, 6),
      createdAt: Date.now(),
      status: 'running',
      setup,
      players,
      roles,
      sessions: Object.fromEntries(players.filter((p) => p.kind === 'ai').map((p) => [p.seat, null])),
      humanTokens,
    };
    store.saveRecord(record);
    return new Game(record, store);
  }

  // 从磁盘恢复一局（例如服务重启后回看、开启赛后交流）
  static load(store: GameStore, id: string): Game | null {
    const record = store.loadRecord(id);
    if (!record) return null;
    record.humanTokens ??= {};
    record.setup ??= SETUP;
    const game = new Game(record, store);
    game.events.push(...store.loadEvents(id));
    for (const seat of Object.keys(game.ais).map(Number)) {
      game.cursors[seat] = record.cursors?.[seat] ?? game.events.length;
    }
    return game;
  }

  // 进程重启后，没跑完的对局和赛后交流都无法继续：对局标记为中止，赛后交流补上结束事件并标记为结束
  static recoverInterrupted(store: GameStore): void {
    for (const record of store.listRecords()) {
      if (record.status === 'running') {
        record.status = 'aborted';
        store.saveRecord(record);
      }
      if (record.postgame === 'running') {
        record.postgame = 'done';
        store.saveRecord(record);
        // 补上结束事件，时间线才完整。事件文件损坏（比如崩溃时写坏了最后一行）时跳过，不影响服务启动和这局的删除
        try {
          const seq = store.loadEvents(record.id).length + 1;
          store.appendEvent(record.id, { type: 'postgame_end', seq, ts: Date.now(), visibility: PUBLIC });
        } catch (err) {
          console.warn(`[game ${record.id}] 事件记录无法读取，没有补上赛后交流的结束事件：`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  private constructor(
    readonly record: GameRecord,
    private readonly store: GameStore,
  ) {
    for (const p of record.players) {
      this.alive.add(p.seat);
      if (p.kind !== 'ai') continue;
      this.cursors[p.seat] = 0;
      this.ais[p.seat] = new AIPlayer(p.seat, record.sessions[p.seat], {
        onSession: (s, sessionId) => {
          this.record.sessions[s] = sessionId;
          this.store.saveRecord(this.record);
        },
        onLiveSpeech: (s, action, speech) => {
          const scope = this.liveScope.get(s) ?? 'none';
          if (scope === 'none') return;
          this.broadcast({ kind: 'live', seat: s, action, speech, ...(scope === 'public' ? {} : { seats: scope }) });
        },
      });
    }
  }

  get id(): string {
    return this.record.id;
  }

  private get n(): number {
    return this.record.players.length;
  }

  private get roles(): Record<number, Role> {
    return this.record.roles;
  }

  get hasHumans(): boolean {
    return Object.keys(this.record.humanTokens).length > 0;
  }

  private isHuman(seat: number): boolean {
    return seat in this.record.humanTokens;
  }

  private aliveSeats(): number[] {
    return [...this.alive].sort((a, b) => a - b);
  }

  private aliveWolves(): number[] {
    return this.aliveSeats().filter((s) => isWolf(this.roles[s]));
  }

  private seatOf(role: Role): number {
    return Number(Object.entries(this.roles).find(([, r]) => r === role)![0]);
  }

  summary(): GameSummary {
    const { id, createdAt, status, winner, players, setup } = this.record;
    const postgame = this.record.postgame ?? 'none';
    return { id, createdAt, status, winner, players, hasHumans: this.hasHumans, setup, postgame };
  }

  actingNow(): { seat: number; action: ActionType; hidden: boolean }[] {
    return [...this.acting.entries()].map(([seat, a]) => ({ seat, ...a }));
  }

  seatForToken(token: string): number | null {
    const entry = Object.entries(this.record.humanTokens).find(([, t]) => t === token);
    return entry ? Number(entry[0]) : null;
  }

  // 出局并处理完遗言、开枪、移交警徽的玩家，之后能看到全部信息
  isObserver(seat: number): boolean {
    return this.observers.has(seat);
  }

  pendingRequestFor(seat: number): HumanRequest | null {
    return this.pendingHumans.get(seat)?.request ?? null;
  }

  // 人类玩家提交动作；返回错误信息，或 null 表示已接受
  submitHuman(seat: number, submission: ActionSubmission): string | null {
    const pending = this.pendingHumans.get(seat);
    if (!pending) return '现在不需要你行动';
    if (submission.action !== pending.request.action) return `现在需要的动作是 ${pending.request.action}`;
    const error = pending.validate(submission);
    if (error) return error;
    this.pendingHumans.delete(seat);
    this.broadcast({ kind: 'request_done', seat, id: pending.request.id });
    pending.resolve(submission);
    return null;
  }

  stop(): void {
    this.abortController.abort();
    for (const pending of this.pendingHumans.values()) pending.reject(new GameAborted());
    this.pendingHumans.clear();
  }

  // ---------- 事件 ----------

  private broadcast(msg: StreamMessage): void {
    this.bus.emit('message', msg);
  }

  private emit(body: GameEventBody, visibility: Visibility): GameEvent {
    const event = { ...body, seq: this.events.length + 1, ts: Date.now(), visibility } as GameEvent;
    this.events.push(event);
    this.store.appendEvent(this.id, event);
    this.broadcast({ kind: 'event', event });
    return event;
  }

  private setStatus(status: GameRecord['status'], winner?: Team): void {
    this.record.status = status;
    if (winner) this.record.winner = winner;
    this.store.saveRecord(this.record);
    this.broadcast({ kind: 'game', summary: this.summary() });
  }

  private visibleTo(e: GameEvent, seat: number): boolean {
    return e.visibility.kind === 'public' || (e.visibility.kind === 'players' && e.visibility.seats.includes(seat));
  }

  // 该 AI 上次行动之后、它能看到的新事件，渲染成文本
  private pendingFor(seat: number): string {
    const ctx = { viewer: seat, players: this.record.players };
    const lines = this.events
      .filter((e) => e.seq > this.cursors[seat] && this.visibleTo(e, seat))
      .map((e) => renderEvent(e, ctx))
      .filter((t): t is string => t !== null);
    this.cursors[seat] = this.events.length;
    this.record.cursors = { ...this.cursors };
    this.store.saveRecord(this.record);
    return lines.join('\n\n');
  }

  private checkAborted(): void {
    if (this.abortController.signal.aborted) throw new GameAborted();
  }

  // 谁在行动是否只推给行动者本人：夜里的动作，以及没有遗言的出局处理（否则停顿会暴露猎人或警长在做决定）
  private static hiddenAction(action: ActionType, info: ActionInfo): boolean {
    return NIGHT_ACTIONS.includes(action) || (action === 'dying' && !info.lastWords);
  }

  private setActing(seat: number, action: ActionType, active: boolean, hidden: boolean): void {
    if (active) this.acting.set(seat, { action, hidden });
    else this.acting.delete(seat);
    this.broadcast({ kind: 'status', seat, action, active, ...(hidden ? { hidden: true } : {}) });
  }

  // 正在生成的发言推给谁：狼人夜聊只给狼人，公开发言给所有人，其余动作没有发言
  private liveScopeFor(action: ActionType, info: ActionInfo): number[] | 'public' | 'none' {
    if (action === 'wolf_discuss') return this.aliveWolves();
    if (['campaign', 'speak', 'pk_speech', 'reflect'].includes(action)) return 'public';
    if (action === 'dying' && info.lastWords) return 'public';
    return 'none';
  }

  // ---------- 询问玩家 ----------

  private async ask(
    seat: number,
    action: ActionType,
    info: ActionInfo,
    validate: Validator,
    fallback: () => ActionSubmission,
  ): Promise<ActionSubmission> {
    return this.isHuman(seat) ? this.askHuman(seat, action, info, validate) : this.askAI(seat, action, info, validate, fallback);
  }

  private async askHuman(seat: number, action: ActionType, info: ActionInfo, validate: Validator): Promise<ActionSubmission> {
    this.checkAborted();
    const request: HumanRequest = { id: randomUUID(), seat, action, ...info };
    const hidden = Game.hiddenAction(action, info);
    this.setActing(seat, action, true, hidden);
    try {
      const out = await new Promise<ActionSubmission>((resolve, reject) => {
        this.pendingHumans.set(seat, { request, validate, resolve, reject });
        this.broadcast({ kind: 'request', request });
      });
      if (out.speech !== undefined) out.speech = sanitizeSpeech(out.speech).slice(0, MAX_SPEECH_CHARS);
      return out;
    } finally {
      this.setActing(seat, action, false, hidden);
    }
  }

  private async callAI(seat: number, action: ActionType, prompt: string, hidden: boolean): Promise<ActResult> {
    for (let attempt = 0; ; attempt++) {
      this.checkAborted();
      this.setActing(seat, action, true, hidden);
      try {
        const text = attempt === 0 ? prompt : `【裁判】（上一次请求意外中断，请重新提交。）\n\n${prompt}`;
        return await this.ais[seat].act(text, action, this.abortController.signal);
      } catch (err) {
        this.checkAborted();
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'ai_error', seat, action, message }, SPECTATOR);
        if (attempt >= MAX_CALL_RETRIES) throw err;
        await sleep(3000 * 2 ** attempt);
      } finally {
        this.setActing(seat, action, false, hidden);
      }
    }
  }

  private async askAI(
    seat: number,
    action: ActionType,
    info: ActionInfo,
    validate: Validator,
    fallback: () => ActionSubmission,
  ): Promise<ActionSubmission> {
    let prompt = [this.pendingFor(seat), actionInstruction(action, info)].filter(Boolean).join('\n\n');
    this.liveScope.set(seat, this.liveScopeFor(action, info));
    try {
      for (let i = 0; i <= MAX_INVALID_RETRIES; i++) {
        const res = await this.callAI(seat, action, prompt, Game.hiddenAction(action, info));
        this.emit(
          {
            type: 'ai_usage',
            seat,
            action,
            costUsd: res.sessionCostUsd,
            durationMs: res.durationMs,
            cacheRead: res.usage.cacheRead,
            cacheWrite: res.usage.cacheWrite,
            input: res.usage.input,
            output: res.usage.output,
          },
          SPECTATOR,
        );
        if (res.thinking) this.emit({ type: 'thought', seat, action, summary: res.thinking }, SPECTATOR);

        const out = res.output;
        const error = out.action !== action ? `本次需要的 action 是 ${action}，你提交的是 ${out.action}` : validate(out);
        if (!error) {
          if (out.speech !== undefined) out.speech = sanitizeSpeech(out.speech).slice(0, MAX_SPEECH_CHARS);
          return out;
        }
        this.emit({ type: 'ai_error', seat, action, message: `提交无效：${error}` }, SPECTATOR);
        prompt = invalidInstruction(action, error);
      }
    } finally {
      this.liveScope.delete(seat);
    }
    this.emit({ type: 'ai_error', seat, action, message: '多次提交无效，裁判代为执行默认动作' }, SPECTATOR);
    return fallback();
  }

  // ---------- 校验 ----------

  // AI 必须发言；人类可以只写一个"过"之类，但不能空着
  private static needSpeech: Validator = (o) => (o.speech && o.speech.trim() ? null : '缺少 speech');

  // 选一个座位：必须在 options 里；allowZero 时 0 或不填表示不选
  private static seatField(value: number | undefined, options: number[], allowZero: boolean, field: string): string | null {
    if (value === undefined || value === 0) return allowZero ? null : `缺少 ${field}`;
    if (!options.includes(value)) return `${field} 必须是以下座位之一：${options.join('、')}${allowZero ? '（或 0）' : ''}`;
    return null;
  }

  // ---------- 主流程 ----------

  async run(): Promise<void> {
    try {
      const winner = await this.play();
      this.setStatus('finished', winner);
    } catch (err) {
      if (err instanceof GameAborted || this.abortController.signal.aborted) {
        this.setStatus('aborted');
      } else {
        console.error(`[game ${this.id}]`, err);
        this.setStatus('error');
      }
    }
  }

  private async play(): Promise<Team> {
    const { players, setup } = this.record;
    this.emit({ type: 'game_start', players, setup }, PUBLIC);
    for (let seat = 1; seat <= this.n; seat++) {
      const { text, marks } = knowledgeFor(seat, this.roles);
      this.emit({ type: 'role_assigned', seat, role: this.roles[seat], knowledge: text, marks }, only(seat));
    }

    try {
      for (let night = 1; night <= MAX_DAYS; night++) {
        const deaths = await this.nightPhase(night);
        await this.dayPhase(night, deaths);
      }
      throw new Error(`对局超过 ${MAX_DAYS} 天仍未结束`);
    } catch (err) {
      if (err instanceof GameOver) return this.finish(err.winner, err.reason);
      throw err;
    }
  }

  private finish(winner: Team, reason: string): Team {
    this.emit({ type: 'game_over', winner, reason, roles: this.roles }, PUBLIC);
    return winner;
  }

  private checkWin(): void {
    const result = checkWinner(this.roles, this.alive);
    if (result) throw new GameOver(result.winner, result.reason);
  }

  // 夜里的一步：有人类玩家时至少等一段时间（这一步的角色已经出局也照常等）
  private async nightStep<T>(step: () => Promise<T>): Promise<T> {
    const minDelay = this.hasHumans ? sleep(NIGHT_MIN_MS + Math.random() * NIGHT_JITTER_MS) : Promise.resolve();
    const [result] = await Promise.all([step(), minDelay]);
    this.checkAborted();
    return result;
  }

  // ---------- 夜晚 ----------

  // 返回当晚死亡的玩家（还没公布，也还没从存活名单里移除）
  private async nightPhase(night: number): Promise<Death[]> {
    this.emit({ type: 'night_start', night }, PUBLIC);
    const victim = await this.nightStep(() => this.wolfStep(night));
    const { saved, poisoned } = await this.nightStep(() => this.witchStep(night, victim));
    await this.nightStep(() => this.seerStep(night));

    const deaths = new Map<number, DeathCause>();
    if (victim !== saved) deaths.set(victim, 'wolf');
    if (poisoned) deaths.set(poisoned, 'poison'); // 同时被袭击和被毒时按毒死算，猎人不能开枪
    const list = [...deaths.entries()].sort(([a], [b]) => a - b).map(([seat, cause]) => ({ seat, cause }));
    this.emit({ type: 'night_summary', night, deaths: list }, SPECTATOR);
    return list.map((d) => ({ ...d, lastWords: night === 1 })); // 只有第一晚的死者有遗言
  }

  // 狼人依次发言并提议目标，以多数为准，平票随机
  private async wolfStep(night: number): Promise<number> {
    const wolves = this.aliveWolves();
    const targets = this.aliveSeats();
    const proposals: Record<number, number> = {};
    for (const seat of wolves) {
      const out = await this.ask(
        seat,
        'wolf_discuss',
        { night, targets },
        (o) => (wolves.length > 1 && !this.isHuman(seat) && !o.speech?.trim() ? '缺少 speech' : Game.seatField(o.target, targets, false, 'target')),
        () => ({ action: 'wolf_discuss', target: pick(targets.filter((s) => !isWolf(this.roles[s]))) }),
      );
      if (out.speech?.trim()) this.emit({ type: 'speech', seat, kind: 'wolf', text: out.speech }, group(wolves));
      proposals[seat] = out.target!;
    }
    const counts = new Map<number, number>();
    for (const t of Object.values(proposals)) counts.set(t, (counts.get(t) ?? 0) + 1);
    const most = Math.max(...counts.values());
    const target = pick([...counts.entries()].filter(([, c]) => c === most).map(([t]) => t));
    this.emit({ type: 'wolf_kill', night, target, votes: proposals }, group(wolves));
    return target;
  }

  private async witchStep(night: number, victim: number): Promise<{ saved: number | null; poisoned: number | null }> {
    const witch = this.seatOf('witch');
    if (!this.alive.has(witch)) return { saved: null, poisoned: null };

    const canSave = this.antidote && victim !== witch;
    const canPoison = this.poison;
    const targets = this.aliveSeats().filter((s) => s !== witch);
    this.emit(
      { type: 'witch_info', night, victim: this.antidote ? victim : null, antidote: this.antidote, poison: this.poison },
      only(witch),
    );
    const out = await this.ask(
      witch,
      'witch',
      { night, victim: this.antidote ? victim : null, canSave, canPoison, targets },
      (o) => {
        if (o.save && !canSave) return this.antidote ? '解药不能救自己' : '解药已经用完';
        if (o.poison && !canPoison) return '毒药已经用完';
        if (o.save && o.poison) return '同一晚只能用一瓶药';
        return Game.seatField(o.poison, targets, true, 'poison');
      },
      () => ({ action: 'witch', save: false, poison: 0 }),
    );
    const saved = out.save ? victim : null;
    const poisoned = out.poison || null;
    if (saved) this.antidote = false;
    if (poisoned) this.poison = false;
    this.emit({ type: 'witch_action', night, save: saved, poison: poisoned }, only(witch));
    return { saved, poisoned };
  }

  private async seerStep(night: number): Promise<void> {
    const seer = this.seatOf('seer');
    if (!this.alive.has(seer)) return;
    const targets = this.aliveSeats().filter((s) => s !== seer);
    const checked = new Set(
      this.events.filter((e) => e.type === 'seer_check').map((e) => (e.type === 'seer_check' ? e.target : 0)),
    );
    const out = await this.ask(
      seer,
      'seer',
      { night, targets },
      (o) => Game.seatField(o.target, targets, false, 'target'),
      () => ({ action: 'seer', target: pick(targets.filter((s) => !checked.has(s))) ?? pick(targets) }),
    );
    const target = out.target!;
    this.emit({ type: 'seer_check', night, target, result: isWolf(this.roles[target]) ? 'wolf' : 'good' }, only(seer));
  }

  // ---------- 白天 ----------

  private async dayPhase(day: number, nightDeaths: Death[]): Promise<void> {
    this.emit({ type: 'day_start', day }, PUBLIC);
    if (day === 1) await this.sheriffElection();

    const dead = nightDeaths.map((d) => d.seat);
    this.emit({ type: 'night_result', night: day, dead }, PUBLIC);
    for (const seat of dead) this.alive.delete(seat);
    this.checkWin();
    for (const d of nightDeaths) await this.dying(d);

    await this.discussion(day, dead);
    await this.exileVote(day);
  }

  // 第一天竞选警长：同时决定是否上警 → 警上发言 → 警下投票（平票 PK 一次）
  private async sheriffElection(): Promise<void> {
    this.emit({ type: 'sheriff_start' }, PUBLIC);
    const everyone = this.aliveSeats();
    const decisions = await Promise.all(
      everyone.map((seat) =>
        this.ask(
          seat,
          'run_for_sheriff',
          {},
          (o) => (typeof o.run === 'boolean' ? null : '缺少 run'),
          () => ({ action: 'run_for_sheriff', run: false }),
        ),
      ),
    );
    const candidates = everyone.filter((_, i) => decisions[i].run);
    this.emit({ type: 'sheriff_candidates', candidates }, PUBLIC);

    const elect = (sheriff: number | null, reason: string) => {
      this.sheriff = sheriff;
      this.emit({ type: 'sheriff_result', sheriff, reason }, PUBLIC);
    };
    if (candidates.length === 0) return elect(null, '没有人上警');
    if (candidates.length === everyone.length) return elect(null, '所有人都上警，没有人投票');
    if (candidates.length === 1) return elect(candidates[0], '只有一人上警');

    // 从随机一位候选人开始，按座位顺时针发言
    const order = seatsFrom(pick(candidates), this.n).filter((s) => candidates.includes(s));
    for (const seat of order) await this.speak(seat, 'campaign', 'campaign', {});

    const voters = everyone.filter((s) => !candidates.includes(s));
    const first = await this.sheriffVote(1, voters, candidates);
    if (first.pk.length === 0) return elect(first.winner, first.winner ? '得票最多' : '警下全部弃票');

    for (const seat of first.pk) await this.speak(seat, 'pk_speech', 'pk', { pk: first.pk, pkFor: 'sheriff' });
    const second = await this.sheriffVote(2, voters, first.pk);
    if (second.winner) return elect(second.winner, 'PK 后得票最多');
    elect(null, second.pk.length ? 'PK 后再次平票，警徽流失' : 'PK 时警下全部弃票，警徽流失');
  }

  private async sheriffVote(round: number, voters: number[], options: number[]): Promise<{ winner: number | null; pk: number[] }> {
    const info: ActionInfo = round > 1 ? { pk: options, targets: options } : { targets: options };
    const votes = await this.collectVotes('sheriff_vote', voters, info, () => options);
    const { tally, top } = Game.tally(votes, () => 1);
    const pk = top.length > 1 ? top : [];
    this.emit({ type: 'sheriff_vote', round, votes, tally, pk }, PUBLIC);
    return { winner: top.length === 1 ? top[0] : null, pk };
  }

  // 同时投票；0 表示弃票。optionsFor 给出每个投票人可以投的座位
  private async collectVotes(
    action: 'sheriff_vote' | 'exile_vote',
    voters: number[],
    info: ActionInfo,
    optionsFor: (voter: number) => number[],
  ): Promise<Record<number, number | null>> {
    const outs = await Promise.all(
      voters.map((seat) => {
        const options = optionsFor(seat);
        return this.ask(
          seat,
          action,
          { ...info, targets: options, ...(action === 'exile_vote' && seat === this.sheriff ? { isSheriff: true } : {}) },
          (o) => Game.seatField(o.target, options, true, 'target'),
          () => ({ action, target: 0 }),
        );
      }),
    );
    return Object.fromEntries(voters.map((seat, i) => [seat, outs[i].target || null]));
  }

  // 计票：返回每人的得票和得票最多的座位（没有有效票时 top 为空）
  private static tally(votes: Record<number, number | null>, weight: (voter: number) => number) {
    const tally: Record<number, number> = {};
    for (const [voter, target] of Object.entries(votes)) {
      if (target) tally[target] = (tally[target] ?? 0) + weight(Number(voter));
    }
    const most = Math.max(0, ...Object.values(tally));
    const top = most > 0 ? Object.keys(tally).map(Number).filter((s) => tally[s] === most).sort((a, b) => a - b) : [];
    return { tally, top };
  }

  private async speak(seat: number, action: 'campaign' | 'speak' | 'pk_speech', kind: 'campaign' | 'discuss' | 'pk', info: ActionInfo) {
    const out = await this.ask(seat, action, info, Game.needSpeech, () => ({ action, speech: '（过）' }));
    this.emit({ type: 'speech', seat, kind, text: out.speech! }, PUBLIC);
  }

  // 出局：处理完遗言等最后的动作后进入旁观视角。等处理完再切换，否则猎人开枪、警长移交警徽前就能看到所有身份
  private async dying(d: Death): Promise<void> {
    await this.lastActs(d);
    this.observers.add(d.seat);
    this.broadcast({ kind: 'game', summary: this.summary() }); // 让这个玩家的推送重新判断能看到什么
  }

  // 出局时：移交警徽 → 遗言 → 猎人开枪（被带走的人接着处理）
  private async lastActs(d: Death): Promise<void> {
    const canShoot = this.roles[d.seat] === 'hunter' && d.cause !== 'poison';
    const hasBadge = this.sheriff === d.seat;
    if (!d.lastWords && !canShoot && !hasBadge) return;

    const targets = this.aliveSeats();
    const deathNote =
      d.cause === 'exile'
        ? '你被放逐出局'
        : d.cause === 'shot'
          ? '你被猎人开枪带走'
          : canShoot || this.roles[d.seat] !== 'hunter'
            ? '你昨晚出局了'
            : '你昨晚被女巫毒死，不能开枪';
    const out = await this.ask(
      d.seat,
      'dying',
      { lastWords: d.lastWords, canShoot, hasBadge, targets, deathNote },
      (o) => {
        if (d.lastWords && !this.isHuman(d.seat) && !o.speech?.trim()) return '缺少 speech（遗言）';
        return (
          (canShoot ? Game.seatField(o.shoot, targets, true, 'shoot') : null) ??
          (hasBadge ? Game.seatField(o.badge, targets, true, 'badge') : null)
        );
      },
      () => ({ action: 'dying', speech: d.lastWords ? '（没有留下遗言）' : undefined, shoot: 0, badge: 0 }),
    );

    if (hasBadge) {
      this.sheriff = out.badge || null;
      this.emit({ type: 'badge_passed', from: d.seat, to: this.sheriff }, PUBLIC);
    }
    if (d.lastWords && out.speech?.trim()) this.emit({ type: 'speech', seat: d.seat, kind: 'last_words', text: out.speech }, PUBLIC);
    if (canShoot && out.shoot) {
      const target = out.shoot;
      this.emit({ type: 'hunter_shot', hunter: d.seat, target }, PUBLIC);
      this.alive.delete(target);
      this.checkWin();
      await this.dying({ seat: target, cause: 'shot', lastWords: true });
    }
  }

  // 白天发言：有警长时由警长决定方向、警长最后发言；没有警长时从昨晚第一位死者的下一位开始顺时针
  private async discussion(day: number, nightDead: number[]): Promise<void> {
    const alive = this.aliveSeats();
    const clockwise = (start: number) => seatsFrom(start, this.n).filter((s) => this.alive.has(s));
    let order: number[];
    let chosenBy: number | null = null;

    if (this.sheriff !== null && this.alive.has(this.sheriff)) {
      const sheriff = this.sheriff;
      const after = clockwise(nextSeat(sheriff, this.n)).filter((s) => s !== sheriff);
      const cw = after[0];
      const ccw = after[after.length - 1];
      const out = await this.ask(
        sheriff,
        'speech_order',
        { day, cw, ccw },
        (o) => (o.direction === 'cw' || o.direction === 'ccw' ? null : 'direction 必须是 cw 或 ccw'),
        () => ({ action: 'speech_order', direction: 'cw' }),
      );
      order = [...(out.direction === 'ccw' ? [...after].reverse() : after), sheriff];
      chosenBy = sheriff;
    } else {
      const firstDead = nightDead.length ? Math.min(...nightDead) : null;
      const start = firstDead !== null ? clockwise(nextSeat(firstDead, this.n))[0] : pick(alive);
      order = clockwise(start);
    }

    this.emit({ type: 'discussion_start', day, order, chosenBy }, PUBLIC);
    for (const seat of order) await this.speak(seat, 'speak', 'discuss', { day });
  }

  // 放逐投票：警长 1.5 票；平票 PK 一次，再平票无人出局
  private async exileVote(day: number): Promise<void> {
    const voters = this.aliveSeats().filter((s) => s !== this.idiotRevealed);
    const weight = (voter: number) => (voter === this.sheriff ? 1.5 : 1);

    const votes = await this.collectVotes('exile_vote', voters, { day }, (voter) => this.aliveSeats().filter((s) => s !== voter));
    const first = Game.tally(votes, weight);
    const pk = first.top.length > 1 ? first.top : [];
    let result = first.top.length === 1 ? first.top[0] : null;
    this.emit({ type: 'exile_vote', day, round: 1, votes, tally: first.tally, pk, result }, PUBLIC);

    if (pk.length) {
      for (const seat of pk) await this.speak(seat, 'pk_speech', 'pk', { day, pk, pkFor: 'exile' });
      const pkVoters = voters.filter((s) => !pk.includes(s));
      const pkVotes = await this.collectVotes('exile_vote', pkVoters, { day, pk }, () => pk);
      const second = Game.tally(pkVotes, weight);
      result = second.top.length === 1 ? second.top[0] : null;
      this.emit({ type: 'exile_vote', day, round: 2, votes: pkVotes, tally: second.tally, pk: [], result }, PUBLIC);
    }

    if (result !== null) await this.exile(result);
  }

  private async exile(seat: number): Promise<void> {
    // 白痴第一次被放逐时翻牌免死，失去投票权；他是警长的话警徽流失
    if (this.roles[seat] === 'idiot' && this.idiotRevealed === null) {
      this.idiotRevealed = seat;
      this.emit({ type: 'idiot_revealed', seat }, PUBLIC);
      if (this.sheriff === seat) {
        this.sheriff = null;
        this.emit({ type: 'badge_passed', from: seat, to: null }, PUBLIC);
      }
      return;
    }
    this.emit({ type: 'exiled', seat }, PUBLIC);
    this.alive.delete(seat);
    this.checkWin();
    await this.dying({ seat, cause: 'exile', lastWords: true });
  }

  // ---------- 赛后交流 ----------

  // 赛后交流只能在对局正常结束后开启；一轮结束后可以再开一轮
  canStartPostgame(): boolean {
    return this.record.status === 'finished' && this.record.postgame !== 'running';
  }

  private setPostgame(postgame: PostgameStatus): void {
    this.record.postgame = postgame;
    this.store.saveRecord(this.record);
    this.broadcast({ kind: 'game', summary: this.summary() });
  }

  // 本局结果和全部身份，给 AI 做赛后交流的背景
  private recap(): string {
    const over = this.events.findLast((e) => e.type === 'game_over');
    if (over?.type !== 'game_over') return '';
    const name = (seat: number) => this.record.players.find((p) => p.seat === seat)?.name ?? `${seat}号`;
    const roles = seatsFrom(1, this.n)
      .map((s) => `${s}号「${name(s)}」${ROLE_NAME[over.roles[s]]}`)
      .join('，');
    return `${TEAM_NAME[over.winner]}阵营获胜（${over.reason}）。全部身份：${roles}。`;
  }

  // 一轮赛后交流：每人按座位顺序发言一次（出局的玩家也参加）；人类可以跳过（提交空发言）
  async runPostgame(): Promise<void> {
    const round = this.events.filter((e) => e.type === 'postgame_start').length + 1;
    this.abortController = new AbortController();
    this.setPostgame('running');
    this.emit({ type: 'postgame_start', round }, PUBLIC);
    const info: ActionInfo = { recap: this.recap(), round };
    try {
      for (const seat of seatsFrom(1, this.n)) {
        const out = await this.ask(
          seat,
          'reflect',
          info,
          this.isHuman(seat) ? () => null : Game.needSpeech,
          () => ({ action: 'reflect', speech: '（没有发言）' }),
        );
        if (out.speech?.trim()) this.emit({ type: 'speech', seat, kind: 'reflect', text: out.speech }, PUBLIC);
      }
    } catch (err) {
      if (!(err instanceof GameAborted) && !this.abortController.signal.aborted) {
        console.error(`[game ${this.id}] postgame`, err);
      }
    } finally {
      this.emit({ type: 'postgame_end' }, PUBLIC);
      this.setPostgame('done');
    }
  }
}

