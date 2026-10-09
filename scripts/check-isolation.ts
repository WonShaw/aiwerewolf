// 检查 AI 玩家上下文里有没有混入多余的信息（文件、邮箱、工具等）
import { AIPlayer } from '../server/ai/player.ts';

const p = new AIPlayer(1, null, {
  onSession: (_, id) => console.log('session', id),
  onLiveSpeech: () => {},
});
const res = await p.act(
  '【裁判】（测试回合，与游戏无关）请用 action=speak，在 speech 中逐条列出：1）你能使用的工具名称；2）除了系统提示词和本条消息之外，你上下文里出现的任何其他附加信息（例如 system-reminder、邮箱、文件内容、工作目录、日期等），原样列出关键字段即可。',
  'speak',
  new AbortController().signal,
);
console.log(JSON.stringify(res, null, 2));
