import { ROLE_NAME, ROLE_TEAM, isGod, type Role } from './types.ts';

// 目前只支持 12 人预女猎白：4 狼人，预言家、女巫、猎人、白痴，4 平民
export const SETUP: Role[] = [
  'werewolf',
  'werewolf',
  'werewolf',
  'werewolf',
  'seer',
  'witch',
  'hunter',
  'idiot',
  'villager',
  'villager',
  'villager',
  'villager',
];

export const SETUP_NAME = '12 人预女猎白';

// 身份在说明里的顺序
export const ROLE_ORDER: Role[] = ['werewolf', 'seer', 'witch', 'hunter', 'idiot', 'villager'];

export function countRoles(setup: Role[]): [Role, number][] {
  return ROLE_ORDER.filter((r) => setup.includes(r)).map((r) => [r, setup.filter((x) => x === r).length]);
}

export function describeSetup(setup: Role[]): string {
  const list = (pred: (r: Role) => boolean) =>
    countRoles(setup)
      .filter(([r]) => pred(r))
      .map(([r, n]) => (n > 1 ? `${ROLE_NAME[r]}×${n}` : ROLE_NAME[r]))
      .join('、');
  return `${setup.length} 人局 · 狼人阵营：${list((r) => ROLE_TEAM[r] === 'wolf')}；神职：${list(isGod)}；平民：${list((r) => r === 'villager')}`;
}

// 每个身份的能力（给玩家看的简要说明）
export function roleAbility(role: Role): string {
  switch (role) {
    case 'werewolf':
      return '互相认识；每晚商量后袭击一名玩家';
    case 'seer':
      return '每晚查验一名玩家是好人还是狼人';
    case 'witch':
      return '一瓶解药（不能救自己）、一瓶毒药，各用一次，同一晚只能用一瓶';
    case 'hunter':
      return '死亡时可以开枪带走一名玩家；被毒死时不能开枪';
    case 'idiot':
      return '被放逐时翻牌免死，之后留在场上但不能投票';
    case 'villager':
      return '没有特殊能力';
  }
}
