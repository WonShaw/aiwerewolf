import { useEffect, useState } from 'react';
import { ROLE_ORDER, SETUP, SETUP_NAME, describeSetup, roleAbility } from '../shared/setup.ts';
import {
  ROLE_NAME,
  TEAM_NAME,
  type CreateGameResponse,
  type GameSummary,
  type HumanSeatRequest,
  type RolePreference,
} from '../shared/types.ts';
import { MAX_NAME_LENGTH, defaultHumanName, validateHumanNames } from '../shared/names.ts';
import { api, createGame, forgetGame, gameUrl, isLoopbackHost, loadSeats, type SavedSeat } from './client.ts';

interface Props {
  onOpen: (gameId: string, token?: string) => void;
  onCreated: (res: CreateGameResponse) => void;
  created: { id: string; seats: SavedSeat[] } | null; // 刚创建的多人对局，需要展示各自的链接
}

const STATUS_LABEL = { running: '进行中', finished: '已结束', aborted: '已中止', error: '出错' } as const;

// 大厅表单记在本机浏览器里，下次打开沿用
const FORM_KEY = 'aiwerewolf.lobbyForm';
interface LobbyForm {
  mode: 'ai' | 'human';
  humans: HumanSeatRequest[];
}
const DEFAULT_FORM: LobbyForm = {
  mode: 'ai',
  humans: [{ name: defaultHumanName(0), role: 'random' }],
};

function loadForm(): LobbyForm {
  try {
    return { ...DEFAULT_FORM, ...JSON.parse(localStorage.getItem(FORM_KEY) ?? '{}') };
  } catch {
    return DEFAULT_FORM;
  }
}

const PREF_OPTIONS: RolePreference[] = ['random', 'good', 'wolf', ...ROLE_ORDER];

function prefLabel(p: RolePreference): string {
  if (p === 'random') return '随机';
  if (p === 'good') return '好人（随机）';
  if (p === 'wolf') return '狼人';
  return ROLE_NAME[p];
}

