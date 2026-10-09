// 不调用模型：12 个脚本"人类"随机行动跑很多局，检查规则、结算和信息可见性
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETUP } from '../shared/setup.ts';
import {
  ROLE_TEAM,
  seesEverything,
  type ActionSubmission,
  type GameEvent,
  type HumanRequest,
  type Role,
  type RolePreference,
  type StreamMessage,
} from '../shared/types.ts';
import { Game } from '../server/game/engine.ts';
import { checkWinner, isWolf } from '../server/game/rules.ts';
import { GameStore } from '../server/game/store.ts';
import { messageVisible } from '../server/game/visibility.ts';
import { deriveBoard } from '../web/derive.ts';

const dir = mkdtempSync(join(tmpdir(), 'aiwerewolf-sim-'));
const store = new GameStore(dir);
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const chance = (p: number) => Math.random() < p;
const N = SETUP.length;
const seats = Array.from({ length: N }, (_, i) => i + 1);

function fail(msg: string): never {
  throw new Error(msg);
}

function answer(r: HumanRequest): ActionSubmission {
  const t = r.targets ?? [];
  switch (r.action) {
    case 'wolf_discuss':
      return { action: r.action, speech: chance(0.2) ? undefined : '刀谁' };
    case 'wolf_vote':
      return { action: r.action, target: pick(t) };
    case 'witch':
      if (r.canSave && chance(0.5)) return { action: r.action, save: true };
      if (r.canPoison && chance(0.3)) return { action: r.action, poison: pick(t) };
      return { action: r.action };
    case 'seer':
      return { action: r.action, target: pick(t) };
    case 'run_for_sheriff':
      return { action: r.action, run: chance(0.35) };
    case 'campaign':
    case 'speak':
    case 'pk_speech':
      return { action: r.action, speech: '我是好人' };
    case 'sheriff_vote':
    case 'exile_vote':
      return { action: r.action, target: chance(0.1) ? 0 : pick(t) };
    case 'speech_order':
      return { action: r.action, direction: pick(['cw', 'ccw']) };
    case 'dying':
      return {
        action: r.action,
        ...(r.lastWords ? { speech: '我的遗言' } : {}),
        ...(r.canShoot ? { shoot: chance(0.8) ? pick(t) : 0 } : {}),
        ...(r.hasBadge ? { badge: chance(0.8) ? pick(t) : 0 } : {}),
      };
    case 'reflect':
      return { action: r.action, speech: r.seat % 3 === 0 ? '' : '这局很好玩' };
  }
}

const coverage: Record<string, number> = {};
const hit = (k: string) => (coverage[k] = (coverage[k] ?? 0) + 1);

