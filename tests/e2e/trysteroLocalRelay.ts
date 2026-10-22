/**
 * TEST-ONLY replacement for the `trystero` import, used by `npm run build:e2e`.
 *
 * It swaps public Nostr signalling for a WebSocket relay on localhost so the
 * automated two-browser test runs without internet access. The game code,
 * protocol, handshake and WebRTC data channels are exactly the same as
 * production — only *peer discovery* is local. Never shipped in `npm run build`.
 */
import { joinRoom as wsJoinRoom, getRelaySockets, selfId } from '@trystero-p2p/ws-relay';
import type { JoinRoomCallbacks, JoinRoomConfig } from '@trystero-p2p/core';

export type * from '@trystero-p2p/core';

const RELAY = (import.meta.env.VITE_E2E_RELAY as string | undefined) ?? 'ws://127.0.0.1:8787';

export const joinRoom = (config: JoinRoomConfig, roomId: string, callbacks?: JoinRoomCallbacks) =>
  wsJoinRoom(
    {
      ...config,
      relayConfig: { urls: [RELAY] },
      // Headless Chromium on one machine: no STUN needed, loopback candidates only.
      rtcConfig: { iceServers: [] },
    },
    roomId,
    callbacks,
  );

export { getRelaySockets, selfId };
