import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type {
  ActionSubmission,
  CreateGameRequest,
  HumanSeatRequest,
  CreateGameResponse,
  GameSummary,
  StreamMessage,
  Viewer,
} from '../shared/types.ts';
import { seesEverything } from '../shared/types.ts';
import { validateHumanNames } from '../shared/names.ts';
import { SETUP } from '../shared/setup.ts';
import { deleteAISession } from './ai/player.ts';
import { Game } from './game/engine.ts';
import { GameStore, type GameRecord } from './game/store.ts';
import { messageVisible } from './game/visibility.ts';

const PORT = Number(process.env.AIWEREWOLF_API_PORT ?? 8788);
const WEB_DIST = join(import.meta.dirname, '..', 'dist', 'web');

const store = new GameStore();
const games = new Map<string, Game>(); // 本次进程里创建的对局

// 进程重启后，之前没跑完的对局和赛后交流已无法继续，收尾
Game.recoverInterrupted(store);

function recordSummary(r: GameRecord): GameSummary {
  return {
    id: r.id,
    createdAt: r.createdAt,
    status: r.status,
    winner: r.winner,
    players: r.players,
    hasHumans: Object.keys(r.humanTokens ?? {}).length > 0,
    setup: r.setup ?? SETUP,
    postgame: r.postgame ?? 'none',
  };
}

// 对局或赛后交流正在进行（都会调用 AI），同一时间只允许一个
function isBusy(g: Game): boolean {
  return g.record.status === 'running' || g.record.postgame === 'running';
}

function runningGame(): Game | undefined {
  return [...games.values()].find(isBusy);
}

// 内存里的对局；不在内存里就从磁盘恢复，这样所有观看者都能收到之后的推送（例如赛后交流）
function loadGame(id: string): Game | null {
  let game = games.get(id);
  if (!game) {
    game = Game.load(store, id) ?? undefined;
    if (game) games.set(id, game);
  }
  return game ?? null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return (text ? JSON.parse(text) : {}) as T;
}

// 根据凭证决定观看者身份：有人类玩家的对局，只能以玩家身份观看
function resolveViewer(record: GameRecord, token: string | null): Viewer | null {
  const tokens = record.humanTokens ?? {};
  if (token) {
    const entry = Object.entries(tokens).find(([, t]) => t === token);
    return entry ? { kind: 'player', seat: Number(entry[0]) } : null;
  }
  return Object.keys(tokens).length === 0 ? { kind: 'spectator' } : null;
}

function stream(req: IncomingMessage, res: ServerResponse, id: string, token: string | null): void {
  const game = loadGame(id);
  if (!game) return json(res, 404, { error: '对局不存在' });
  const viewer = resolveViewer(game.record, token);
  if (!viewer) return json(res, 403, { error: '这局有人类玩家参与，只能用玩家的专属链接查看' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // 观众一直能看到全部信息；玩家在出局后或对局正常结束后也能看到，和观众一样
  const seesAllNow = () =>
    seesEverything(viewer, game.record.status, viewer.kind === 'player' && game.isObserver(viewer.seat));
  let seesAll = seesAllNow();
  const send = (msg: StreamMessage) => {
    if (messageVisible(msg, viewer, seesAll)) res.write(`data: ${JSON.stringify(msg)}\n\n`);
  };

  // 推送完整的当前状态；前端收到 hello 会先清空再接收
  const sendAll = () => {
    send({ kind: 'hello', viewer, fullView: seesAll });
    send({ kind: 'game', summary: game.summary() });
    for (const event of game.events) send({ kind: 'event', event });

    for (const { seat, action, hidden } of game.actingNow()) send({ kind: 'status', seat, action, active: true, hidden });
    if (viewer.kind === 'player') {
      const pending = game.pendingRequestFor(viewer.seat);
      if (pending) send({ kind: 'request', request: pending });
    }
  };
  sendAll();

  // 出局或对局刚结束时重推一遍，之前没推给玩家的内容（其他人的身份、夜里的行动、思考摘要、调用统计）不用刷新页面也能看到
  const onMessage = (msg: StreamMessage) => {
    if (!seesAll && seesAllNow()) {
      seesAll = true;
      return sendAll();
    }
    send(msg);
  };
  game.bus.on('message', onMessage);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    game.bus.off('message', onMessage);
  });
}