async function simulate(prefs: RolePreference[]): Promise<Game> {
  const game = Game.create(store, { humans: prefs.map((role, i) => ({ name: `玩家${String.fromCharCode(65 + i)}`, role })) });
  const { roles } = game.record;
  if (Object.values(roles).sort().join() !== [...SETUP].sort().join()) fail('roles do not match setup');
  prefs.forEach((p, i) => {
    const seat = game.record.players.find((x) => x.name === `玩家${String.fromCharCode(65 + i)}`)!.seat;
    if (p !== 'random' && p !== roles[seat] && p !== ROLE_TEAM[roles[seat]]) fail(`pref ${p} got ${roles[seat]}`);
  });

  // 每个座位实际收到的推送
  const received: Record<number, StreamMessage[]> = {};
  const alive = new Set(seats);
  let revealedIdiot: number | null = null;
  let wolfVoting = false; // 这一夜狼人是否已经开始投票
  game.bus.on('message', (msg: StreamMessage) => {
    for (const s of seats) if (messageVisible(msg, { kind: 'player', seat: s })) (received[s] ??= []).push(msg);
    if (msg.kind === 'event') {
      const e = msg.event;
      if (e.type === 'night_result') e.dead.forEach((s) => alive.delete(s));
      if (e.type === 'exiled') alive.delete(e.seat);
      if (e.type === 'hunter_shot' && e.target) alive.delete(e.target);
      if (e.type === 'idiot_revealed') revealedIdiot = e.seat;
      if (e.type === 'night_start') wolfVoting = false;
    }
    if (msg.kind !== 'request') return;
    const r = msg.request;
    // 狼人先全部发言，再统一投票
    if (r.action === 'wolf_vote') wolfVoting = true;
    if (r.action === 'wolf_discuss' && wolfVoting) fail('wolf asked to discuss after voting started');
    // 出局的玩家只会被问遗言/开枪/警徽和赛后感想；翻牌的白痴不再投票
    if (!['dying', 'reflect'].includes(r.action) && !alive.has(r.seat)) {
      // 第一天竞选警长时，第一晚的死者还没公布，可以参加
      if (!['run_for_sheriff', 'campaign', 'sheriff_vote', 'pk_speech'].includes(r.action)) fail(`dead seat ${r.seat} asked ${r.action}`);
    }
    if (r.action === 'exile_vote' && r.seat === revealedIdiot) fail('revealed idiot asked to vote');
    // 出局的玩家要等遗言、开枪、移交警徽都处理完才进入旁观视角，进入后不会再被要求行动
    if (r.action !== 'reflect' && game.isObserver(r.seat)) fail(`observer ${r.seat} asked ${r.action}`);
    if (r.targets?.some((t) => !alive.has(t)) && !['run_for_sheriff', 'sheriff_vote', 'pk_speech', 'campaign'].includes(r.action)) {
      fail(`${r.action} offered dead targets ${r.targets}`);
    }
    setTimeout(() => {
      const err = game.submitHuman(r.seat, answer(r));
      if (err) fail(`rejected valid answer for ${r.action}: ${err}`);
    }, 0);
  });

  await game.run();
  if (game.record.status !== 'finished') fail(`status ${game.record.status}`);
  checkGame(game.events, roles);
  // 旁观者都是已出局的玩家
  for (const s of seats) {
    if (game.isObserver(s) && alive.has(s)) fail(`alive seat ${s} became an observer`);
    if (game.isObserver(s)) hit('observer');
  }
  checkVisibility(game.events, received, roles);
  return game;
}

// 规则检查：胜负、女巫用药、猎人开枪、警长、投票
function checkGame(events: GameEvent[], roles: Record<number, Role>): void {
  const alive = new Set(seats);
  let sheriff: number | null = null;
  let revealedIdiot: number | null = null;
  let antidote = 1;
  let poison = 1;
  const poisoned = new Set<number>();
  // 同一批死亡（一晚的死者）是同时发生的：这一批之前不能已经分出胜负
  const kill = (...batch: number[]) => {
    if (checkWinner(roles, alive)) fail('game continued after a win condition');
    for (const seat of batch) {
      if (!alive.has(seat)) fail(`seat ${seat} died twice`);
      alive.delete(seat);
    }
  };

  for (const e of events) {
    switch (e.type) {
      case 'witch_action':
        if (e.save && e.poison) fail('witch used both potions in one night');
        if (e.save) {
          antidote--;
          hit('witch save');
          if (roles[e.save] === 'witch') fail('witch saved herself');
        }
        if (e.poison) {
          poison--;
          poisoned.add(e.poison);
          hit('witch poison');
        }
        if (antidote < 0 || poison < 0) fail('potion used twice');
        break;
      case 'wolf_kill': {
        // 每只存活的狼各投一票，目标是得票最多的之一
        const wolves = [...alive].filter((s) => isWolf(roles[s])).sort((a, b) => a - b);
        if (Object.keys(e.votes).map(Number).sort((a, b) => a - b).join() !== wolves.join()) fail('wolf votes do not match alive wolves');
        const counts: Record<number, number> = {};
        for (const t of Object.values(e.votes)) counts[t] = (counts[t] ?? 0) + 1;
        if (counts[e.target] !== Math.max(...Object.values(counts))) fail('wolf kill target was not the most voted');
        if (wolves.length === 1) hit('lone wolf');
        break;
      }
      case 'night_result':
        if (!e.dead.length) hit('peaceful night');
        kill(...e.dead);
        break;
      case 'sheriff_result':
        sheriff = e.sheriff;
        hit(e.sheriff ? 'sheriff elected' : 'no sheriff');
        break;
      case 'sheriff_vote':
        if (e.round > 1) hit('sheriff pk');
        break;
      case 'badge_passed':
        if (e.from !== sheriff) fail('badge passed by non-sheriff');
        if (e.to !== null && !alive.has(e.to)) fail('badge passed to a dead player');
        sheriff = e.to;
        hit(e.to ? 'badge passed' : 'badge destroyed');
        break;
      case 'hunter_shot':
        if (roles[e.hunter] !== 'hunter') fail('non-hunter shot');
        if (poisoned.has(e.hunter)) fail('poisoned hunter shot');
        if (e.target) kill(e.target);
        hit('hunter shot');
        break;
      case 'exile_vote': {
        if (e.round > 1) hit('exile pk');
        for (const voter of Object.keys(e.votes).map(Number)) {
          if (!alive.has(voter)) fail('dead player voted');
          if (voter === revealedIdiot) fail('revealed idiot voted');
        }
        // 计票：警长 1.5 票
        const tally: Record<number, number> = {};
        for (const [voter, t] of Object.entries(e.votes)) if (t) tally[t] = (tally[t] ?? 0) + (Number(voter) === sheriff ? 1.5 : 1);
        if (JSON.stringify(tally, Object.keys(tally).sort()) !== JSON.stringify(e.tally, Object.keys(e.tally).sort())) {
          fail(`tally mismatch ${JSON.stringify(tally)} vs ${JSON.stringify(e.tally)}`);
        }
        if (e.result === null && !e.pk.length) hit('nobody exiled');
        break;
      }
      case 'idiot_revealed':
        if (roles[e.seat] !== 'idiot') fail('non-idiot revealed');
        revealedIdiot = e.seat;
        hit('idiot revealed');
        break;
      case 'exiled':
        kill(e.seat);
        hit('exiled');
        break;
      case 'speech':
        if (e.kind === 'last_words') hit('last words');
        break;
      case 'game_over': {
        const expected = checkWinner(roles, alive);
        if (!expected || expected.winner !== e.winner) fail(`winner ${e.winner} but board says ${JSON.stringify(expected)}`);
        hit(`${e.winner} wins`);
        break;
      }
    }
  }
}