export function Lobby({ onOpen, onCreated, created }: Props) {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [form, setForm] = useState<LobbyForm>(loadForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seats = loadSeats();
  const { mode, humans } = form;

  useEffect(() => {
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(form));
    } catch {
      // 忽略
    }
  }, [form]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listGames()
        .then((g) => alive && setGames(g))
        .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const update = (patch: Partial<LobbyForm>) => setForm((f) => ({ ...f, ...patch }));
  const setCount = (n: number) =>
    update({ humans: Array.from({ length: n }, (_, i) => humans[i] ?? { name: defaultHumanName(i), role: 'random' }) });
  const setHuman = (i: number, patch: Partial<HumanSeatRequest>) =>
    update({ humans: humans.map((h, j) => (j === i ? { ...h, ...patch } : h)) });

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const req = { humans: mode === 'ai' ? [] : humans.map((h) => ({ ...h, name: h.name.trim() })) };
      onCreated(await createGame(req));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = async (g: GameSummary) => {
    const when = new Date(g.createdAt).toLocaleString();
    if (!confirm(`删除 ${when} 的这局？\n对局记录和 AI 的会话记录都会被删除，无法恢复。`)) return;
    setDeleting(g.id);
    try {
      await api.deleteGame(g.id);
      forgetGame(g.id);
      setGames((list) => list.filter((x) => x.id !== g.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

  // 删除全部：进行中的对局（包括正在赛后交流的）保留
  const [deletingAll, setDeletingAll] = useState(false);
  const deletable = games.filter((g) => g.status !== 'running' && g.postgame !== 'running');
  const removeAll = async () => {
    const kept = games.length - deletable.length;
    const note = kept ? `\n进行中的 ${kept} 局会保留。` : '';
    if (!confirm(`删除全部 ${deletable.length} 局对局记录？\n对局记录和 AI 的会话记录都会被删除，无法恢复。${note}`)) return;
    setDeletingAll(true);
    try {
      const { deleted } = await api.deleteAllGames();
      deleted.forEach(forgetGame);
      setGames((list) => list.filter((x) => !deleted.includes(x.id)));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingAll(false);
    }
  };

  const nameError = mode === 'human' ? validateHumanNames(humans.map((h) => h.name)) : null;
  const running = games.find((g) => g.status === 'running');

  return (
    <div className="lobby">
      <div className="hero">
        <div className="brand">WEREWOLF</div>
        <div className="tagline">AI 玩家的狼人杀 · 也欢迎人类入座</div>
      </div>

      <section className="card">
        <h2>新开一局</h2>
        <div className="mode-switch">
          <button className={mode === 'ai' ? 'active' : ''} onClick={() => update({ mode: 'ai' })}>
            观战：全 AI 对局
            <span>可以看到所有身份、夜里的行动和 AI 的思考摘要</span>
          </button>
          <button className={mode === 'human' ? 'active' : ''} onClick={() => update({ mode: 'human' })}>
            入座：和 AI 一起玩
            <span>你只能看到公开信息和自己的身份信息</span>
          </button>
        </div>

        <div className="setup">
          <div className="setup-label">板子：{SETUP_NAME}</div>
          <div className="setup-summary">{describeSetup(SETUP)}</div>
          <ul className="ability-list">
            {ROLE_ORDER.map((r) => (
              <li key={r}>
                <b>{ROLE_NAME[r]}</b>：{roleAbility(r)}
              </li>
            ))}
          </ul>
          <div className="muted small-text">
            第一天竞选警长（警长 1.5 票，决定发言顺序）；屠边：狼人杀光所有神职或所有平民即获胜，好人放逐所有狼人获胜。
          </div>
        </div>

        {mode === 'human' && (
          <div className="humans">
            <label>
              人类玩家人数
              <select value={humans.length} onChange={(e) => setCount(Number(e.target.value))}>
                {Array.from({ length: SETUP.length }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <div className="human-rows">
              {humans.map((h, i) => (
                <div key={i} className="human-row">
                  <input
                    value={h.name}
                    maxLength={MAX_NAME_LENGTH}
                    placeholder={`${defaultHumanName(i)} 的名字`}
                    onChange={(e) => setHuman(i, { name: e.target.value })}
                  />
                  <select value={h.role} onChange={(e) => setHuman(i, { role: e.target.value as RolePreference })}>
                    {PREF_OPTIONS.map((p) => (
                      <option key={p} value={p}>
                        身份：{prefLabel(p)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="muted small-text">
              座位随机分配。{humans.length > 1 && '创建后会为每位人类玩家生成专属链接，发给对应的人即可；'}
              选择的身份只有本人知道。
            </div>
            {nameError && <div className="error-text">{nameError}</div>}
          </div>
        )}

        <div className="row">
          <button className="primary" disabled={busy || !!running || !!nameError} onClick={start}>
            {busy ? '创建中…' : '开始游戏'}
          </button>
          {running && <span className="muted">已有一局正在进行，结束后才能开新局。</span>}
        </div>
        {error && <div className="error-text">{error}</div>}

        {created && (
          <div className="links">
            <div className="muted">座位已随机分配。每个链接只能看到对应玩家的信息：</div>
            {isLoopbackHost() && (
              <div className="warn small-text">
                当前页面是用 localhost 打开的，这些链接只有本机能用。发给局域网里的其他人前，把链接里的 localhost
                换成本机的局域网 IP，或者用局域网地址（npm run dev 启动时终端里 Network 那一行）打开大厅再创建对局。
              </div>
            )}
            {created.seats.map((s) => (
              <div key={s.seat} className="link-row">
                <span>
                  {s.seat}号 · {s.name}
                </span>
                <input readOnly value={gameUrl(created.id, s.token)} onFocus={(e) => e.target.select()} />
                <button onClick={() => onOpen(created.id, s.token)}>进入</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>对局记录</h2>
          {deletable.length > 0 && (
            <button className="ghost danger" disabled={deletingAll} onClick={removeAll} title="删除全部对局记录和 AI 会话记录">
              {deletingAll ? '删除中…' : '全部删除'}
            </button>
          )}
        </div>
        {games.length === 0 && <div className="muted">还没有对局。</div>}
        <div className="game-list">
          {games.map((g) => {
            const mine = seats[g.id];
            const humanCount = g.players.filter((p) => p.kind === 'human').length;
            return (
              <div key={g.id} className="game-row">
                <div>
                  <div>
                    {new Date(g.createdAt).toLocaleString()}
                    <span className={`pill ${g.status}`}>{STATUS_LABEL[g.status]}</span>
                    {g.winner && <span className={`badge small ${g.winner}`}>{TEAM_NAME[g.winner]}胜</span>}
                  </div>
                  <div className="muted small-text">
                    {humanCount ? `${humanCount} 名人类玩家` : '全 AI'} · {SETUP_NAME}
                  </div>
                </div>
                <div className="row">
                  {!g.hasHumans && <button onClick={() => onOpen(g.id)}>{g.status === 'running' ? '观战' : '回放'}</button>}
                  {g.hasHumans &&
                    (mine?.length ? (
                      mine.map((s) => (
                        <button key={s.seat} onClick={() => onOpen(g.id, s.token)}>
                          进入 {s.seat}号 {s.name}
                        </button>
                      ))
                    ) : (
                      <span className="muted small-text">需要玩家专属链接</span>
                    ))}
                  {g.status !== 'running' && g.postgame !== 'running' && (
                    <button
                      className="ghost danger"
                      disabled={deleting === g.id}
                      onClick={() => remove(g)}
                      title="删除这局的对局记录和 AI 会话记录"
                    >
                      {deleting === g.id ? '删除中…' : '删除'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
