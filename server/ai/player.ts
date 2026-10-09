import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteSession, query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ActionType } from '../../shared/types.ts';
import { SYSTEM_PROMPT } from './prompts.ts';
import { OUTPUT_SCHEMA, type AIOutput } from './schema.ts';

const MODEL = process.env.AIWEREWOLF_MODEL ?? 'claude-opus-5-5';
const EFFORT = (process.env.AIWEREWOLF_EFFORT ?? 'medium') as Options['effort'];
// summarized：只拿官方的思考摘要；omitted：完全不返回思考内容
const THINKING_DISPLAY = process.env.AIWEREWOLF_THINKING_DISPLAY === 'omitted' ? 'omitted' : 'summarized';

// AI 进程的工作目录：一个空的临时目录，与项目和游戏记录完全分开
const SANDBOX_DIR = join(tmpdir(), 'aiwerewolf-sandbox');
mkdirSync(SANDBOX_DIR, { recursive: true });

// 删除某个 AI 的会话记录（Agent SDK 存在 ~/.claude/projects 下）。返回是否删掉了
export async function deleteAISession(sessionId: string): Promise<boolean> {
  try {
    await deleteSession(sessionId, { dir: SANDBOX_DIR });
    return true;
  } catch (err) {
    // 会话文件不存在（比如已经手动删过）时 SDK 会抛错，不影响删除对局
    console.warn(`[aivalon] 删除会话 ${sessionId} 失败：`, err instanceof Error ? err.message : err);
    return false;
  }
}

// 从宿主环境（比如 Claude 桌面 App 里的终端）继承来的、会把额外上下文注入到 AI 会话里的变量
const LEAKY_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_USER_EMAIL',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
  'CLAUDE_CODE_REPORT_FINDINGS',
  'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_PREVIEW_CLASSIFIER_FLOOR',
];

function sanitizedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of LEAKY_ENV) delete env[key];
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'aiwerewolf/0.1';
  return env;
}

// AI 玩家只有一个能力：通过结构化输出提交动作。不给任何工具、不加载任何本地设置。
function baseOptions(): Options {
  return {
    cwd: SANDBOX_DIR,
    env: sanitizedEnv(),
    model: MODEL,
    effort: EFFORT,
    thinking: { type: 'adaptive', display: THINKING_DISPLAY },
    systemPrompt: SYSTEM_PROMPT,
    outputFormat: { type: 'json_schema', schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
    tools: [], // 关闭全部内置工具（读文件、Bash、搜索、联网……）
    settingSources: [], // 不加载 ~/.claude 和项目里的 settings / CLAUDE.md
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    skills: [],
    permissionMode: 'dontAsk', // 没有预先允许的工具调用一律拒绝
    canUseTool: async () => ({ behavior: 'deny', message: '本游戏中不允许使用任何工具。' }),
    persistSession: true, // 需要落盘才能 resume
    verbatimPrompts: true, // 发言里的 @路径 不会被展开成文件内容，也不会触发斜杠命令
    includePartialMessages: true,
  };
}

export interface ActResult {
  output: AIOutput;
  thinking: string;
  sessionCostUsd: number; // 这个会话到目前为止的累计估算费用，SDK 续接会话时会带上之前的轮次
  durationMs: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface PlayerCallbacks {
  onSession: (seat: number, sessionId: string) => void;
  onLiveSpeech: (seat: number, action: ActionType, speech: string) => void;
}

export class AIPlayer {
  constructor(
    readonly seat: number,
    public sessionId: string | null,
    private callbacks: PlayerCallbacks,
  ) {}

  async act(prompt: string, action: ActionType, signal: AbortSignal): Promise<ActResult> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const q = query({
        prompt,
        options: {
          ...baseOptions(),
          abortController,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
        },
      });

      const thinking: string[] = [];
      let toolJson = '';
      let inStructuredOutput = false;
      let lastLive = '';
      let result: SDKResultMessage | undefined;

      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') {
          if (this.sessionId !== m.session_id) {
            this.sessionId = m.session_id;
            this.callbacks.onSession(this.seat, m.session_id);
          }
        } else if (m.type === 'stream_event') {
          const ev = m.event;
          if (ev.type === 'content_block_start') {
            inStructuredOutput = ev.content_block.type === 'tool_use' && ev.content_block.name === 'StructuredOutput';
            if (inStructuredOutput) toolJson = '';
          } else if (ev.type === 'content_block_delta' && inStructuredOutput && ev.delta.type === 'input_json_delta') {
            toolJson += ev.delta.partial_json;
            const live = extractPartialString(toolJson, 'speech');
            if (live !== null && live !== lastLive) {
              lastLive = live;
              this.callbacks.onLiveSpeech(this.seat, action, live);
            }
          } else if (ev.type === 'content_block_stop') {
            inStructuredOutput = false;
          }
        } else if (m.type === 'assistant') {
          for (const block of m.message.content) {
            if (block.type === 'thinking' && block.thinking.trim()) thinking.push(block.thinking.trim());
          }
        } else if (m.type === 'result') {
          result = m;
        }
      }

      if (!result) throw new Error('没有收到结果消息');
      if (result.subtype !== 'success' || result.is_error) {
        const detail = result.subtype === 'success' ? result.result : result.errors.join('; ');
        throw new Error(`调用失败（${result.subtype}）：${detail}`);
      }
      if (!result.structured_output) throw new Error('没有返回结构化输出');

      return {
        output: result.structured_output as AIOutput,
        thinking: thinking.join('\n\n'),
        sessionCostUsd: result.total_cost_usd,
        durationMs: result.duration_ms,
        usage: {
          input: result.usage.input_tokens,
          output: result.usage.output_tokens,
          cacheRead: result.usage.cache_read_input_tokens,
          cacheWrite: result.usage.cache_creation_input_tokens,
        },
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

// 从一段还没生成完的 JSON 里取出某个字符串字段目前已有的内容，用于流式展示发言
export function extractPartialString(json: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = '';
  while (i < json.length) {
    const ch = json[i];
    if (ch === '"') return out;
    if (ch === '\\') {
      const next = json[i + 1];
      if (next === undefined) return out;
      if (next === 'u') {
        const hex = json.slice(i + 2, i + 6);
        if (hex.length < 4) return out;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[next] ?? next;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