// 可见性：玩家只能收到公开信息和属于自己的信息
function checkVisibility(events: GameEvent[], received: Record<number, StreamMessage[]>, roles: Record<number, Role>): void {
  for (const seat of seats) {
    const wolf = isWolf(roles[seat]);
    for (const msg of received[seat] ?? []) {
      if (msg.kind === 'event') {
        const e = msg.event;
        if (e.type === 'role_assigned' && e.seat !== seat) fail(`seat ${seat} saw another role`);
        if (e.type === 'speech' && e.kind === 'wolf' && !wolf) fail(`non-wolf ${seat} saw wolf chat`);
        if (e.type === 'wolf_kill' && !wolf) fail(`non-wolf ${seat} saw wolf kill`);
        if ((e.type === 'witch_info' || e.type === 'witch_action') && roles[seat] !== 'witch') fail(`seat ${seat} saw witch info`);
        if (e.type === 'seer_check' && roles[seat] !== 'seer') fail(`seat ${seat} saw seer check`);
        if (['night_summary', 'thought', 'ai_usage', 'ai_error'].includes(e.type)) fail(`seat ${seat} saw ${e.type}`);
      }
      if (msg.kind === 'status' && msg.hidden && msg.seat !== seat) fail(`seat ${seat} saw hidden status of ${msg.seat}`);
      if (msg.kind === 'live' && msg.seats && !msg.seats.includes(seat)) fail(`seat ${seat} saw private live speech`);
    }
  }
  void events;
}

const prefPool: RolePreference[] = ['random', 'random', 'random', 'good', 'wolf', 'werewolf', 'seer', 'witch', 'hunter', 'idiot', 'villager'];
const GAMES = Number(process.env.GAMES ?? 300);
let last: Game | null = null;
for (let i = 0; i < GAMES; i++) {
  // 12 名人类，每人随机一个偏好；偏好无法满足时（比如两个人都选预言家）换一组
  let prefs: RolePreference[];
  do prefs = seats.map(() => pick(prefPool));
  while (!feasible(prefs));
  last = await simulate(prefs);
}
console.log(`${GAMES} games ok`);
console.log('coverage:', coverage);
const required = ['observer', 'witch save', 'witch poison', 'peaceful night', 'sheriff elected', 'no sheriff', 'sheriff pk', 'badge passed', 'badge destroyed', 'hunter shot', 'exile pk', 'nobody exiled', 'idiot revealed', 'exiled', 'last words', 'good wins', 'wolf wins'];
const missing = required.filter((k) => !coverage[k]);
if (missing.length) fail(`paths never exercised: ${missing.join(', ')}`);

