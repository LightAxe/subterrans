/**
 * #229 — serializer completeness guard.
 *
 * Proves the `save-schema.ts` lists EXACTLY partition the live struct keys, and
 * that they stay tied to what `serializeWorldState` / `serializeAnts` actually
 * emit. A new `WorldState` / `AntComponents` field that nobody serialized (and
 * nobody deliberately allow-listed as transient) fails the struct-partition test
 * loudly — closing the "forgotten serialized field" gap that silently omitted six
 * `search*` fields until Phase 9 (see determinism.test.ts:75-83).
 *
 * This test lives in `platform/` and imports `save.ts` (same layer) + sim
 * factories (platform is above sim) — no boundary disable needed.
 */
import { describe, it, expect } from 'vitest';
import { createWorldState } from '../sim/types.js';
import { createScenario } from '../sim/scenario.js';
import { serializeWorldState, deserializeWorldState } from './save.js';
import {
  SERIALIZED_WORLD_FIELDS,
  TRANSIENT_WORLD_FIELDS,
  SERIALIZED_ANT_SOA_FIELDS,
  TRANSIENT_ANT_FIELDS,
} from './save-schema.js';

// Ring fields persisted via the packed `recentTiles` key rather than as themselves.
const RING_FIELDS = ['recentTilesX', 'recentTilesY', 'recentTilesHead'];

describe('serializer completeness (#229) — struct partition', () => {
  // NOTE: this partitions the RUNTIME keys via Object.keys(createWorldState/.ants).
  // An OPTIONAL field (`foo?: T`) that the factory leaves unassigned would not
  // appear in Object.keys and would silently dodge this guard — so every field must
  // be assigned by createWorldState/createAntComponents (even to `undefined`).
  // WorldState + AntComponents have ZERO optional fields today; keep it that way.
  it('every WorldState field is serialized xor deliberately transient', () => {
    const liveKeys = new Set(Object.keys(createWorldState(1337)));
    const listed = new Set<string>([
      ...(SERIALIZED_WORLD_FIELDS as readonly string[]),
      ...(TRANSIENT_WORLD_FIELDS as readonly string[]),
    ]);
    // unlisted → add to serializeWorldState + SERIALIZED_WORLD_FIELDS, OR to
    //            TRANSIENT_WORLD_FIELDS with a reason.
    // stale    → field no longer exists on WorldState; drop it from save-schema.
    const unlisted = [...liveKeys].filter((k) => !listed.has(k));
    const stale = [...listed].filter((k) => !liveKeys.has(k));
    expect({ unlisted, stale }).toEqual({ unlisted: [], stale: [] });
  });

  it('every AntComponents field is serialized xor deliberately transient', () => {
    const liveKeys = new Set(Object.keys(createWorldState(1337).ants));
    const listed = new Set<string>([
      ...(SERIALIZED_ANT_SOA_FIELDS as readonly string[]),
      ...(TRANSIENT_ANT_FIELDS as readonly string[]),
    ]);
    const unlisted = [...liveKeys].filter((k) => !listed.has(k));
    const stale = [...listed].filter((k) => !liveKeys.has(k));
    expect({ unlisted, stale }).toEqual({ unlisted: [], stale: [] });
  });

  it('serialized and transient lists are disjoint (world + ant)', () => {
    const worldOverlap = (SERIALIZED_WORLD_FIELDS as readonly string[]).filter((f) =>
      (TRANSIENT_WORLD_FIELDS as readonly string[]).includes(f),
    );
    const antOverlap = (SERIALIZED_ANT_SOA_FIELDS as readonly string[]).filter((f) =>
      (TRANSIENT_ANT_FIELDS as readonly string[]).includes(f),
    );
    expect({ worldOverlap, antOverlap }).toEqual({ worldOverlap: [], antOverlap: [] });
  });
});

describe('serializer completeness (#229) — serializer tie', () => {
  it('serializeWorldState emits exactly SERIALIZED_WORLD_FIELDS', () => {
    const emitted = new Set(Object.keys(serializeWorldState(createScenario(1337))));
    const listed = new Set(SERIALIZED_WORLD_FIELDS as readonly string[]);
    const extra = [...emitted].filter((k) => !listed.has(k));
    const missing = [...listed].filter((k) => !emitted.has(k));
    expect({ extra, missing }).toEqual({ extra: [], missing: [] });
  });

  it('serializeAnts emits SoA fields (ring packed) + count + the pathErr vestige', () => {
    // Expected emitted ant keys = `count` + every SoA field EXCEPT the ring trio
    // (persisted via the packed `recentTiles` key) + `recentTiles` + the
    // still-emitted `pathErr` zeros vestige (#243 — a serialization key with no
    // backing runtime field, so it is NOT in SERIALIZED_ANT_SOA_FIELDS).
    const expected = new Set<string>([
      'count',
      ...(SERIALIZED_ANT_SOA_FIELDS as readonly string[]).filter((f) => !RING_FIELDS.includes(f)),
      'recentTiles',
      'pathErr',
    ]);
    const emitted = new Set(Object.keys(serializeWorldState(createScenario(1337)).ants));
    const extra = [...emitted].filter((k) => !expected.has(k));
    const missing = [...expected].filter((k) => !emitted.has(k));
    expect({ extra, missing }).toEqual({ extra: [], missing: [] });
  });

  it('every serialized world field survives a serialize→deserialize round-trip', () => {
    const restored = deserializeWorldState(serializeWorldState(createScenario(1337)));
    const missing = (SERIALIZED_WORLD_FIELDS as readonly string[]).filter((f) => !(f in restored));
    expect(missing).toEqual([]);
  });
});
