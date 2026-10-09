import { useEffect, useState } from 'react';
import type { CreateGameResponse } from '../shared/types.ts';
import { saveSeats, type SavedSeat } from './client.ts';
import { GameView } from './GameView.tsx';
import { Lobby } from './Lobby.tsx';

interface Route {
  game: string | null;
  token: string | null;
}

function readRoute(): Route {
  const p = new URLSearchParams(location.search);
  return { game: p.get('game'), token: p.get('token') };
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [created, setCreated] = useState<{ id: string; seats: SavedSeat[] } | null>(null);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (game: string | null, token?: string) => {
    const params = new URLSearchParams();
    if (game) params.set('game', game);
    if (token) params.set('token', token);
    const qs = params.toString();
    history.pushState(null, '', qs ? `?${qs}` : location.pathname);
    setRoute({ game, token: token ?? null });
  };

  // 新建对局后：全 AI 直接观战；一个人类直接入座；多个人类回大厅展示各自的链接
  const onCreated = (res: CreateGameResponse) => {
    const id = res.summary.id;
    if (res.seats.length > 0) saveSeats(id, res.seats);
    if (res.seats.length <= 1) {
      setCreated(null);
      navigate(id, res.seats[0]?.token);
    } else {
      setCreated({ id, seats: res.seats });
      navigate(null);
    }
  };

  return route.game ? (
    <GameView
      key={`${route.game}-${route.token}`}
      gameId={route.game}
      token={route.token}
      onBack={() => navigate(null)}
      onCreated={onCreated}
    />
  ) : (
    <Lobby onOpen={(id, token) => navigate(id, token)} onCreated={onCreated} created={created} />
  );
}
