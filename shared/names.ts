// 人类玩家名字的规则，前后端共用。
// AI 看到的是"3号「名字」"这样的文本，代词或"裁判"之类的词会让它误解是谁在说话。
const AMBIGUOUS_NAMES = ['我', '你', '您', '他', '她', '它', '我们', '你们', '他们', '自己', '裁判', '系统', '主持人', '玩家'];

export const MAX_NAME_LENGTH = 12;

export function defaultHumanName(index: number): string {
  return `玩家${String.fromCharCode(65 + index)}`; // 玩家A、玩家B……用字母，避免和座位号混淆
}

// 返回错误信息，或 null 表示没问题
export function validateHumanNames(names: string[]): string | null {
  const trimmed = names.map((n) => n.trim());
  if (trimmed.some((n) => !n)) return '人类玩家的名字不能为空';
  if (trimmed.some((n) => n.length > MAX_NAME_LENGTH)) return `名字最多 ${MAX_NAME_LENGTH} 个字`;
  const bad = trimmed.find((n) => AMBIGUOUS_NAMES.includes(n));
  if (bad) return `名字不能用「${bad}」，AI 容易误解成在说它自己或裁判，换一个吧`;
  const dup = trimmed.find((n, i) => trimmed.indexOf(n) !== i);
  if (dup) return `人类玩家不能重名：「${dup}」`;
  return null;
}
