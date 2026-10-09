import { ROLE_NAME, ROLE_TEAM, isGod, type Role, type RolePreference, type SeatMark, type Team } from '../../shared/types.ts';

export function isWolf(role: Role): boolean {
  return ROLE_TEAM[role] === 'wolf';
}

export function nextSeat(seat: number, players: number): number {
  return (seat % players) + 1;
}

// 从 start 开始顺时针的座位顺序（包含 start）
export function seatsFrom(start: number, players: number): number[] {
  const out: number[] = [];
  let s = start;
  for (let i = 0; i < players; i++) {
    out.push(s);
    s = nextSeat(s, players);
  }
  return out;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function seatList(seats: number[]): string {
  return seats.length ? seats.map((s) => `${s}号`).join('、') : '无';
}

// 每个身份开局时得到的私密信息：给 AI 的文字说明，以及给前端的座位标记
export function knowledgeFor(seat: number, roles: Record<number, Role>): { text: string; marks: SeatMark[] } {
  switch (roles[seat]) {
    case 'werewolf': {
      const mates = Object.entries(roles)
        .filter(([s, r]) => isWolf(r) && Number(s) !== seat)
        .map(([s]) => Number(s))
        .sort((a, b) => a - b);
      return {
        text: `你的狼人同伴是：${seatList(mates)}。每晚你们会一起商量袭击谁，你们的商量只有狼人能看到。`,
        marks: mates.map((s) => ({ seat: s, label: '狼同伴', tone: 'wolf' as const })),
      };
    }
    case 'seer':
      return { text: '每晚你可以查验一名存活玩家，得知他是好人还是狼人。', marks: [] };
    case 'witch':
      return {
        text: '你有一瓶解药和一瓶毒药，整局各能用一次，同一晚只能用一瓶，不能救自己。解药还在时，你每晚会得知当晚被狼人袭击的玩家。',
        marks: [],
      };
    case 'hunter':
      return { text: '你死亡时可以开枪带走一名存活玩家，也可以不开枪；被女巫毒死时不能开枪。', marks: [] };
    case 'idiot':
      return { text: '你被投票放逐时会翻牌免死，之后可以继续发言，但不能再投票。被狼人袭击或被毒死则正常死亡。', marks: [] };
    case 'villager':
      return { text: '你没有特殊能力，要靠发言和投票帮好人找出狼人。', marks: [] };
  }
}

// 屠边：狼人全部出局则好人胜；神职全部出局或平民全部出局则狼人胜；同时达成时狼人胜
export function checkWinner(roles: Record<number, Role>, alive: Iterable<number>): { winner: Team; reason: string } | null {
  const living = [...alive].map((s) => roles[s]);
  const wolves = living.filter(isWolf).length;
  const gods = living.filter(isGod).length;
  const villagers = living.filter((r) => r === 'villager').length;
  if (gods === 0) return { winner: 'wolf', reason: '神职全部出局（屠边）' };
  if (villagers === 0) return { winner: 'wolf', reason: '平民全部出局（屠边）' };
  if (wolves === 0) return { winner: 'good', reason: '狼人全部出局' };
  return null;
}

// 按人类玩家的偏好分配身份：先满足指定身份，再满足指定阵营，其余随机。返回每个人类拿到的身份和剩给 AI 的身份
export function assignRoles(setup: Role[], prefs: RolePreference[]): { humans: Role[]; rest: Role[] } {
  const pool = shuffle(setup);
  const humans: (Role | undefined)[] = prefs.map(() => undefined);
  const take = (pred: (r: Role) => boolean): Role | undefined => {
    const i = pool.findIndex(pred);
    return i < 0 ? undefined : pool.splice(i, 1)[0];
  };

  const passes: ((p: RolePreference) => boolean)[] = [
    (p) => p in ROLE_TEAM,
    (p) => p === 'good' || p === 'wolf',
    (p) => p === 'random',
  ];
  for (const isPass of passes) {
    prefs.forEach((p, i) => {
      if (!isPass(p)) return;
      const role =
        p === 'random' ? take(() => true) : p === 'good' || p === 'wolf' ? take((r) => ROLE_TEAM[r] === p) : take((r) => r === p);
      if (!role) {
        const what = p === 'good' ? '好人' : p === 'wolf' ? '狼人阵营' : p === 'random' ? '身份' : ROLE_NAME[p as Role];
        throw new Error(`选择的${what}不够分：请调整人类玩家的身份选择`);
      }
      humans[i] = role;
    });
  }
  return { humans: humans as Role[], rest: pool };
}

export const RULES_TEXT = `
## 狼人杀规则（12 人预女猎白）

### 阵营与身份
本局 12 人：狼人 4 名；神职 4 名（预言家、女巫、猎人、白痴）；平民 4 名。神职和平民都属于好人阵营。
- 狼人：互相知道同伴。每晚一起商量，袭击一名存活玩家（可以是任何人，包括狼人自己）。
- 预言家：每晚查验一名存活玩家，得知他是好人还是狼人（只知道阵营，不知道具体身份）。
- 女巫：有一瓶解药和一瓶毒药，整局各能用一次，同一晚只能用一瓶。解药还在时，女巫每晚会得知当晚被狼人袭击的玩家，可以用解药救他；解药用掉之后不再得知。女巫不能救自己。毒药可以毒死任意一名其他存活玩家。
- 猎人：死亡时可以开枪带走一名存活玩家，也可以不开枪；开枪时会亮明猎人身份。被女巫毒死时不能开枪。
- 白痴：被投票放逐时翻牌亮明身份，免于死亡，之后继续发言但不能再投票。被狼人袭击或被毒死则正常死亡。
- 平民：没有特殊能力。

### 夜晚（按顺序进行）
1. 狼人依次发言商量（只有狼人能看到），每人提议一个袭击目标。以多数提议为准，票数相同时在并列的目标里随机选一个。
2. 女巫行动。
3. 预言家查验。
女巫或预言家已经死亡时，对应的步骤照常空过，其他玩家无法从中得知他们是否存活。

### 白天
1. 第一天天亮时，先竞选警长（第一晚死亡的玩家此时还没公布，也照常参加竞选）：
   - 所有人同时决定是否上警。上警的玩家依次发言（警上发言），然后没有上警的玩家（警下）投票选警长，可以弃票；上警的玩家不能投票。
   - 得票最多者当选。平票时，平票的玩家各再发言一次（PK），警下玩家在他们之间重新投票；再次平票则本局没有警长。
   - 只有一人上警则直接当选；无人上警或所有人都上警，则本局没有警长。
   - 警长的放逐投票算 1.5 票，并决定每天的发言顺序：从警长的下一位顺时针（座位号递增）或逆时针开始，警长最后发言。
   - 警长死亡时可以把警徽移交给一名存活玩家，也可以撕毁警徽（之后没有警长）。白痴警长翻牌后警徽流失。
2. 公布昨晚死亡的玩家：只公布座位，不公布死因和身份。没有人死亡称为平安夜。
3. 遗言：第一晚死亡的玩家有遗言，之后夜里死亡的玩家没有遗言；白天被放逐或被猎人带走的玩家都有遗言。
4. 存活玩家依次发言，每人一次。没有警长时，从昨晚第一位死者的下一位开始顺时针发言（平安夜则从随机一位开始）。
5. 放逐投票：存活且有投票权的玩家同时投票放逐一名其他存活玩家，可以弃票。得票最多者被放逐。平票时，平票的玩家各做一次 PK 发言，其他有投票权的玩家在他们之间重新投票；再次平票则当天无人被放逐。所有人都弃票时当天也无人被放逐。
6. 投票结束后公开每个人投给了谁。
7. 死亡玩家的身份不公开（猎人开枪、白痴翻牌除外），游戏结束后才公布全部身份。

### 胜负（屠边）
- 所有狼人都出局：好人阵营获胜。
- 所有神职都出局，或所有平民都出局：狼人阵营获胜。翻牌后的白痴仍算存活的神职。
- 双方条件同时达成时，狼人获胜。
- 胜负条件一旦达成，游戏立即结束，不再进行之后的遗言、开枪等步骤。

### 常用说法
金水：被预言家验为好人的玩家；查杀：被预言家验为狼人的玩家；银水：被女巫救过的玩家；悍跳：狼人冒充预言家；警徽流：预言家公布的后续查验顺序和警徽移交计划；归票：警长在最后发言时号召大家投给谁；自刀：狼人袭击自己的同伴。
`.trim();
