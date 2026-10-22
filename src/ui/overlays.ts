/** Modal overlays: generic alert, results, and the in-match menu. */
import type { MatchResult } from '../game/match';
import { $, formatClock, setText } from './dom';

export interface AlertAction {
  label: string;
  kind?: 'primary' | 'secondary' | 'ghost' | 'go';
  onClick: () => void;
}

export function showAlert(opts: { title: string; message: string; info?: boolean; actions: AlertAction[] }): void {
  hideOverlay('results');
  hideOverlay('pause');
  const el = $('#overlay-alert');
  setText($('#alert-title'), opts.title);
  setText($('#alert-message'), opts.message);
  const icon = $('#alert-icon');
  icon.classList.toggle('info', !!opts.info);
  icon.textContent = opts.info ? 'i' : '!';
  const actions = $('#alert-actions');
  actions.innerHTML = '';
  for (const a of opts.actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-${a.kind ?? 'secondary'}`;
    b.textContent = a.label;
    b.addEventListener('click', () => {
      hideOverlay('alert');
      a.onClick();
    });
    actions.appendChild(b);
  }
  el.hidden = false;
  (actions.querySelector('button') as HTMLButtonElement | null)?.focus();
}

export function hideOverlay(which: 'alert' | 'results' | 'pause'): void {
  $(`#overlay-${which}`).hidden = true;
}

export function hideAllOverlays(): void {
  hideOverlay('alert');
  hideOverlay('results');
  hideOverlay('pause');
}

export function isOverlayOpen(which: 'alert' | 'results' | 'pause'): boolean {
  return !$(`#overlay-${which}`).hidden;
}

export function showResults(result: MatchResult, names: [string, string], selfIndex: 0 | 1): void {
  hideOverlay('pause');
  const won = result.winner === selfIndex;
  const outcome = $('#res-outcome');
  outcome.textContent = result.winner === -1 ? 'NO CONTEST' : won ? 'YOU WIN!' : 'YOU LOSE';
  outcome.className = `res-outcome ${won ? 'win' : 'lose'}`;
  const winnerName = result.winner === -1 ? '' : names[result.winner];
  setText($('#res-sub'), result.winner === -1 ? '' : won ? `You out-snatched ${names[1 - selfIndex]}.` : `${winnerName} takes it.`);
  setText($('#res-name-0'), names[0]);
  setText($('#res-name-1'), names[1]);
  setText($('#res-score-0'), String(result.scores[0]));
  setText($('#res-score-1'), String(result.scores[1]));
  $('.res-cyan').classList.toggle('winner', result.winner === 0);
  $('.res-orange').classList.toggle('winner', result.winner === 1);
  setText($('#res-duration'), `⏱ ${formatClock(result.duration)}`);
  setText(
    $('#res-reason'),
    result.reason === 'goals' ? 'First to 3' : result.reason === 'time' ? 'Won on time' : 'Sudden-death goal',
  );
  setRematchStatus('');
  const again = $<HTMLButtonElement>('#btn-again');
  again.disabled = false;
  again.textContent = 'Play Again';
  $('#overlay-results').hidden = false;
  again.focus();
}

export function setRematchStatus(text: string): void {
  setText($('#res-rematch'), text);
}
