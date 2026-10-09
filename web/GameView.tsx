import { useMemo, useState } from 'react';
import type { CreateGameResponse, GameStatus } from '../shared/types.ts';
import { api, createGame, loadRequest } from './client.ts';
import { ActionPanel } from './components/ActionPanel.tsx';
import { RoleGuide } from './components/RoleGuide.tsx';
import { RoundTable } from './components/RoundTable.tsx';
import { Timeline } from './components/Timeline.tsx';
import { deriveBoard, visibleRoles } from './derive.ts';
import { playerName, roleLabel, roleTone } from './format.ts';
import { useGuesses } from './guesses.ts';
import { useGameStream } from './useGameStream.ts';

const STATUS_LABEL: Record<GameStatus, string> = {
  running: '进行中',
  finished: '已结束',
  aborted: '已中止',
  error: '出错',
};

function usePersistentToggle(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v === '1';
    } catch {
      return initial;
    }
  });
  const set = (v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(key, v ? '1' : '0');
    } catch {
      // 忽略
    }
  };
  return [value, set];
}

interface Props {
  gameId: string;
  token: string | null;
  onBack: () => void;
  onCreated: (res: CreateGameResponse) => void;
}

export function GameView({ gameId, token, onBack, onCreated }: Props) {
  const state = useGameStream(gameId, token);
  const { viewer, summary, events } = state;
  const board = useMemo(() => deriveBoard(events, viewer), [events, viewer]);
  const [godView, setGodView] = usePersistentToggle('aiwerewolf.godView', true);

  const isSpectator = viewer?.kind === 'spectator';
  // 观众、出局后的玩家、对局正常结束后的玩家：能看到调用统计，可以开上帝视角看所有身份、夜里的行动和思考摘要（由服务端决定）
  const fullView = state.fullView;
  const players = summary?.players ?? [];
  const mySeat = viewer?.kind === 'player' ? viewer.seat : null;
  const roles = visibleRoles(board, viewer, godView);
  const [guesses, setGuess] = useGuesses(gameId, mySeat ? `seat${mySeat}` : 'spectator');
  const canMark = players.some((p) => p.seat !== mySeat && !roles[p.seat]);

  const [restarting, setRestarting] = useState(false);
  const humanNames = players.filter((p) => p.kind === 'human').map((p) => p.name);
  const setup = summary?.setup ?? [];

  // 用相同的配置再开一局：同样的身份配置和人类玩家（座位重新随机）。
  // 人类选的身份只有创建者的浏览器记得，其他人点"再来一局"时身份改为随机
  const playAgain = async () => {
    setRestarting(true);
    try {
      const saved = loadRequest(gameId);
      const req = saved ?? { humans: humanNames.map((name) => ({ name, role: 'random' as const })) };
      onCreated(await createGame(req));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setRestarting(false);
    }
  };
  const postgameRunning = summary?.postgame === 'running';
  const playAgainButton = summary && summary.status !== 'running' && !postgameRunning && (
    <button className="primary" disabled={restarting} onClick={playAgain}>
      {restarting ? '创建中…' : humanNames.length > 1 ? '再来一局（生成新链接）' : '再来一局'}
    </button>
  );

  // 赛后交流：正常结束的对局可以手动开启，一轮结束后还能再开一轮；全 AI 对局观众可开，有人类的对局由玩家开
  const [startingPostgame, setStartingPostgame] = useState(false);
  const canStartPostgame =
    summary?.status === 'finished' && summary.postgame !== 'running' && (isSpectator || !!token);
  const postgameAgain = summary?.postgame === 'done';
  const startPostgame = async () => {
    setStartingPostgame(true);
    try {
      await api.startPostgame(gameId, token ?? undefined);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setStartingPostgame(false);
    }
  };
  const postgameButton = canStartPostgame && (
    <button
      disabled={startingPostgame}
      onClick={startPostgame}
      title={postgameAgain ? '每位玩家按座位顺序再发言一次' : '每位玩家再发言一次，聊聊这局的感想'}
    >
      {startingPostgame ? '开启中…' : postgameAgain ? '再聊一轮' : '赛后聊聊'}
    </button>
  );

  const stop = async () => {
    if (!confirm(postgameRunning ? '确定要结束赛后交流吗？' : '确定要结束这局游戏吗？')) return;
    try {
      await api.stop(gameId, token ?? undefined);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="game">
      <header className="topbar">
        <button className="link" onClick={onBack}>
          ← 大厅
        </button>
        <div className="brand small">WEREWOLF</div>
        {summary && <span className={`pill ${summary.status}`}>{STATUS_LABEL[summary.status]}</span>}
        <span className="muted mode">
          {isSpectator ? '观战 · 全 AI 对局' : mySeat ? `你是 ${mySeat}号 ${playerName(players, mySeat)}` : ''}
        </span>
        <div className="spacer" />
        {fullView && (
          <label className="toggle">
            <input type="checkbox" checked={godView} onChange={(e) => setGodView(e.target.checked)} />
            上帝视角
          </label>
        )}
        {summary?.status === 'running' && (
          <button className="ghost danger" onClick={stop}>
            结束对局
          </button>
        )}
        {postgameRunning && (
          <button className="ghost danger" onClick={stop}>
            结束赛后交流
          </button>
        )}
        {postgameButton}
        {playAgainButton}
      </header>

      {state.error && <div className="notice">{state.error}</div>}

      {summary ? (
        <div className="game-body">
          <aside className="side">
            <RoundTable
              setup={setup}
              players={players}
              board={board}
              acting={state.acting}
              viewer={viewer}
              roles={roles}
              guesses={guesses}
              onGuess={setGuess}
            />

            {board.myRole && (
              <div className={`role-card ${roleTone(board.myRole.role)}`}>
                <div className="role-card-title">你的身份：{roleLabel(board.myRole.role)}</div>
                <div>{board.myRole.knowledge}</div>
              </div>
            )}

            <RoleGuide setup={setup} roles={roles} marks={board.marks} guesses={guesses} canMark={canMark} />

            {fullView && board.usage.calls > 0 && (
              <div className="stats">
                <div>
                  <span className="muted">AI 调用</span> {board.usage.calls} 次
                </div>
                <div>
                  <span className="muted">估算费用</span> ${board.usage.costUsd.toFixed(2)}
                </div>
                <div>
                  <span className="muted">输出 token</span> {board.usage.output.toLocaleString()}
                </div>
                <div>
                  <span className="muted">缓存命中</span>{' '}
                  {Math.round((board.usage.cacheRead / Math.max(1, board.usage.cacheRead + board.usage.cacheWrite + board.usage.input)) * 100)}%
                </div>
              </div>
            )}
          </aside>

          <main className="main">
            <Timeline
              events={events}
              players={players}
              viewer={viewer}
              fullView={fullView}
              godView={godView}
              roles={roles}
              acting={state.acting}
              live={state.live}
            >
              {(postgameButton || playAgainButton) && (
                <div className="play-again">
                  {postgameButton}
                  {playAgainButton}
                </div>
              )}
            </Timeline>
            {state.request && token && (
              <ActionPanel gameId={gameId} token={token} request={state.request} players={players} />
            )}
          </main>
        </div>
      ) : (
        !state.error && <div className="notice">连接中…</div>
      )}
    </div>
  );
}
