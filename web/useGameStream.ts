import { useEffect, useReducer } from 'react';
import type { ActionType, GameEvent, GameSummary, HumanRequest, StreamMessage, Viewer } from '../shared/types.ts';

export interface StreamState {
  connected: boolean;
  error: string | null;
  viewer: Viewer | null;
  summary: GameSummary | null;
  events: GameEvent[];
  acting: Record<number, ActionType>; // 正在行动的座位
  live: Record<number, { action: ActionType; speech: string }>; // 正在生成中的发言
  request: HumanRequest | null; // 等待我做的动作
}

const initial: StreamState = {
  connected: false,
  error: null,
  viewer: null,
  summary: null,
  events: [],
  acting: {},
  live: {},
  request: null,
};

type Action =
  | { type: 'reset' }
  | { type: 'open' }
  | { type: 'error'; message: string }
  | { type: 'message'; msg: StreamMessage };

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.type) {
    case 'reset':
      return initial;
    case 'open':
      return { ...state, connected: true, error: null };
    case 'error':
      return { ...state, connected: false, error: action.message };
    case 'message': {
      const msg = action.msg;
      switch (msg.kind) {
        case 'hello':
          // 重连时服务端会重发全部事件，先清空
          return { ...initial, connected: true, viewer: msg.viewer };
        case 'game':
          return { ...state, summary: msg.summary };
        case 'event': {
          const e = msg.event;
          if (state.events.length && state.events[state.events.length - 1].seq >= e.seq) return state;
          let live = state.live;
          if (e.type === 'speech' && live[e.seat]) {
            live = { ...live };
            delete live[e.seat];
          }
          return { ...state, events: [...state.events, e], live };
        }
        case 'live':
          return { ...state, live: { ...state.live, [msg.seat]: { action: msg.action, speech: msg.speech } } };
        case 'status': {
          const acting = { ...state.acting };
          let live = state.live;
          if (msg.active) acting[msg.seat] = msg.action;
          else {
            delete acting[msg.seat];
            if (live[msg.seat]) {
              live = { ...live };
              delete live[msg.seat];
            }
          }
          return { ...state, acting, live };
        }
        case 'request':
          return { ...state, request: msg.request };
        case 'request_done':
          return state.request?.id === msg.id ? { ...state, request: null } : state;
      }
    }
  }
}

export function useGameStream(gameId: string, token: string | null): StreamState {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    dispatch({ type: 'reset' });
    const params = token ? `?token=${encodeURIComponent(token)}` : '';
    const source = new EventSource(`/api/games/${gameId}/stream${params}`);
    source.onopen = () => dispatch({ type: 'open' });
    source.onmessage = (e) => dispatch({ type: 'message', msg: JSON.parse(e.data) as StreamMessage });
    source.onerror = () => {
      // 403/404 时浏览器不会重连；其余情况 EventSource 会自动重连
      if (source.readyState === EventSource.CLOSED) {
        dispatch({ type: 'error', message: '无法连接到这局游戏（链接无效，或这局有人类玩家、不能观战）' });
      } else {
        dispatch({ type: 'error', message: '连接中断，正在重连…' });
      }
    };
    return () => source.close();
  }, [gameId, token]);

  return state;
}