async function createGame(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const running = runningGame();
  if (running) return json(res, 409, { error: '已有一局正在进行', id: running.id });

  const body = await readBody<Partial<CreateGameRequest>>(req);
  const setup = SETUP;
  const humans: HumanSeatRequest[] = (body.humans ?? []).map((h) => ({
    name: String(h?.name ?? '').trim(),
    role: h?.role ?? 'random',
  }));
  if (humans.length > setup.length) return json(res, 400, { error: `最多 ${setup.length} 名人类玩家` });
  const nameError = validateHumanNames(humans.map((h) => h.name));
  if (nameError) return json(res, 400, { error: nameError });
  const validPrefs = new Set<string>(['random', 'good', 'wolf', ...setup]);
  if (humans.some((h) => !validPrefs.has(h.role))) return json(res, 400, { error: '选择的身份不在本局配置里' });

  let game: Game;
  try {
    game = Game.create(store, { humans });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
  games.set(game.id, game);
  void game.run();

  const response: CreateGameResponse = {
    summary: game.summary(),
    seats: Object.entries(game.record.humanTokens).map(([seat, token]) => ({
      seat: Number(seat),
      name: game.record.players.find((p) => p.seat === Number(seat))!.name,
      token,
    })),
  };
  json(res, 201, response);
}

async function act(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const game = games.get(id);
  if (!game || !isBusy(game)) return json(res, 404, { error: '对局未在进行' });
  const body = await readBody<{ token: string; submission: ActionSubmission }>(req);
  const seat = game.seatForToken(body.token);
  if (seat === null) return json(res, 403, { error: '凭证无效' });
  const error = game.submitHuman(seat, body.submission);
  if (error) return json(res, 400, { error });
  json(res, 200, { ok: true });
}

// 删除一局的对局记录和这局所有 AI 的会话记录，返回删掉的会话数
async function removeGame(record: GameRecord): Promise<number> {
  let sessions = 0;
  for (const sessionId of Object.values(record.sessions ?? {})) {
    if (sessionId && (await deleteAISession(sessionId))) sessions++;
  }
  store.deleteGame(record.id);
  games.delete(record.id);
  return sessions;
}

// 删除一局。进行中的对局不能删
async function deleteGame(res: ServerResponse, id: string): Promise<void> {
  const loaded = games.get(id);
  if (loaded && isBusy(loaded)) return json(res, 409, { error: '进行中的对局不能删除，请先结束对局' });
  const record = loaded?.record ?? store.loadRecord(id);
  if (!record) return json(res, 404, { error: '对局不存在' });
  json(res, 200, { ok: true, sessions: await removeGame(record) });
}

// 删除全部对局，进行中的（包括正在赛后交流的）保留
async function deleteAllGames(res: ServerResponse): Promise<void> {
  const deleted: string[] = [];
  let sessions = 0;
  for (const r of store.listRecords()) {
    const loaded = games.get(r.id);
    if (loaded && isBusy(loaded)) continue;
    sessions += await removeGame(loaded?.record ?? r);
    deleted.push(r.id);
  }
  json(res, 200, { ok: true, deleted, sessions });
}

// 开启赛后交流：全 AI 对局谁都可以开，有人类的对局需要玩家凭证
async function startPostgame(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const game = loadGame(id);
  if (!game) return json(res, 404, { error: '对局不存在' });
  const body = await readBody<{ token?: string }>(req);
  if (game.hasHumans && (!body.token || game.seatForToken(body.token) === null)) {
    return json(res, 403, { error: '只有参与这局的玩家可以开启赛后交流' });
  }
  if (!game.canStartPostgame()) return json(res, 409, { error: '只有正常结束的对局才能开启赛后交流，并且上一轮要先结束' });
  const busy = runningGame();
  if (busy) return json(res, 409, { error: '已有一局正在进行，结束后再开启赛后交流', id: busy.id });
  void game.runPostgame();
  json(res, 200, { ok: true });
}

async function stop(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const game = games.get(id);
  if (!game || !isBusy(game)) return json(res, 404, { error: '对局未在进行' });
  const body = await readBody<{ token?: string }>(req);
  if (game.hasHumans && (!body.token || game.seatForToken(body.token) === null)) {
    return json(res, 403, { error: '只有参与这局的玩家可以结束对局' });
  }
  game.stop();
  json(res, 200, { ok: true });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res: ServerResponse, pathname: string): void {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端尚未构建：开发时请运行 npm run dev 并打开 http://localhost:5180');
    return;
  }
  let file = normalize(join(WEB_DIST, pathname));
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(WEB_DIST, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/api/games' && req.method === 'GET') {
    return json(res, 200, store.listRecords().map((r) => games.get(r.id)?.summary() ?? recordSummary(r)));
  }
  if (path === '/api/games' && req.method === 'POST') return createGame(req, res);
  if (path === '/api/games' && req.method === 'DELETE') return deleteAllGames(res);

  const del = /^\/api\/games\/([\w-]+)$/.exec(path);
  if (del && req.method === 'DELETE') return deleteGame(res, del[1]);

  const m = /^\/api\/games\/([\w-]+)\/(stream|act|stop|postgame)$/.exec(path);
  if (m) {
    const [, id, op] = m;
    if (op === 'stream' && req.method === 'GET') return stream(req, res, id, url.searchParams.get('token'));
    if (op === 'act' && req.method === 'POST') return act(req, res, id);
    if (op === 'stop' && req.method === 'POST') return stop(req, res, id);
    if (op === 'postgame' && req.method === 'POST') return startPostgame(req, res, id);
  }

  if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  serveStatic(res, path);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: String(err) });
  });
});

server.listen(PORT, () => {
  console.log(`AI Werewolf server listening on http://localhost:${PORT}`);
});
