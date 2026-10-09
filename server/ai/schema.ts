import type { ActionSubmission, ActionType } from '../../shared/types.ts';

// 所有动作共用一个 schema：Agent SDK 用一个 StructuredOutput 工具实现结构化输出，
// 工具定义处在提示词最前面，如果每次调用换 schema，整段缓存都会失效。
export const ACTION_TYPES: ActionType[] = [
  'wolf_discuss',
  'wolf_vote',
  'witch',
  'seer',
  'run_for_sheriff',
  'campaign',
  'sheriff_vote',
  'speech_order',
  'speak',
  'exile_vote',
  'pk_speech',
  'dying',
  'reflect',
];

const seat = (description: string) => ({ type: 'integer', minimum: 0, maximum: 12, description });

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ACTION_TYPES,
      description: '本次执行的动作，必须与裁判要求的一致',
    },
    speech: {
      type: 'string',
      description: '发言内容。夜里狼人的讨论只有狼人能看到，其他发言所有玩家都能看到',
    },
    target: seat('目标座位号：狼人袭击、预言家查验、投票对象；投票时 0 表示弃票'),
    save: { type: 'boolean', description: '女巫：是否对今晚被袭击的玩家使用解药' },
    poison: seat('女巫：毒药目标的座位号，0 表示不用毒药'),
    run: { type: 'boolean', description: '是否上警竞选警长' },
    direction: {
      type: 'string',
      enum: ['cw', 'ccw'],
      description: '警长决定的发言顺序：cw 顺时针（座位号递增），ccw 逆时针（座位号递减）',
    },
    shoot: seat('猎人开枪带走的座位号，0 表示不开枪'),
    badge: seat('警徽移交给的座位号，0 表示撕毁警徽'),
  },
  required: ['action'],
  additionalProperties: false,
} as const;

export type AIOutput = ActionSubmission;
