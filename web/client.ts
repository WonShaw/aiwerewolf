import type { ActionSubmission, CreateGameRequest, CreateGameResponse, GameSummary } from '../shared/types.ts';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `请求失败（${res.status}）`);
  return body as T;
}

export const api = {
  listGames: () => request<GameSummary[]>('/api/games'),
  createGame: (req: CreateGameRequest) =>
    request<CreateGameResponse>('/api/games', { method: 'POST', body: JSON.stringify(req) }),
  act: (id: string, token: string, submission: ActionSubmission) =>
    request<{ ok: true }>(`/api/games/${id}/act`, { method: 'POST', body: JSON.stringify({ token, submission }) }),
  deleteGame: (id: string) => request<{ ok: true; sessions: number }>(`/api/games/${id}`, { method: 'DELETE' }),
  deleteAllGames: () => request<{ ok: true; deleted: string[]; sessions: number }>('/api/games', { method: 'DELETE' }),
  startPostgame: (id: string, token?: string) =>
    request<{ ok: true }>(`/api/games/${id}/postgame`, { method: 'POST', body: JSON.stringify({ token }) }),
  stop: (id: string, token?: string) =>
    request<{ ok: true }>(`/api/games/${id}/stop`, { method: 'POST', body: JSON.stringify({ token }) }),
};

// 人类玩家的凭证保存在本机浏览器里，方便回到对局
const TOKENS_KEY = 'aiwerewolf.tokens';

export interface SavedSeat {
  seat: number;
  name: string;
  token: string;
}

export function loadSeats(): Record<string, SavedSeat[]> {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function saveSeats(gameId: string, seats: SavedSeat[]): void {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify({ ...loadSeats(), [gameId]: seats }));
  } catch {
    // 存不了也不影响游戏，只是回到大厅后找不到入口
  }
}

export function gameUrl(id: string, token?: string): string {
  const params = new URLSearchParams({ game: id });
  if (token) params.set('token', token);
  return `${location.origin}${location.pathname}?${params}`;
}

// 通过 localhost 打开时，生成的链接在别的电脑上打不开
export function isLoopbackHost(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

// 记住开局时的完整设置（包括人类选的身份），"再来一局"时沿用。只存在创建者自己的浏览器里
const REQUEST_KEY = 'aiwerewolf.requests';

export function loadRequest(gameId: string): CreateGameRequest | null {
  try {
    return JSON.parse(localStorage.getItem(REQUEST_KEY) ?? '{}')[gameId] ?? null;
  } catch {
    return null;
  }
}

export async function createGame(req: CreateGameRequest): Promise<CreateGameResponse> {
  const res = await api.createGame(req);
  try {
    const all = JSON.parse(localStorage.getItem(REQUEST_KEY) ?? '{}');
    localStorage.setItem(REQUEST_KEY, JSON.stringify({ ...all, [res.summary.id]: req }));
  } catch {
    // 存不了只影响"再来一局"沿用身份选择
  }
  return res;
}

// 删除对局后，清掉本机为它保存的专属链接、开局设置和身份标记
export function forgetGame(gameId: string): void {
  try {
    for (const key of [TOKENS_KEY, REQUEST_KEY]) {
      const all = JSON.parse(localStorage.getItem(key) ?? '{}');
      delete all[gameId];
      localStorage.setItem(key, JSON.stringify(all));
    }
    const guessPrefix = `aiwerewolf.guesses.${gameId}.`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(guessPrefix)) localStorage.removeItem(key);
    }
  } catch {
    // 忽略
  }
}
