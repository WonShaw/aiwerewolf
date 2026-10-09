import { useEffect, useState } from 'react';
import type { ActionSubmission, HumanRequest, PlayerInfo } from '../../shared/types.ts';
import { api } from '../client.ts';
import { seatHue, seats } from '../format.ts';

interface Props {
  gameId: string;
  token: string;
  request: HumanRequest;
  players: PlayerInfo[];
}

function title(r: HumanRequest): string {
  switch (r.action) {
    case 'wolf_discuss':
      return `第 ${r.night} 夜 · 狼人请睁眼：和同伴商量今晚袭击谁`;
    case 'wolf_vote':
      return `第 ${r.night} 夜 · 狼人投票：今晚袭击谁`;
    case 'witch':
      return `第 ${r.night} 夜 · 女巫请睁眼`;
    case 'seer':
      return `第 ${r.night} 夜 · 预言家请睁眼：选择查验对象`;
    case 'run_for_sheriff':
      return '竞选警长：要不要上警？';
    case 'campaign':
      return '轮到你警上发言';
    case 'sheriff_vote':
      return r.pk?.length ? '警长 PK 投票' : '投票选警长';
    case 'speech_order':
      return '你是警长：决定今天的发言顺序（你最后发言）';
    case 'speak':
      return '轮到你发言';
    case 'exile_vote':
      return r.pk?.length ? '放逐 PK 投票' : '放逐投票：投给你认为是狼人的玩家';
    case 'pk_speech':
      return `${r.pkFor === 'sheriff' ? '警长竞选' : '放逐投票'}平票：轮到你 PK 发言`;
    case 'dying':
      return r.deathNote ?? '你出局了';
    case 'reflect':
      return '赛后交流：聊聊你对这局的感想';
  }
}

const SPEECH_REQUIRED = ['campaign', 'speak', 'pk_speech'];

