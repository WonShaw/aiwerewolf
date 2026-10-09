import { useState } from 'react';
import type { ActionType, PlayerInfo, Role, SeatMark, Viewer } from '../../shared/types.ts';
import type { BoardState } from '../derive.ts';
import { ACTION_LABEL, roleLabel, roleTone, seatHue } from '../format.ts';
import { guessLabel, guessOptions, guessTeam, type Guess } from '../guesses.ts';

interface Props {
  setup: Role[];
  players: PlayerInfo[];
  board: BoardState;
  acting: Record<number, ActionType>;
  viewer: Viewer | null;
  roles: Record<number, Role>; // 当前观看者能看到的身份
  guesses: Record<number, Guess>;
  onGuess: (seat: number, guess: Guess | null) => void;
}

function phaseTitle(board: BoardState): string {
  const { kind, number } = board.phase;
  if (kind === 'over') return '游戏结束';
  if (kind === 'night') return `第 ${number} 夜`;
  if (kind === 'day') return `第 ${number} 天`;
  return '准备开始';
}

export function RoundTable({ setup, players, board, acting, viewer, roles, guesses, onGuess }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const mySeat = viewer?.kind === 'player' ? viewer.seat : null;
  const marks: Record<number, SeatMark> = {};
  for (const m of board.marks) marks[m.seat] = m;
  const aliveCount = players.length - board.dead.length;

  // 自己和已经能看到身份的座位不需要标记
  const canGuess = (seat: number) => seat !== mySeat && !roles[seat];
  const selectedPlayer = selected !== null && canGuess(selected) ? players.find((p) => p.seat === selected) : undefined;

  return (
    <div className={`table-wrap seats-${players.length}`}>
      <div className={`table ${board.phase.kind === 'night' ? 'night' : ''}`}>
        <div className="table-center">
          <div className="table-title">{phaseTitle(board)}</div>
          <div className="table-phase">{board.phase.kind === 'night' ? '🌙' : board.phase.kind === 'day' ? '☀️' : '🐺'}</div>
          <div className="table-sub">
            存活 {aliveCount}/{players.length}
          </div>
          <div className="table-sub">
            {board.electing ? '竞选警长中' : board.sheriff ? `警长：${board.sheriff}号` : board.phase.number > 0 ? '没有警长' : ''}
          </div>
        </div>

        {players.map((p) => {
          const angle = (-90 + ((p.seat - 1) * 360) / players.length) * (Math.PI / 180);
          const style = {
            left: `${50 + 41 * Math.cos(angle)}%`,
            top: `${50 + 42 * Math.sin(angle)}%`,
            '--hue': seatHue(p.seat),
          } as React.CSSProperties;
          const role = roles[p.seat];
          const vote = board.lastVote?.[p.seat];
          const act = acting[p.seat];
          const mark = marks[p.seat];
          const guess = guesses[p.seat];
          const dead = board.dead.includes(p.seat);
          const guessable = canGuess(p.seat);
          const classes = ['seat'];
          if (act) classes.push('acting');
          if (dead) classes.push('dead');
          if (board.candidates.includes(p.seat)) classes.push('candidate');
          if (p.seat === mySeat) classes.push('me');
          if (guessable) classes.push('guessable');
          if (selected === p.seat) classes.push('selected');

          return (
            <div
              key={p.seat}
              className={classes.join(' ')}
              style={style}
              onClick={guessable ? () => setSelected(selected === p.seat ? null : p.seat) : undefined}
              title={guessable ? '点击标记你对他身份的猜测' : undefined}
            >
              <div className="avatar-wrap">
                <div className="avatar">{p.seat}</div>
                {board.sheriff === p.seat && (
                  <span className="sheriff-badge" title="警长">
                    警
                  </span>
                )}
                {dead && (
                  <span className="dead-mark" title="已出局">
                    ✝
                  </span>
                )}
                {vote !== undefined && (
                  <span className={`vote-target${vote ? '' : ' abstain'}`} title={vote ? `投给 ${vote}号` : '弃票'}>
                    {vote ? `→${vote}` : '弃'}
                  </span>
                )}
              </div>
              <div className="seat-name">{p.name}</div>
              <div className={`seat-sub${act ? ' acting-text' : ''}`}>
                {act
                  ? `${p.kind === 'human' ? '等待' : '思考'}·${ACTION_LABEL[act]}`
                  : dead
                    ? '出局'
                    : p.seat === mySeat
                      ? '你'
                      : p.kind === 'human'
                        ? '人类'
                        : 'AI'}
              </div>
              <div className="seat-badges">
                {/* 每个座位最多一个标记：已知身份 > 自己的猜测 > 私密标记（有猜测时私密标记放进悬停提示） */}
                {role && <span className={`badge ${roleTone(role)}`}>{roleLabel(role)}</span>}
                {!role && guess && (
                  <span className={`badge guess ${guessTeam(guess)}`} title={mark ? mark.label : undefined}>
                    {guessLabel(guess)}?
                  </span>
                )}
                {!role && !guess && mark && <span className={`badge ${mark.tone}`}>{mark.label}</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="table-legend">
        <span>
          <span className="legend-sheriff">警</span>警长
        </span>
        <span>
          <span className="legend-candidate" />上警
        </span>
        <span>
          <span className="legend-acting" />正在行动
        </span>
        <span>✝ 出局</span>
        <span>→N 最近一次投票</span>
      </div>

      {selectedPlayer && (
        <div className="guess-panel">
          <div className="guess-title">
            标记 {selectedPlayer.seat}号 {selectedPlayer.name} 的身份
            <span className="muted">（只有你自己看得到）</span>
          </div>
          <div className="guess-options">
            {guessOptions(setup).map((g) => (
              <button
                key={g}
                className={`guess-option ${guessTeam(g)}${guesses[selectedPlayer.seat] === g ? ' active' : ''}`}
                onClick={() => {
                  onGuess(selectedPlayer.seat, g);
                  setSelected(null);
                }}
              >
                {guessLabel(g)}
              </button>
            ))}
            <button
              className="guess-option clear"
              onClick={() => {
                onGuess(selectedPlayer.seat, null);
                setSelected(null);
              }}
            >
              清除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