function feasible(prefs: RolePreference[]): boolean {
  const pool = [...SETUP];
  for (const pass of [(p: RolePreference) => p in ROLE_TEAM, (p: RolePreference) => p === 'good' || p === 'wolf']) {
    for (const p of prefs.filter(pass)) {
      const i = pool.findIndex((r) => r === p || ROLE_TEAM[r] === p);
      if (i < 0) return false;
      pool.splice(i, 1);
    }
  }
  return true;
}

// 偏好无法满足时要报错
try {
  Game.create(store, { humans: [{ name: 'a', role: 'seer' }, { name: 'b', role: 'seer' }] });
  fail('duplicate seer was accepted');
} catch (e) {
  if ((e as Error).message.includes('duplicate')) throw e;
  console.log('duplicate pick rejected:', (e as Error).message);
}

// 赛后交流：可以开多轮；从磁盘恢复后状态一致
{
  const game = last!;
  for (let round = 1; round <= 2; round++) {
    if (!game.canStartPostgame()) fail('postgame should be available');
    await game.runPostgame();
  }
  const starts = game.events.filter((e) => e.type === 'postgame_start').map((e) => (e.type === 'postgame_start' ? e.round : 0));
  const reflects = game.events.filter((e) => e.type === 'speech' && e.kind === 'reflect').length;
  if (starts.join() !== '1,2' || reflects !== 2 * seats.filter((s) => s % 3 !== 0).length) fail('postgame wrong');
  const loaded = Game.load(store, game.id)!;
  if (loaded.events.length !== game.events.length || loaded.summary().postgame !== 'done') fail('load mismatch');
  console.log('postgame ok');
}

// 只给观众的内容：对局中玩家收不到，正常结束后玩家和观众一样都能收到
{
  const player = { kind: 'player', seat: 1 } as const;
  const hiddenEvent: StreamMessage = {
    kind: 'event',
    event: { type: 'seer_check', night: 1, target: 3, result: 'wolf', seq: 1, ts: 0, visibility: { kind: 'players', seats: [2] } },
  };
  const hiddenStatus: StreamMessage = { kind: 'status', seat: 2, action: 'seer', active: true, hidden: true };
  const wolfLive: StreamMessage = { kind: 'live', seat: 2, action: 'wolf_discuss', speech: '…', seats: [2, 5] };
  const during = seesEverything(player, 'running');
  const after = seesEverything(player, 'finished');
  if (during || !after || seesEverything(player, 'aborted') || !seesEverything(player, 'running', true)) fail('seesEverything wrong');
  for (const msg of [hiddenEvent, hiddenStatus, wolfLive]) {
    if (messageVisible(msg, player, during) || !messageVisible(msg, player, after)) fail(`${msg.kind} visibility wrong`);
  }
  if (!messageVisible(wolfLive, { kind: 'player', seat: 5 })) fail('wolf could not see wolf live speech');
  console.log('visibility ok');
}

// 费用：每条 ai_usage 记的是该 AI 会话的累计值，总费用按每个会话的增量相加
{
  const usage = (seq: number, seat: number, costUsd: number): GameEvent => ({
    type: 'ai_usage', seat, action: 'speak', costUsd, durationMs: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0,
    seq, ts: 0, visibility: { kind: 'spectator' },
  });
  const cost = deriveBoard([usage(1, 1, 0.1), usage(2, 2, 0.2), usage(3, 1, 0.25), usage(4, 2, 0.5), usage(5, 1, 0.05)], {
    kind: 'spectator',
  }).usage.costUsd;
  if (Math.abs(cost - 0.8) > 1e-9) fail(`cost total wrong: ${cost}`);
  console.log('cost accounting ok');
}

// 中途被停掉的赛后交流：重启后补上结束事件；事件文件写坏时也不能抛错
{
  const record = store.listRecords().find((r) => r.status === 'finished')!;
  record.postgame = 'running';
  store.saveRecord(record);
  appendFileSync(join(dir, record.id, 'events.jsonl'), '{"type":"spee');
  Game.recoverInterrupted(store);
  if (store.loadRecord(record.id)!.postgame !== 'done') fail('corrupt events blocked postgame recovery');
  console.log('recovery ok');
}
