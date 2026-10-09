import { useEffect, useState } from 'react';
import { ROLE_NAME, ROLE_TEAM, type Role, type Team } from '../shared/types.ts';
import { ROLE_ORDER } from '../shared/setup.ts';

// 玩家对其他座位身份的猜测，只保存在本机浏览器里
export type Guess = Team | Role;

export function guessOptions(setup: Role[]): Guess[] {
  return ['good', 'wolf', ...ROLE_ORDER.filter((r) => setup.includes(r) && r !== 'werewolf')];
}

export function guessLabel(g: Guess): string {
  if (g === 'good') return '好人';
  if (g === 'wolf') return '狼人';
  return ROLE_NAME[g];
}

export function guessTeam(g: Guess): Team {
  return g === 'good' || g === 'wolf' ? g : ROLE_TEAM[g];
}

function load(key: string): Record<number, Guess> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

export function useGuesses(gameId: string, viewerKey: string): [Record<number, Guess>, (seat: number, g: Guess | null) => void] {
  const key = `aiwerewolf.guesses.${gameId}.${viewerKey}`;
  const [guesses, setGuesses] = useState<Record<number, Guess>>(() => load(key));

  useEffect(() => setGuesses(load(key)), [key]);

  const set = (seat: number, g: Guess | null) => {
    setGuesses((prev) => {
      const next = { ...prev };
      if (g) next[seat] = g;
      else delete next[seat];
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // 存不了就只在当前页面有效
      }
      return next;
    });
  };
  return [guesses, set];
}
