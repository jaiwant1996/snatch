/**
 * Central tuning and networking constants.
 *
 * Every gameplay number lives here so the game can be tuned without touching
 * simulation code. Units: world units (logical pixels) and SECONDS unless the
 * name ends in `Ms`.
 */

export const WORLD = {
  width: 1000,
  height: 620,
  /** Playable rectangle inside the outer wall. */
  bounds: { left: 24, top: 24, right: 976, bottom: 596 },
} as const;

export const PLAYER = {
  radius: 19,
  maxSpeed: 240,
  /** How fast velocity approaches the target velocity while steering. */
  acceleration: 2600,
  /** How fast velocity decays to zero with no input. */
  friction: 2300,
  /** Speed multiplier while carrying the token (≈15% slower). */
  carrySpeedFactor: 0.85,
  /** Dash */
  dashDuration: 0.16,
  dashSpeedFactor: 2.4,
  dashCooldown: 1.3,
  /** Carrier dashes are slightly shorter so escaping is not free. */
  carrierDashFactor: 0.85,
  /** Extra reach added to body radii when testing a dash hit. */
  tackleReach: 6,
} as const;

export const TACKLE = {
  /** Knockback speed applied to a robbed carrier. */
  carrierKnockback: 520,
  carrierStun: 0.28,
  /** A dash into a non-carrier is only a shove. */
  bumpKnockback: 300,
  bumpStun: 0.12,
  /** After being hit, a player cannot be hit again for this long. */
  immunity: 0.9,
  /** Velocity the attacker keeps after landing a hit (fraction of dash speed). */
  attackerRecoil: 0.25,
  /** Head-on clash between two dashing players. */
  clashKnockback: 360,
} as const;

export const TOKEN = {
  radius: 11,
  /** No one can pick up a freshly dropped token for this long (300–400 ms). */
  pickupLockout: 0.35,
  dropSpeed: 260,
  friction: 520,
  bounce: 0.55,
} as const;

export const MATCH = {
  goalsToWin: 3,
  durationSeconds: 90,
  countdownSeconds: 3,
  /** Freeze after a goal before positions reset. */
  goalPauseSeconds: 1.5,
  /** Freeze at match end so the final goal animation can play. */
  endPauseSeconds: 1.2,
} as const;

/** Optional host-driven arena events. */
export const EVENTS = {
  /** First event this many seconds after kick-off, then every interval. */
  firstAfter: 18,
  interval: 22,
  duration: 7,
  boostPad: { radius: 30, speedFactor: 1.35, boostDuration: 1.8 },
  overdrive: { cooldownFactor: 0.45 },
} as const;

export const NET = {
  /** Appears in every handshake — bump when messages change incompatibly. */
  protocolVersion: 1,
  /**
   * Trystero application namespace. Peers only discover each other when this
   * matches exactly. If you fork SNATCH! and change gameplay, change this too.
   */
  appId: 'snatch-arcade-duel.v1.f3c9a2',
  roomPrefix: 'snatch-room-',
  simHz: 60,
  snapshotHz: 20,
  inputHz: 30,
  /** Guest gives up looking for a host after this long. */
  joinTimeoutMs: 25_000,
  handshakeTimeoutMs: 15_000,
  /** Host pauses the match if guest input stops arriving for this long. */
  guestStallMs: 1_500,
  /** Guest shows "connection unstable" if snapshots stop for this long. */
  hostStallMs: 1_500,
  /** Guest renders remote entities this far in the past. */
  interpolationDelayMs: 100,
  /** Seconds to wait before warning that the signalling relays are unreachable. */
  relayCheckMs: 9_000,
  /** Enable guest-side prediction of the guest's own movement. */
  guestPrediction: true,
} as const;

export const COLORS = {
  background: 0x121418,
  floor: 0x181b21,
  grid: 0x20242c,
  wall: 0x3a404c,
  obstacle: 0x2a2f39,
  obstacleEdge: 0x4b5262,
  cyan: 0x2ee6f0,
  cyanDeep: 0x0f7f88,
  orange: 0xff8a2a,
  orangeDeep: 0x9a4a0e,
  token: 0xfff3a0,
  tokenCore: 0xffffff,
  boost: 0xb9ff5c,
} as const;

/** Six-character codes; no O/0, I/1/L to avoid misreads. */
export const ROOM_CODE = {
  length: 6,
  alphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
} as const;
