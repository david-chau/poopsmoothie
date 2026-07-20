import { TEAM_CLASS, type GameState } from './types';

export function playerName(state: GameState | null, playerId: string | null | undefined): string {
  if (!state || !playerId) return '';
  return state.players.find((p) => p.id === playerId)?.name ?? 'someone';
}

export function playerTeamClass(state: GameState | null, playerId: string | null | undefined): string | undefined {
  if (!state || !playerId) return undefined;
  const player = state.players.find((p) => p.id === playerId);
  return player ? TEAM_CLASS[player.team] : undefined;
}

/** navigator.clipboard needs a secure context (https or localhost) — this app
 * is reached over plain LAN http on phones, so fall back to the old
 * execCommand trick when the modern API isn't available. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