export function ActionPanel({ gameId, token, request, players }: Props) {
  const [speech, setSpeech] = useState('');
  const [target, setTarget] = useState<number | null>(null);
  const [witch, setWitch] = useState<'none' | 'save' | 'poison'>('none');
  const [shoot, setShoot] = useState<number | null>(null); // 0 不开枪
  const [badge, setBadge] = useState<number | null>(null); // 0 撕毁
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSpeech('');
    setTarget(null);
    setWitch('none');
    setShoot(null);
    setBadge(null);
    setError(null);
  }, [request.id]);

  const r = request;
  const action = r.action;
  const targets = r.pk?.length && (action === 'sheriff_vote' || action === 'exile_vote') ? r.pk : (r.targets ?? []);
  const allowsSpeech = SPEECH_REQUIRED.includes(action) || action === 'wolf_discuss' || action === 'reflect' || (action === 'dying' && !!r.lastWords);

  const submit = async (extra: Partial<ActionSubmission> = {}) => {
    const submission: ActionSubmission = { action, ...extra };
    // "跳过"会显式传入空发言，不能被输入框里的内容覆盖
    if (allowsSpeech && extra.speech === undefined && speech.trim()) submission.speech = speech.trim();
    if (action === 'seer' && target !== null) submission.target = target;
    if (action === 'witch') {
      submission.save = witch === 'save';
      submission.poison = witch === 'poison' && target !== null ? target : 0;
    }
    if (action === 'dying') {
      if (r.canShoot) submission.shoot = shoot ?? 0;
      if (r.hasBadge) submission.badge = badge ?? 0;
    }
    setBusy(true);
    setError(null);
    try {
      await api.act(gameId, token, submission);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const seatButton = (seat: number, selected: boolean, onClick: () => void) => {
    const p = players.find((x) => x.seat === seat)!;
    return (
      <button
        key={seat}
        type="button"
        className={`seat-pick${selected ? ' selected' : ''}`}
        style={{ '--hue': seatHue(seat) } as React.CSSProperties}
        onClick={onClick}
      >
        {seat} {p.name}
      </button>
    );
  };
  const noneButton = (label: string, selected: boolean, onClick: () => void) => (
    <button type="button" className={`seat-pick none${selected ? ' selected' : ''}`} onClick={onClick}>
      {label}
    </button>
  );

  const canSubmit =
    !busy &&
    (!SPEECH_REQUIRED.includes(action) || speech.trim().length > 0) &&
    (action !== 'seer' || target !== null) &&
    (action !== 'witch' || witch !== 'poison' || target !== null) &&
    (action !== 'dying' || ((!r.canShoot || shoot !== null) && (!r.hasBadge || badge !== null)));

  // 投票类和二选一的动作点按钮直接提交，其余的动作用提交按钮
  const instant = ['run_for_sheriff', 'wolf_vote', 'sheriff_vote', 'exile_vote', 'speech_order'].includes(action);

  return (
    <div className={`action-panel${['wolf_discuss', 'wolf_vote', 'witch', 'seer'].includes(action) ? ' night' : ''}`}>
      <div className="action-title">{title(r)}</div>

      {action === 'wolf_discuss' && (
        <div className="muted small-text">狼人按座位依次发言，全部说完后再一起投票决定袭击谁。</div>
      )}

      {action === 'wolf_vote' && (
        <div className="action-row">
          <div className="muted">所有狼人同时投票，以多数为准，平票随机</div>
          <div className="seat-picks">{targets.map((s) => seatButton(s, false, () => submit({ target: s })))}</div>
        </div>
      )}

      {action === 'witch' && (
        <div className="action-row">
          <div>
            {r.victim === null || r.victim === undefined
              ? '解药已经用完，你看不到今晚谁被袭击。'
              : `今晚被狼人袭击的是 ${r.victim}号。`}
            <span className="muted">同一晚只能用一瓶药。</span>
          </div>
          <div className="seat-picks">
            {noneButton('不用药', witch === 'none', () => setWitch('none'))}
            {r.canSave && noneButton(`用解药救 ${r.victim}号`, witch === 'save', () => setWitch('save'))}
            {r.canPoison && noneButton('用毒药', witch === 'poison', () => setWitch('poison'))}
          </div>
          {!r.canSave && r.victim ? <div className="muted small-text">解药不能救自己。</div> : null}
          {witch === 'poison' && (
            <>
              <div className="muted">毒谁</div>
              <div className="seat-picks">{targets.map((s) => seatButton(s, target === s, () => setTarget(s)))}</div>
            </>
          )}
        </div>
      )}

      {action === 'seer' && (
        <div className="action-row">
          <div className="seat-picks">{targets.map((s) => seatButton(s, target === s, () => setTarget(s)))}</div>
        </div>
      )}

      {action === 'run_for_sheriff' && (
        <div className="action-row">
          <div className="muted">所有人同时决定，之后一起公布。上警的人依次发言，没上警的人投票。</div>
          <div className="big-buttons">
            <button className="approve" disabled={busy} onClick={() => submit({ run: true })}>
              上警
            </button>
            <button disabled={busy} onClick={() => submit({ run: false })}>
              不上警
            </button>
          </div>
        </div>
      )}

      {(action === 'sheriff_vote' || action === 'exile_vote') && (
        <div className="action-row">
          {r.isSheriff && <div className="muted">你是警长，你的票算 1.5 票。</div>}
          <div className="seat-picks">
            {targets.map((s) => seatButton(s, false, () => submit({ target: s })))}
            {noneButton('弃票', false, () => submit({ target: 0 }))}
          </div>
        </div>
      )}

      {action === 'speech_order' && (
        <div className="action-row">
          <div className="big-buttons">
            <button disabled={busy} onClick={() => submit({ direction: 'cw' })}>
              从 {r.cw}号 开始 · 顺时针
            </button>
            <button disabled={busy} onClick={() => submit({ direction: 'ccw' })}>
              从 {r.ccw}号 开始 · 逆时针
            </button>
          </div>
        </div>
      )}

      {action === 'dying' && (
        <>
          {!r.lastWords && <div className="muted small-text">你没有遗言。</div>}
          {r.canShoot && (
            <div className="action-row">
              <div className="muted">你是猎人，可以开枪带走一人（会亮明身份）</div>
              <div className="seat-picks">
                {targets.map((s) => seatButton(s, shoot === s, () => setShoot(s)))}
                {noneButton('不开枪', shoot === 0, () => setShoot(0))}
              </div>
            </div>
          )}
          {r.hasBadge && (
            <div className="action-row">
              <div className="muted">你是警长：把警徽移交给谁</div>
              <div className="seat-picks">
                {targets.map((s) => seatButton(s, badge === s, () => setBadge(s)))}
                {noneButton('撕毁警徽', badge === 0, () => setBadge(0))}
              </div>
            </div>
          )}
        </>
      )}

      {allowsSpeech && (
        <div className="action-row">
          <textarea
            value={speech}
            onChange={(e) => setSpeech(e.target.value)}
            placeholder={
              action === 'wolf_discuss'
                ? '（可选）和同伴说点什么，只有狼人能看到…'
                : action === 'dying'
                  ? '（可选）你的遗言…'
                  : action === 'reflect'
                    ? '聊聊这局…'
                    : '输入你的发言…'
            }
            rows={3}
            maxLength={1000}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit && !instant) void submit();
            }}
          />
        </div>
      )}

      {!instant && (
        <div className="action-row right">
          {allowsSpeech && <span className="muted hint">⌘/Ctrl + Enter 提交</span>}
          {action === 'reflect' && (
            <button disabled={busy} onClick={() => submit({ speech: '' })}>
              跳过
            </button>
          )}
          <button className="primary" disabled={!canSubmit} onClick={() => submit()}>
            提交
          </button>
        </div>
      )}

      {targets.length > 0 && instant && action !== 'speech_order' && (
        <div className="muted small-text">可选：{seats(targets)}</div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
