/** Home-page "Open lobbies" list. Built with DOM APIs only (names are untrusted). */
import type { LobbyDirectory, Listing } from '../network/directory';
import { $, setText } from './dom';

function waitingFor(openedAt: number): string {
  const s = Math.max(0, Math.round((Date.now() - openedAt) / 1000));
  if (s < 15) return 'just opened';
  if (s < 60) return `waiting ${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `waiting ${m} min` : 'waiting 1h+';
}

export class LobbyListView {
  private list = $('#lobby-list');
  private empty = $('#lobbies-empty');
  private status = $('#lobbies-status');
  private rows = new Map<string, HTMLLIElement>();

  constructor(
    private directory: LobbyDirectory,
    private onJoin: (code: string) => void,
  ) {
    directory.onChange = () => this.render();
    $('#btn-refresh-lobbies').addEventListener('click', () => {
      directory.refresh();
      this.render();
    });
    this.render();
  }

  render(): void {
    const listings = this.directory.list();
    const st = this.directory.status();
    this.status.dataset.state = st;
    setText(
      $('.text', this.status),
      st === 'unreachable'
        ? 'Directory unreachable'
        : st === 'connecting'
          ? 'Searching…'
          : listings.length
            ? `${listings.length} open`
            : 'Live',
    );
    this.status.title =
      st === 'unreachable'
        ? 'Can’t reach the public relays that carry the lobby list. Your network or an extension may be blocking them. Joining by code still works if your friend can connect.'
        : 'Rooms appear here while their host waits for an opponent.';

    const keep = new Set(listings.map((l) => l.code));
    for (const [code, li] of this.rows) {
      if (!keep.has(code)) {
        li.remove();
        this.rows.delete(code);
      }
    }
    listings.forEach((l, i) => {
      let li = this.rows.get(l.code);
      if (!li) {
        li = this.makeRow(l);
        this.rows.set(l.code, li);
      }
      this.fill(li, l);
      if (this.list.children[i] !== li) this.list.insertBefore(li, this.list.children[i] ?? null);
    });
    this.empty.hidden = listings.length > 0;
    if (st === 'unreachable' && !listings.length) {
      setText(this.empty, 'Can’t load open rooms — the public relays are unreachable from this network. You can still create a room or join by code.');
    } else {
      setText(this.empty, 'No open rooms right now. Create one — it shows up here for everyone.');
    }
  }

  private makeRow(l: Listing): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'lobby-row';
    li.dataset.code = l.code;
    li.innerHTML =
      '<span class="lobby-badge"><span class="shape shape-circle"></span></span>' +
      '<span class="lobby-info"><span class="lobby-name"></span><span class="lobby-meta"></span></span>' +
      '<button class="btn btn-primary btn-sm lobby-join" type="button">Join</button>';
    li.querySelector('button')!.addEventListener('click', () => this.onJoin(l.code));
    return li;
  }

  private fill(li: HTMLLIElement, l: Listing): void {
    setText(li.querySelector<HTMLElement>('.lobby-name')!, l.name);
    const meta = [`Room ${l.code}`, waitingFor(l.openedAt)];
    if (l.events) meta.push('⚡ events');
    setText(li.querySelector<HTMLElement>('.lobby-meta')!, meta.join(' · '));
    li.querySelector('button')!.setAttribute('aria-label', `Join ${l.name}'s room ${l.code}`);
  }
}
