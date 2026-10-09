import { ROLE_NAME, ROLE_TEAM, isGod, type Role, type SeatMark } from '../../shared/types.ts';
import { ROLE_ORDER, roleAbility } from '../../shared/setup.ts';
import { guessTeam, type Guess } from '../guesses.ts';

interface Props {
  setup: Role[];
  roles: Record<number, Role>; // 当前观看者能看到的身份
  marks: SeatMark[];
  guesses: Record<number, Guess>;
  canMark: boolean;
}

type Group = { key: string; label: string; tone: 'good' | 'wolf'; roles: Role[] };

const GROUPS: Group[] = [
  { key: 'wolf', label: '狼人阵营', tone: 'wolf', roles: ['werewolf'] },
  { key: 'god', label: '神职', tone: 'good', roles: ROLE_ORDER.filter(isGod) },
  { key: 'villager', label: '平民', tone: 'good', roles: ['villager'] },
];

// 本局身份配置，以及按"已知 + 你的标记"统计出的每种身份已经对上了几个
export function RoleGuide({ setup, roles, marks, guesses, canMark }: Props) {
  const total = (r: Role) => setup.filter((x) => x === r).length;
  const roleCount: Partial<Record<Role, number>> = {};
  let wolves = 0;
  const wolfMarks = new Set(marks.filter((m) => m.tone === 'wolf').map((m) => m.seat));
  for (let seat = 1; seat <= setup.length; seat++) {
    const known = roles[seat];
    const guess = guesses[seat];
    const role = known ?? (guess && guess !== 'good' && guess !== 'wolf' ? guess : undefined);
    if (role) roleCount[role] = (roleCount[role] ?? 0) + 1;
    const team = known ? ROLE_TEAM[known] : guess ? guessTeam(guess) : wolfMarks.has(seat) ? 'wolf' : undefined;
    if (team === 'wolf' && !role) wolves++;
  }
  roleCount.werewolf = (roleCount.werewolf ?? 0) + wolves;

  return (
    <div className="guide">
      <div className="guide-title">本局身份</div>
      {GROUPS.map((g) => (
        <div key={g.key} className={`guide-team ${g.tone}`}>
          <div className="guide-team-head">
            {g.label} {g.roles.reduce((n, r) => n + total(r), 0)} 人
          </div>
          <div className="guide-roles">
            {g.roles.map((r) => {
              const n = roleCount[r] ?? 0;
              return (
                <span key={r} className={`guide-role ${g.tone}`} title={roleAbility(r)}>
                  {ROLE_NAME[r]} ×{total(r)}
                  {n > 0 && <span className={`guide-count${n > total(r) ? ' over' : ''}`}>已对上 {n}</span>}
                </span>
              );
            })}
          </div>
        </div>
      ))}
      <details className="guide-sight">
        <summary>各身份的能力</summary>
        <ul>
          {ROLE_ORDER.map((r) => (
            <li key={r}>
              <b>{ROLE_NAME[r]}</b>：{roleAbility(r)}
            </li>
          ))}
        </ul>
      </details>
      {canMark && <div className="muted small-text">点击圆桌上的座位，可以标记你对他身份的猜测。</div>}
    </div>
  );
}
