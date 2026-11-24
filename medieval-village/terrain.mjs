// Medieval Village Kit — procedural farmed valley terrain.
//
// The ground under this kit is not wilderness: it is land that people have been
// working for four hundred years, and that is what separates it from the forest
// kit's woodland. So besides the rolling pasture and the river the village sits
// on, it carries LYNCHETS — the step-like banks that form on a slope where the
// same strips have been ploughed along the contour for centuries. They are the
// one landform in the catalogue made by farming rather than by weather.
import * as THREE from 'three';

/* === TERRAIN CORE v1 === (canonical copy; tools/terrain-sync.mjs vendors this
 * block verbatim into every kit's terrain module, and bin/terrain-check.mjs
 * refuses a build where any copy has drifted.)
 *
 * WHY A SHARED CORE AT ALL.
 *
 * A terrain generator per kit is easy. Terrain generators that JOIN are not,
 * and the joining cannot be bolted on later: it is a property of how every
 * generator computes its heights, so it has to be true of the first one.
 *
 * The contract is three fixed numbers and one rule.
 *
 *   CHUNK = 64 m.  One chunk is one square of world. 64 divides evenly by every
 *     kit module in the catalogue (4 m for NYC / Space Base / Retro Cars /
 *     Little Tokyo / Steampunk Farm / Coral Reef, 2 m for Medieval, 1 m for the
 *     farm kits), so a grid kit's floor tiles land exactly on chunk edges
 *     instead of half a tile over the seam. It is also about one kit diorama
 *     wide, which is what COMPOSE.md already asks for.
 *
 *   SKIRT = 4 m.  The band inside each edge where a kit's own character has to
 *     fade out. At the boundary itself the kit contributes exactly nothing.
 *
 *   res in {1, 2, 4} m.  Vertex pitch. Two chunks may only be joined at equal
 *     res: differing pitch means differing vertex counts along the seam, and no
 *     height rule can close that gap. The check tool tests every res and the
 *     assembler refuses a mismatch rather than emitting a crack.
 *
 * THE RULE: every generator's height is `baseHeight(worldX, worldZ, seed)` plus
 * its own displacement multiplied by a weight that is 0 on the boundary. So two
 * chunks from two different kits, placed side by side, agree vertex for vertex
 * along the seam, because both are evaluating the SAME pure function at the
 * same world coordinates. There is no registry, no neighbour handshake and no
 * runtime negotiation: joinability is a consequence of arithmetic.
 *
 * A consequence worth knowing: baseHeight already says where ocean is and where
 * land is, so a reef chunk is only placeable where the base is below zero. The
 * shared field sorts underwater kits from land kits instead of needing a rule.
 *
 * NO THREE.JS IN HERE. The core is pure arithmetic over plain arrays, so it can
 * be imported and diffed by a node test with no renderer, and so the kit module
 * above it owns every three.js decision. It also uses only +, -, *, /, floor
 * and sqrt: no sin, cos or pow, whose last bits are implementation-defined and
 * would let node and the browser disagree about a seam.
 */

export const TERRAIN_CORE_VERSION = 1;
export const CHUNK = 64;         // metres, square
export const SKIRT = 4;          // metres, taper band at each edge
/* Vertex pitches, finest first. 0.5 m exists for a SMALL block: a 64 m chunk at
 * half-metre pitch is the same 32k triangles a 256 m block spends at 2 m, so the
 * detail a buyer can have is a budget they spend on either size or sharpness. */
export const RESOLUTIONS = [0.5, 1, 2, 4];

/* ------------------------------------------------------------------ math */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/** Integer hash -> [0,1). Math.imul keeps this exact in 32-bit across engines. */
function hash2(ix, iz, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise, smoothstep-interpolated. Pure function of world position. */
function vnoise(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = smooth(x - x0), fz = smooth(z - z0);
  const a = hash2(x0, z0, seed), b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed), d = hash2(x0 + 1, z0 + 1, seed);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
}

/** Fractal sum of value noise, SPREAD to fill [0,1].
 *
 *  The spread is not cosmetic. A plain octave sum piles up around its own mean —
 *  measured here, 3 octaves put 90% of all values between 0.27 and 0.73 — so
 *  every threshold written against it means something far narrower than it
 *  looks, and a feature gated at "> 0.62" fires nearly everywhere instead of on
 *  the crests. That produced a first reef whose outcrops, cracks and channels
 *  all came out as one flat blanket 2 m above the seabed.
 *
 *  Summing octaves of independent noise shrinks the deviation by
 *  sqrt(sum of amp^2) / sum of amp, so dividing it back out gives the same
 *  spread at any octave count and lets callers treat 0.5 as the true middle. */
function fbm(x, z, seed, octaves = 3) {
  let sum = 0, amp = 1, norm = 0, sq = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += vnoise(x * f, z * f, (seed | 0) + i * 7919) * amp;
    norm += amp;
    sq += amp * amp;
    amp *= 0.5;
    f *= 2;
  }
  const gain = 1.3 * norm / Math.sqrt(sq);   // 1.3 puts one octave's p05/p95 on 0.05/0.95
  return clamp((sum / norm - 0.5) * gain + 0.5, 0, 1);
}

/** Value noise WITH its analytic derivative: [n, dn/dx, dn/dz].
 *
 *  Needed by erode(). The smoothstep weights are polynomials, so their
 *  derivatives are exact and cheap — no finite differences, which would be both
 *  slower and only approximately right at the lattice lines. */
function vnoiseD(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const tx = x - x0, tz = z - z0;
  const ux = smooth(tx), uz = smooth(tz);
  const dux = 6 * tx * (1 - tx), duz = 6 * tz * (1 - tz);   // d/dt of 3t^2-2t^3
  const a = hash2(x0, z0, seed), b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed), d = hash2(x0 + 1, z0 + 1, seed);
  const k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  return [a + k1 * ux + k2 * uz + k3 * ux * uz,
          dux * (k1 + k3 * uz),
          duz * (k2 + k3 * ux)];
}

/** EROSION-SHAPED noise: fbm whose octaves are damped by the slope accumulated
 *  so far, so detail dies on steep faces and survives in the flats.
 *
 *  Real hydraulic erosion is a grid simulation, and a grid simulation cannot be
 *  a pure function of (x, z) — which every height in this core has to be, or
 *  heightAt() stops working at arbitrary points and the join contract loses the
 *  one property it rests on. This is the standard analytic stand-in: dividing
 *  each octave by 1 + |accumulated gradient|^2 carves smooth valleys and leaves
 *  sharp crests, which is what erosion looks like from a distance and is free.
 *
 *  The paper that prompted it (arXiv:2608.05248) lists erosion beside peaks,
 *  dunes and terraces as a geomorphic operator over noise, which is exactly the
 *  shape this takes. */
export function erode(x, z, seed, octaves = 5) {
  let sum = 0, amp = 1, norm = 0, f = 1, dx = 0, dz = 0;
  for (let i = 0; i < octaves; i++) {
    const [n, nx, nz] = vnoiseD(x * f, z * f, (seed | 0) + i * 6151);
    dx += nx * f;
    dz += nz * f;
    sum += (amp * n) / (1 + 0.7 * (dx * dx + dz * dz));
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  /* SPREAD, for the same reason fbm is spread: the damping drags everything
   * down, so raw output sits around 0.33 with 90% of it between 0.15 and 0.54.
   * A caller writing "> 0.6 is a ridge" against that would be describing the top
   * 2% of the terrain rather than its crests. Measured across 3 to 6 octaves the
   * centre moves 0.357 to 0.324 and the gain 2.11 to 2.35, so one pair of
   * constants is honest across the useful range. */
  return clamp((sum / norm - 0.335) * 2.25 + 0.5, 0, 1);
}

/** Ridged noise: the |1 - 2n| fold that turns smooth hills into crests and
 *  gullies. Kits use it for rock formations and channel walls. */
function ridge(x, z, seed, octaves = 3) {
  const n = fbm(x, z, seed, octaves);
  const r = 1 - Math.abs(1 - 2 * n);
  return r * r;
}

/* ------------------------------------------------------- the shared field */

/** THE contract. Elevation of the world at (x, z) in metres, relative to sea
 *  level at y = 0. Every kit's terrain equals this exactly on its boundary.
 *
 *  Two scales only, deliberately: continent-scale masses that decide land from
 *  ocean, plus broad relief so a seam is never a dead-flat line. Everything
 *  finer is the kit's job, and the kit's job stops at the skirt.
 *
 *  Amplitudes are chosen so a chunk-sized window spans a workable 8-14 m of
 *  relief: enough that a seam is never a dead-flat line, little enough that a
 *  kit's own features are still the thing you look at. */
export function baseHeight(x, z, seed = 1) {
  const continent = fbm(x / 380, z / 380, seed, 4);
  const relief = fbm(x / 88, z / 88, (seed | 0) + 7717, 3);
  return (continent - 0.5) * 46 + (relief - 0.5) * 7;
}

/* ============================================================== RIVERS ==
 *
 * A river is a PROGRAM, not a blue stripe.
 *
 * The first stream here was a noise contour: wherever a warped fbm crossed 0.5,
 * cut a groove and paint it blue. That has two defects you cannot patch. It runs
 * uphill as happily as down, because a contour of noise knows nothing about
 * elevation; and its "water" was a colour on the sloping faceted bed, so it read
 * as a jagged blue sawtooth catching the light at a different angle on every
 * facet.
 *
 * This traces an actual watercourse. Sources sit on a coarse world lattice,
 * every one of them somewhere the shared field is above sea level, and each is
 * walked DOWNHILL along the gradient of baseHeight with a meander term added,
 * until it reaches the sea or runs out of steps. What comes back is a polyline
 * with an elevation that decreases monotonically, which gives three things a
 * contour cannot:
 *
 *   - the channel always descends, so the water in it is going somewhere;
 *   - it WIDENS and DEEPENS downstream, because a river gathers;
 *   - the water surface is the traced elevation, so it is level across the
 *     channel and falling along it, which is what water looks like.
 *
 * It is a pure function of the world seed, and the lattice is in WORLD
 * coordinates, so two neighbouring blocks trace the same river and it crosses
 * the seam instead of stopping at it.
 */

const RIVER_CELL = 380;      // metres between potential sources
const RIVER_STEP = 7;        // metres per traced step
const RIVER_MAX = 260;       // steps before a course gives up
const _riverCache = new Map();

/** Gradient of the shared field, by central difference. */
function baseGrad(x, z, seed, e = 6) {
  return [(baseHeight(x + e, z, seed) - baseHeight(x - e, z, seed)) / (2 * e),
          (baseHeight(x, z + e, seed) - baseHeight(x, z - e, seed)) / (2 * e)];
}

/** Every river course whose lattice cell touches the given world rectangle. */
function riverCourses(seed, x0, z0, x1, z1) {
  const c0 = Math.floor(x0 / RIVER_CELL) - 2, c1 = Math.floor(x1 / RIVER_CELL) + 2;
  const d0 = Math.floor(z0 / RIVER_CELL) - 2, d1 = Math.floor(z1 / RIVER_CELL) + 2;
  const out = [];
  for (let d = d0; d <= d1; d++) {
    for (let c = c0; c <= c1; c++) {
      const key = `${seed}:${c}:${d}`;
      let course = _riverCache.get(key);
      if (course === undefined) {
        course = traceRiver(seed, c, d);
        _riverCache.set(key, course);
      }
      if (course) out.push(course);
    }
  }
  return out;
}

/** Walk one source downhill. Returns null when the cell has no river in it. */
function traceRiver(seed, c, d) {
  let x = (c + 0.15 + 0.7 * hash2(c, d, seed + 61)) * RIVER_CELL;
  let z = (d + 0.15 + 0.7 * hash2(c, d, seed + 62)) * RIVER_CELL;
  /* CLIMB TO A SOURCE FIRST. Dropped straight onto the lattice point, a course
   * starts wherever that point happens to sit — which is usually most of the way
   * down already, so it reaches the sea in thirty steps and the whole river is
   * 90 m long with a 6 m drop. Walking UP the gradient first finds the local
   * high ground that a real catchment drains from, and the course that follows
   * is long because it has the whole hillside to come down. */
  for (let i = 0; i < 60; i++) {
    const [gx, gz] = baseGrad(x, z, seed);
    const len = Math.sqrt(gx * gx + gz * gz);
    if (len < 0.004) break;                    // a summit, or flat: stop climbing
    x += (gx / len) * RIVER_STEP;
    z += (gz / len) * RIVER_STEP;
  }
  // A river starts in high ground. Below this the catchment is a coastal flat,
  // and tracing it produces a puddle that wanders the shoreline.
  if (baseHeight(x, z, seed) < 8) return null;
  const pts = [];
  let stalled = 0, bestY = Infinity;
  for (let i = 0; i < RIVER_MAX; i++) {
    const y = baseHeight(x, z, seed);
    pts.push([x, z, y]);
    if (y < -1.5) break;                       // reached the sea
    /* A course that stops descending is going round a basin, not flowing. Left
     * unguarded it spends its whole step budget circling: measured, one course
     * walked 1,820 m of steps inside a 44 m box. */
    if (y < bestY - 0.05) { bestY = y; stalled = 0; } else if (++stalled > 12) break;
    const [gx, gz] = baseGrad(x, z, seed);
    const len = Math.sqrt(gx * gx + gz * gz);
    /* No fall line, no river. Water does not flow across flat ground, it pools,
     * and a course that keeps walking anyway is steered entirely by its meander
     * term — which is a constant turn, so it goes round in a circle. Measured
     * with the meander at +-40 degrees: courses spending 28 steps inside a 9 m
     * box. Ending the course here is both cheaper and more truthful. */
    if (len < 0.004) break;
    const fx = -gx / len, fz = -gz / len;
    /* And the meander stays small enough that the fall line always wins. At
     * +-17 degrees the course is sinuous; past about 30 it starts to spiral on
     * any ground gentle enough to let it. */
    const m = (fbm(x / 90, z / 90, seed + 811, 2) - 0.5) * 0.6;
    /* A ROTATION of the fall line, so the course bends without ever turning back
     * uphill. Written in place as `dx += -dz*m; dz += dx*m` it is not a rotation
     * at all: the second line reads the dx the first line just changed, which
     * compounds the turn every step and spirals the river. */
    let dx = fx - fz * m, dz = fz + fx * m;
    const dl = Math.sqrt(dx * dx + dz * dz) || 1;
    x += (dx / dl) * RIVER_STEP;
    z += (dz / dl) * RIVER_STEP;
  }
  if (pts.length < 8) return null;
  /* Elevation is forced MONOTONIC. The traced ground can rise slightly through a
   * meander or a noise bump, and water that climbs even 20 cm ruins the whole
   * illusion, so the surface only ever falls. */
  let run = pts[0][2];
  for (const p of pts) { run = Math.min(run, p[2]); p[2] = run; }
  return pts;
}

/** Distance from a point to ONE segment of a course, plus how far down the
 *  course that is. Null when the point is out of reach of this segment. */
function segNear(pts, i, x, z, reach) {
  const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
  const vx = bx - ax, vz = bz - az;
  const vv = vx * vx + vz * vz;
  let t = vv > 0 ? ((x - ax) * vx + (z - az) * vz) / vv : 0;
  t = clamp(t, 0, 1);
  const px = ax + vx * t, pz = az + vz * t;
  const dd = (x - px) * (x - px) + (z - pz) * (z - pz);
  if (dd > reach * reach) return null;
  return { d2: dd, i, t, px, pz, y: lerp(pts[i][2], pts[i + 1][2], t), frac: (i + t) / (pts.length - 1) };
}

/**
 * The river system over one block. Hand the result to buildChunk:
 *
 *   const river = makeRiver({ seed, x0, z0, x1, z1, width: 6, depth: 2.6 });
 *   features: [{ name: 'river', height: river.carve }]
 *   water: { levelAt: river.levelAt, color: [...] }
 *
 * `width` and `depth` are the values at the MOUTH; upstream is narrower and
 * shallower in proportion, because that is the one thing everybody notices when
 * it is missing.
 */
export function makeRiver(o = {}) {
  const seed = (o.seed ?? 1) | 0;
  const wMax = o.width ?? 6;
  const dMax = o.depth ?? 2.6;
  const bank = o.bank ?? 3.5;                   // metres of graded bank each side
  /* Reach is a HALF width plus the bank, not a full width plus the bank. Using
   * the full width made the wetted area about 30 m across for a 7 m river,
   * because everything lower than the water line within reach of the course
   * counts as wet. */
  const reach = wMax / 2 + bank + 1;
  /* Keep only the courses that actually reach this block, and only the biggest
   * couple of those. Every traced course within two lattice cells used to be
   * carved, which put thirteen of them through one 128 m block: the water came
   * out as a braided marsh rather than a river, because that is what thirteen
   * overlapping channels at slightly different levels look like. A landscape
   * gets one river and maybe a tributary. */
  const x0 = o.x0 ?? -1e4, z0 = o.z0 ?? -1e4, x1 = o.x1 ?? 1e4, z1 = o.z1 ?? 1e4;
  const near = riverCourses(seed, x0, z0, x1, z1).filter((pts) => {
    for (const [px, pz] of pts) {
      if (px > x0 - reach && px < x1 + reach && pz > z0 - reach && pz < z1 + reach) return true;
    }
    return false;
  });
  near.sort((a, b) => b.length - a.length);
  const courses = near.slice(0, o.maxCourses ?? 2);

  /* A SPATIAL INDEX over the segments, because the naive version is unusable:
   * every height sample would test every segment of every course, which at 16
   * courses of 260 points against a 128 m block at 1 m pitch is about 65 million
   * segment tests for one build. Bucketed by cell, a sample tests the handful of
   * segments that could possibly be within reach. */
  const CELL = 24;
  const grid = new Map();
  const put = (cx2, cz2, seg) => {
    const k = cx2 + ',' + cz2;
    const a = grid.get(k);
    if (a) a.push(seg); else grid.set(k, [seg]);
  };
  for (const pts of courses) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const x0s = Math.min(pts[i][0], pts[i + 1][0]) - reach;
      const x1s = Math.max(pts[i][0], pts[i + 1][0]) + reach;
      const z0s = Math.min(pts[i][1], pts[i + 1][1]) - reach;
      const z1s = Math.max(pts[i][1], pts[i + 1][1]) + reach;
      for (let cz2 = Math.floor(z0s / CELL); cz2 <= Math.floor(z1s / CELL); cz2++) {
        for (let cx2 = Math.floor(x0s / CELL); cx2 <= Math.floor(x1s / CELL); cx2++) {
          put(cx2, cz2, [pts, i]);
        }
      }
    }
  }

  /** The nearest course at this point, or null. */
  function at(x, z) {
    const segs = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
    if (!segs) return null;
    let best = null;
    for (const [pts, i] of segs) {
      const n = segNear(pts, i, x, z, reach);
      if (n && (!best || n.d2 < best.d2)) best = n;
    }
    return best;
  }

  /** Height displacement: the cut. Negative inside the channel, tapering up
   *  through the bank to nothing. */
  function carve(x, z) {
    const n = at(x, z);
    if (!n) return 0;
    // Downstream growth: a quarter of full at the source, full at the mouth.
    const grow = 0.25 + 0.75 * n.frac;
    const half = wMax * grow / 2;
    const dist = Math.sqrt(n.d2);
    if (dist > half + bank) return 0;
    const t = dist <= half ? 1 : 1 - (dist - half) / bank;
    return -smooth(clamp(t, 0, 1)) * dMax * grow;
  }

  /* The water line is measured on the COURSE, at the nearest point on it, which
   * is what makes the surface flat across the channel however lumpy the bed is.
   *
   * And it is measured from the surface the kit actually built, not from the
   * bare shared field. The channel is cut as a displacement on top of whatever
   * else the kit raised there, so a hillock lifts the bed with it; measuring the
   * water from the bare field then leaves the river running dry across every
   * rise. Measured: 6 wet quads in a whole 128 m block that should have had
   * about 600. `surfaceAt` is the kit's dry terrain height. */
  const surf = typeof o.surfaceAt === 'function' ? o.surfaceAt : null;
  function levelAt(x, z) {
    const n = at(x, z);
    if (!n) return -1e6;                        // never wet
    const grow = 0.25 + 0.75 * n.frac;
    const bed = surf ? surf(n.px, n.pz) : n.y;
    return bed - dMax * grow * 0.45;            // below the bank lip, above the bed
  }

  return { carve, levelAt, courses, count: courses.length };
}

/** 0 on the block boundary, 1 once you are SKIRT metres inside it. `w` is the
 *  block's width in metres: one chunk, or several when `span` is up. Only the
 *  OUTER edge of a block is a seam with anybody; the chunk lines inside it are
 *  not boundaries at all, because one continuous height function crosses them. */
function skirtWeight(lx, lz, w) {
  const d = Math.min(lx, lz, w - lx, w - lz);
  return smooth(clamp(d / SKIRT, 0, 1));
}

/** Island rim mask: 1 in the middle, 0 outside an irregular noise-warped
 *  outline. This is what makes the store presentation a floating island rather
 *  than a square of ground, and it is a KNOB (edges: 'island'), not a separate
 *  program: the same features, palette and pads run underneath either edge. */
function islandMask(lx, lz, seed, w) {
  // Sampled in a normalised 64 m space, so the silhouette keeps the same shape
  // at any block size instead of a 128 m island growing twice the wobble.
  const u = lx * CHUNK / w, v = lz * CHUNK / w;
  const dx = u - CHUNK / 2, dz = v - CHUNK / 2;
  const r = Math.sqrt(dx * dx + dz * dz) / (CHUNK / 2);
  const wob = fbm(u / 17, v / 17, (seed | 0) + 4241, 3);
  const rim = 0.48 + wob * 0.34;          // 0.48..0.82 of the half-width
  return clamp((rim - r) / 0.09, 0, 1);
}

/** 1 inside a pad rect, ramping to 0 `blend` metres outside it. */
function padWeight(wx, wz, p, blend) {
  const dx = Math.abs(wx - p.x) - p.w / 2;
  const dz = Math.abs(wz - p.z) - p.d / 2;
  const d = Math.max(dx, dz);
  if (d <= 0) return 1;
  if (d >= blend) return 0;
  return smooth(1 - d / blend);
}

/* ------------------------------------------------------------- the build */

/**
 * Build one chunk.
 *
 *   buildChunk({
 *     cx, cz,          // chunk coordinates in the world grid (integers)
 *     seed,            // world seed; chunks only join if they share it
 *     res,             // 1 | 2 | 4 metres per quad
 *     edges,           // 'tile' (joins) | 'island' (floats, store presentation)
 *     features,        // [{ name, height(x,z,ctx), paint(x,z,h,ny,ctx) }]
 *     bands,           // [{ upTo, color:[r,g,b] }] ascending, last is catch-all
 *     cliff,           // [r,g,b] used where the face is steeper than cliffAngle
 *     cliffAngle,      // degrees from horizontal
 *     pads,            // [{ x, z, w, d, y? }] flattened buildable areas
 *     padBlend,        // metres of ramp around each pad
 *     skirtDepth,      // island only: how far the sides fall before stopping
 *   })
 *
 * Returns plain arrays plus the query functions a composer needs. Nothing here
 * knows what a Mesh is.
 */
export function buildChunk(o = {}) {
  const cx = o.cx | 0, cz = o.cz | 0;
  const seed = (o.seed ?? 1) | 0;
  let res = o.res ?? 2;
  if (!RESOLUTIONS.includes(res)) {
    throw new Error(`terrain: res must be one of ${RESOLUTIONS.join(', ')}, got ${res}`);
  }
  const edges = o.edges === 'island' ? 'island' : 'tile';
  /* SPAN: how many chunks across this block is. The join contract is unchanged,
   * because a block's outer edge still falls on chunk lines and still equals
   * baseHeight() there — so a 1-chunk block and a 2-chunk block join each other
   * as happily as two singles. The chunk lines INSIDE a block are not seams at
   * all: one continuous height function crosses them, with no taper. */
  const span = clamp(Math.round(o.span ?? 1), 1, 4);
  const W = CHUNK * span;                      // block width in metres
  /* Size and detail MULTIPLY, so the two knobs together decide the triangle
   * count and either one alone looks harmless. A 256 m block at 1 m pitch is
   * 131,072 triangles, four times the store's ceiling. The block is capped at
   * 128 quads a side and the pitch coarsens to hold it, which is what a buyer
   * dragging the size slider expects anyway: more ground, not more detail. */
  const MAX_QUADS = 128;
  const features = o.features ?? [];
  const bands = (o.bands ?? [{ upTo: Infinity, color: [0.5, 0.5, 0.5] }]).slice()
    .sort((a, b) => a.upTo - b.upTo);
  const cliff = o.cliff ?? null;
  const cliffCos = Math.cos(((o.cliffAngle ?? 38) * Math.PI) / 180);
  const padBlend = o.padBlend ?? 3;
  const skirtDepth = o.skirtDepth ?? 3.5;

  /* Coarsen to the next pitch ON THE LADDER, never to an arbitrary number. The
   * first version divided W by the cap, which handed a 192 m block a pitch of
   * 1.5 m: not a value any other block can be built at, so nothing could join
   * it. Joins need both sides on the same rung. */
  while (W / res > MAX_QUADS) {
    const next = RESOLUTIONS.filter((r) => r > res).sort((a, b) => a - b)[0];
    if (!next) break;
    res = next;
  }

  const ox = cx * CHUNK, oz = cz * CHUNK;
  const ctx = { CHUNK, SKIRT, seed, cx, cz, ox, oz, res, hash2, vnoise, vnoiseD, fbm, ridge, erode, baseHeight, clamp, smooth, lerp };

  /* Pads are resolved once, here, because a pad whose height depended on where
   * you sampled it would not be flat. An explicit y wins; otherwise the pad
   * takes the untouched terrain height at its centre, snapped to 25 cm so a
   * building sits on a round number. */
  const pads = (o.pads ?? []).map((p) => {
    const pad = { x: p.x, z: p.z, w: p.w, d: p.d, y: p.y };
    if (edges === 'tile') {
      // A pad that reached the boundary would flatten the seam and break the
      // join for every neighbour. Refuse loudly rather than ship a bad edge.
      const lx = pad.x - ox, lz = pad.z - oz;
      const near = Math.min(lx - pad.w / 2, lz - pad.d / 2, W - (lx + pad.w / 2), W - (lz + pad.d / 2));
      if (near - padBlend < SKIRT) {
        throw new Error(`terrain: pad at (${p.x}, ${p.z}) reaches inside the ${SKIRT}m skirt; move it or shrink it`);
      }
    }
    return pad;
  });

  /** Height with features but WITHOUT pads: what a pad's own level is read from.
   *
   *  `shape` runs after the features and sees the ACCUMULATED height, which is
   *  what terracing needs: snapping relief to a kit's step height is a statement
   *  about the total, not a displacement you can add. It is blended by the same
   *  skirt weight, so it cannot disturb the seam either. */
  /* FLATTEN clears a LEVEL AREA IN THE MIDDLE, for a town to stand on.
   *
   * Not a global level. Levelling the whole block gives you a plain, and a plain
   * is not what a scene needs: what it needs is somewhere buildable with real
   * landscape around it, so the village sits in a valley floor or on a shelf
   * rather than on a table (owner, 2026-08-11).
   *
   * The knob is the SIZE of that clearing, as a fraction of the block's
   * half-width, with a soft rim so the ground rises out of it instead of
   * stepping. It reaches the shared field's own slope, not just the kit's
   * features: that slope runs 8 to 14 m across a block and is most of what makes
   * ground unbuildable, so a clearing that skipped it would still be a hillside.
   *
   * THE EDGES ARE NEVER TOUCHED, twice over. The clearing plus its rim is capped
   * so it cannot reach within SKIRT of the boundary, and the pull is multiplied
   * by the skirt weight anyway, which is zero there. A block with a town levelled
   * into it still meets its neighbours on the shared field exactly, which
   * bin/terrain-check.mjs keeps proving at delta 0.
   */
  const erosion = clamp(o.erosion ?? 0, 0, 1);
  const erosionDepth = o.erosionDepth ?? 3.2;      // metres at full strength
  const erosionScale = o.erosionScale ?? 34;       // metres per cycle of the coarsest octave
  const flatten = clamp(o.flatten ?? 0, 0, 1);
  const FEATHER = 0.22;                       // rim width, in the same fraction units
  // Cap so the clearing plus its rim stays clear of the skirt band.
  const flatMax = Math.max(0, (W / 2 - SKIRT - 2) / (W / 2)) - FEATHER;
  const flatR = Math.min(flatten * 0.95, flatMax);
  const fcx = ox + W / 2, fcz = oz + W / 2;

  /** 1 inside the clearing, 0 outside its rim. */
  function flatMask(wx, wz) {
    if (flatR <= 0) return 0;
    const dx = (wx - fcx) / (W / 2), dz = (wz - fcz) / (W / 2);
    const r = Math.sqrt(dx * dx + dz * dz);
    return smooth(clamp((flatR + FEATHER - r) / FEATHER, 0, 1));
  }

  /** The surface BEFORE the clearing is cut into it. Separated because the
   *  clearing's own level is read off it: a level derived from a height that
   *  already includes the clearing would chase itself. */
  function preFlat(wx, wz) {
    const base = baseHeight(wx, wz, seed);
    const w = edges === 'tile' ? skirtWeight(wx - ox, wz - oz, W) : 1;
    if (w <= 0) return base;
    let h = base;
    for (const f of features) if (f.height) h += w * f.height(wx, wz, ctx);
    if (o.shape) h = lerp(h, o.shape(h, wx, wz, ctx), w);
    /* EROSION, applied after the kit has built its landforms, because erosion
     * acts on what is there rather than being one more thing that is there.
     * Symmetric about the operator's midpoint, so crests go up and valleys go
     * down rather than the whole block sinking. It does not come out exactly
     * balanced — measured on one chunk, full strength moves the median relief to
     * about -1m — because the operator's own median sits near 0.46 rather than
     * 0.5 and varies by region. That residue is erosion removing material, which
     * is what it is for, and a metre at full strength is small against the 8-14m
     * a block spans.
     * Multiplied by the skirt weight like everything else, so an eroded block
     * still meets its neighbours on the shared field exactly. */
    if (erosion > 0) h += w * erosion * erosionDepth * (erode(wx / erosionScale, wz / erosionScale, seed + 4457, 5) - 0.5) * 2;
    return h;
  }

  /* The clearing sits at the MEAN of the ground it replaces, so it beds into the
   * landscape instead of cutting a step. Snapped to a whole 25 cm, because a
   * building put down on it should land on a round number. */
  let flatY = 0;
  if (flatR > 0) {
    let sum = 0, n = 0;
    const rad = flatR * (W / 2);
    for (let j = -2; j <= 2; j++) {
      for (let i = -2; i <= 2; i++) {
        if (i * i + j * j > 4) continue;                 // stay inside the circle
        sum += preFlat(fcx + (i * rad) / 2, fcz + (j * rad) / 2);
        n++;
      }
    }
    flatY = Math.round((sum / n) * 4) / 4;
  }

  function rawHeight(wx, wz) {
    const h = preFlat(wx, wz);
    if (flatR <= 0) return h;
    const w = edges === 'tile' ? skirtWeight(wx - ox, wz - oz, W) : 1;
    return lerp(h, flatY, flatMask(wx, wz) * w);
  }
  /* AUTOMATIC FLAT AREAS.
   *
   * The rest of the catalogue is FLAT-BOTTOMED. A building, a road tile, a
   * plaza slab and a wall module all assume they are put down on level ground,
   * because that is what a floor tile is. Procedural terrain that is level
   * nowhere is terrain none of those parts can stand on: one corner floats, or
   * the near edge buries itself, and the buyer is left levelling ground by hand
   * for every piece they place. That makes the generator a liability rather
   * than the thing the kit sits on.
   *
   * So flat areas are not an optional extra, they are part of what terrain owes
   * the kit. They are FOUND rather than placed: the flattest low-slope spots
   * the terrain already has get levelled the rest of the way, so a building
   * site looks like somewhere a builder would have chosen instead of a rectangle
   * stamped through a hillside.
   *
   * Snapped to the kit's own module where it has one, so a 4 m tile run lands on
   * the pad edge rather than half a tile over it.
   */
  const flatN = Math.max(0, Math.round(o.flats ?? 0));
  if (flatN > 0) {
    const snap = o.flatSnap || 4;                       // the kit's module, usually
    const size = Math.max(snap, Math.round((o.flatSize ?? 16) / snap) * snap);
    // Stay clear of the seam: the pad plus its ramp must not reach the skirt.
    const lo = SKIRT + padBlend + size / 2;
    const hi = W - lo;
    const cand = [];
    if (hi > lo) {
      for (let k = 0; k < 160; k++) {
        // Snapped candidate centres, so the pad's EDGES land on module lines.
        const cxl = Math.round((lo + hash2(k, 17, seed) * (hi - lo)) / snap) * snap + (size / 2) % snap;
        const czl = Math.round((lo + hash2(k, 83, seed + 5) * (hi - lo)) / snap) * snap + (size / 2) % snap;
        if (cxl < lo || cxl > hi || czl < lo || czl > hi) continue;
        const wx = ox + cxl, wz = oz + czl;
        if (edges === 'island' && islandMask(cxl, czl, seed, W) < 0.9) continue;  // not on the rim
        /* And not in the river. A pad levels the ground it covers, so one laid
         * across a watercourse flattens the channel and the water spreads out
         * over the whole pad as a rectangular lagoon. */
        if (o.flatAvoid && o.flatAvoid(ox + cxl, oz + czl, size / 2 + padBlend)) continue;
        // Roughness: how far the ground already departs from its own mean here.
        let sum = 0, n = 0, mn = Infinity, mx = -Infinity;
        for (let a = -1; a <= 1; a++) {
          for (let b = -1; b <= 1; b++) {
            const h = rawHeight(wx + a * size / 2, wz + b * size / 2);
            sum += h; n++;
            if (h < mn) mn = h;
            if (h > mx) mx = h;
          }
        }
        cand.push({ x: wx, z: wz, mean: sum / n, spread: mx - mn });
      }
    }
    cand.sort((a, b) => a.spread - b.spread);
    const gap = size + padBlend * 2;
    for (const c of cand) {
      if (pads.length >= flatN) break;
      if (pads.some((p) => Math.abs(p.x - c.x) < gap && Math.abs(p.z - c.z) < gap)) continue;
      pads.push({ x: c.x, z: c.z, w: size, d: size, y: Math.round(c.mean * 4) / 4, auto: true });
    }
  }

  for (const p of pads) {
    if (p.y === undefined || p.y === null) p.y = Math.round(rawHeight(p.x, p.z) * 4) / 4;
  }

  /** The full height field, pads included. The mesh and heightAt() share it, so
   *  a part placed with heightAt() sits on the ground and not near it. */
  function sampleHeight(wx, wz) {
    let h = rawHeight(wx, wz);
    for (const p of pads) {
      const w = padWeight(wx, wz, p, padBlend);
      if (w > 0) h = lerp(h, p.y, w);
    }
    return h;
  }

  /* The FINISHED ground, handed to whoever computes a water line.
   *
   * A water level worked out from the kit's own feature functions is a level
   * measured against a surface that does not exist: terrace snapping, erosion,
   * the clearing and the pads all move the ground afterwards, by metres. A pool
   * whose level was read off the pre-shape height then stands proud of the
   * ground beside it, which is exactly what the owner photographed. Anything
   * that has to compare water against land must compare it against THIS. */
  ctx.groundAt = sampleHeight;

  /* --------------------------------------------------------- vertex grid */

  const N = W / res;                          // quads per side
  const S = N + 1;                            // vertices per side
  const hs = new Float64Array(S * S);
  const mask = edges === 'island' ? new Float64Array(S * S) : null;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const wx = ox + i * res, wz = oz + j * res;
      hs[j * S + i] = sampleHeight(wx, wz);
      if (mask) mask[j * S + i] = islandMask(i * res, j * res, seed, W);
    }
  }

  /* --------------------------------------------------------------- mesh */

  const pos = [];
  const col = [];
  const vx = (i) => ox + i * res;
  const vz = (j) => oz + j * res;
  const vy = (i, j) => hs[j * S + i];

  /* What the height bands are measured against.
   *
   *  'relief' (the default) bands by height ABOVE THE NATURAL FLOOR, so sand is
   *  wherever the kit added nothing, crust is on what it raised and the dark
   *  band is what it cut. Absolute height cannot express that: the same chunk
   *  slopes 10 m across its own width, so a fixed set of world heights paints
   *  one half of it as summit and the other as trench regardless of what the
   *  kit actually built there. 'height' stays available for a kit whose colour
   *  really is depth (a snow line, a tide mark). */
  const byRelief = (o.bandBy ?? 'relief') === 'relief';

  /* EDGE COLOUR BLENDING between neighbouring kits.
   *
   * Height must match exactly at a seam; colour must not. Two kits meeting on a
   * hard line reads as a biome border, which is often right, but a reef running
   * into a beach wants to fade. Colour has no geometric consequence, so unlike
   * height it is free to know about its neighbour: the assembler passes the tone
   * on the other side and each block blends toward it.
   *
   * THE WEIGHT REACHES 0.5 AT THE SEAM, NOT 1, and that is the whole trick. At 1
   * each block would paint the seam entirely in its NEIGHBOUR's colour, which
   * swaps the two rather than blending them and leaves a hard line in exactly
   * the same place. At 0.5 both sides arrive at the same half-and-half mix, so
   * the colour is continuous across the join without either block knowing what
   * the other actually computed.
   *
   * A side may be given either a TONE or the neighbour's own colour FUNCTION:
   *
   *   blend: { east: [r,g,b],                 width: 14 }   // approximate
   *   blend: { east: neighbour.colorAt,       width: 14 }   // exact
   *
   * The tone is cheap and gets most of the way (measured on a reef meeting a
   * forest: the seam difference drops from 0.575 to 0.078). It cannot reach zero
   * because each side blends toward the OTHER's average ground rather than
   * toward what the other actually painted at that spot, and at the seam the
   * local colour is often a cliff or a crack rather than ground.
   *
   * The function is exact. Both sides then compute lerp(mine, theirs, 0.5) from
   * the same two values and land on the same colour to the bit.
   */
  const blend = o.blend ?? null;
  const blendW = blend ? (blend.width ?? 14) : 0;
  function blended(c, wx, wz, hy, ny) {
    if (!blend || blendW <= 0) return c;
    const lx = wx - ox, lz = wz - oz;
    let out = c;
    /* The neighbour is asked about the MIRRORED point, not this one.
     *
     * Colour is decided per face from its centroid, and the two blocks' edge
     * faces have centroids on opposite sides of the line: 127.5 here, 128.5
     * there. Asking the neighbour about 127.5 and letting it ask us about 128.5
     * compares two different places, and the seam stayed 0.024 apart however
     * exact the rest of the arithmetic was. Mirroring makes both sides mix the
     * SAME pair of points at the same weight, so they agree exactly. */
    const sides = [
      ['west', lx, [2 * ox - wx, wz]],
      ['east', W - lx, [2 * (ox + W) - wx, wz]],
      ['north', lz, [wx, 2 * oz - wz]],
      ['south', W - lz, [wx, 2 * (oz + W) - wz]],
    ];
    for (const [side, d, mirror] of sides) {
      const other = blend[side];
      if (!other || d >= blendW || d < 0) continue;
      const t = typeof other === 'function' ? other(mirror[0], mirror[1]) : other;
      if (!t) continue;
      const w = 0.5 * smooth(1 - d / blendW);
      out = [lerp(out[0], t[0], w), lerp(out[1], t[1], w), lerp(out[2], t[2], w)];
    }
    return out;
  }

  function faceColor(cxw, czw, hy, ny) {
    // Features paint last-wins, so a crack drawn after a rock formation reads as
    // a crack. A feature that returns nothing leaves the height bands alone.
    for (let k = features.length - 1; k >= 0; k--) {
      const c = features[k].paint?.(cxw, czw, hy, ny, ctx);
      if (c) return blended(c, cxw, czw, hy, ny);
    }
    if (cliff && ny < cliffCos) return blended(cliff, cxw, czw, hy, ny);
    /* Relief is measured against the ground the CLEARING REPLACED, not against
     * the bare world field. Levelling moves the surface away from that field by
     * design, so banding on the raw difference paints the clearing as trench on
     * one side and summit on the other: a village site came out as a brown mud
     * pit ringed in meadow. Adding back how far the clearing moved the ground
     * restores the colour the terrain had there, which is what a levelled site
     * should look like. Outside the clearing the correction is exactly zero. */
    const lift = flatR > 0 ? preFlat(cxw, czw) - rawHeight(cxw, czw) : 0;
    const v = byRelief ? hy - baseHeight(cxw, czw, seed) + lift : hy;
    for (const b of bands) if (v <= b.upTo) return blended(b.color, cxw, czw, hy, ny);
    return blended(bands[bands.length - 1].color, cxw, czw, hy, ny);
  }

  function emitTri(ax, ay, az, bx, by, bz, cxx, cy, cz2) {
    /* Flat shading is the house look, and the colour is part of it: one tone per
     * FACE, decided from its own centroid and normal.
     *
     * Per-VERTEX colour was tried, so that height bands would blend across a
     * triangle instead of stepping at its edge. It is worse. The gradients read
     * as low quality against a catalogue of crisp flat facets — the whole look
     * depends on every face being one flat colour, and a terrain that softens
     * them stops matching the models standing on it (owner, 2026-08-11). The
     * banding staircase it was meant to fix is better fixed with the bands
     * themselves, or with a finer pitch.
     *
     * REVISITED 2026-09-20, and the two decisions do not conflict. What failed
     * above was a gradient inside a FLAT-shaded triangle. Shown three renders of
     * the Space Base ground side by side (/bench.php, "Look tests", 3a-3c), the
     * owner chose smooth NORMALS with colour blended at the vertex, never across
     * a crease: with smooth shading it is a colour per FACE that looks wrong (it
     * reads as tiles), and ground is the one thing here that is not an object,
     * so its facets are tessellation showing rather than style. The parts keep
     * theirs. That treatment is applied AFTER this function, at run time, by
     * softenTerrain() in public/stage.mjs (buildKit does it to a kit's terrain
     * by default), so this core still emits one flat colour per face and every
     * published terrain, seam check and store render is unchanged. Moving it in
     * here means regenerating and re-rendering every kit's terrain and teaching
     * bin/terrain-check.mjs that seam colours now agree per vertex: a job to do
     * on purpose, not as a side effect. */
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx2 = cxx - ax, wy = cy - ay, wz2 = cz2 - az;
    let nx = uy * wz2 - uz * wy, ny = uz * wx2 - ux * wz2, nz = ux * wy - uy * wx2;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    ny /= len;
    const c = faceColor((ax + bx + cxx) / 3, (az + bz + cz2) / 3, (ay + by + cy) / 3, ny);
    pos.push(ax, ay, az, bx, by, bz, cxx, cy, cz2);
    for (let k = 0; k < 3; k++) col.push(c[0], c[1], c[2]);
  }

  const kept = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (mask) {
        // A quad survives if any corner is inside the rim; that keeps the
        // outline ragged at quad scale instead of eroding it to a soft circle.
        const m = Math.max(mask[j * S + i], mask[j * S + i + 1], mask[(j + 1) * S + i], mask[(j + 1) * S + i + 1]);
        if (m <= 0) continue;
      }
      kept[j * N + i] = 1;
    }
  }

  /* The outline, needed BEFORE any face is emitted because it is what sets how
   * deep the island goes. A directed edge is on the outline when its reverse is
   * not owned by any kept quad; using DIRECTED edges also hands us the outward
   * side for free, so the wall never comes out inside-out. */
  const key = (i0, j0, i1, j1) => `${i0},${j0},${i1},${j1}`;
  const dir = new Set();
  const outline = [];
  let floorAt = null;
  if (edges === 'island') {
    /* Trim spurs: quads hanging off the body by a single edge, plus quads that
     * are alone entirely. They look like stray teeth on the silhouette, and they
     * are also unbuildable — a one-quad tab makes the outline run out and back
     * along the same line, which is a polygon with no area, and no triangulation
     * of it exists that is not degenerate. Two passes clears the tabs a radial
     * mask actually produces without eating into the landmass. */
    const nbrs = (i, j) =>
      (i > 0 && kept[j * N + i - 1] ? 1 : 0) + (i < N - 1 && kept[j * N + i + 1] ? 1 : 0) +
      (j > 0 && kept[(j - 1) * N + i] ? 1 : 0) + (j < N - 1 && kept[(j + 1) * N + i] ? 1 : 0);
    for (let pass = 0; pass < 2; pass++) {
      const drop = [];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        if (kept[j * N + i] && nbrs(i, j) < 2) drop.push(j * N + i);
      }
      if (!drop.length) break;
      for (const k of drop) kept[k] = 0;
    }

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (!kept[j * N + i]) continue;
        dir.add(key(i, j, i, j + 1));
        dir.add(key(i, j + 1, i + 1, j + 1));
        dir.add(key(i + 1, j + 1, i + 1, j));
        dir.add(key(i + 1, j, i, j));
      }
    }
    for (const e of dir) {
      const [i0, j0, i1, j1] = e.split(',').map(Number);
      if (dir.has(key(i1, j1, i0, j0))) continue;   // interior: shared by two quads
      outline.push([i0, j0, i1, j1]);
    }
    /* The underside is a constant-thickness slab following the SHARED FIELD, not
     * a flat plate at one height.
     *
     * Two earlier tries were worse. Measured from the lowest point anywhere in
     * the chunk, a single 11 m fissure dragged the base down with it and the
     * island rendered as a tall grey block with terrain on the lid. Measured
     * from the lowest point on the RIM, that fixed the reef but not the forest,
     * whose chunk slopes 11 m across its own width: the plate sat under the low
     * corner, so the wall under the high corner was 11 m tall and the skirt was
     * still 60% of the picture.
     *
     * Hanging the base off baseHeight() instead gives a slab of even thickness
     * that tilts with the ground, which is what a piece of world cut out of the
     * world actually looks like. It also gives features a well-defined floor:
     * they may cut into the slab but not through it. */
    /* The slab follows the FLATTENED surface, not the bare field. Hung off
     * baseHeight alone, a fully flattened island came out as a wedge: a level
     * lawn on top of an underside still tilting with the world. */
    floorAt = (wx, wz) => baseHeight(wx, wz, seed) - skirtDepth;
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const lo = floorAt(ox + i * res, oz + j * res) + 0.4;
        if (hs[j * S + i] < lo) hs[j * S + i] = lo;
      }
    }
  }

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (!kept[j * N + i]) continue;
      const a = [vx(i), vy(i, j), vz(j)];
      const b = [vx(i), vy(i, j + 1), vz(j + 1)];
      const c = [vx(i + 1), vy(i + 1, j + 1), vz(j + 1)];
      const d = [vx(i + 1), vy(i + 1, j), vz(j)];
      emitTri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      emitTri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    }
  }

  /* ------------------------------------------------------------- water */

  /* A WATER SURFACE, not a blue stripe painted on the bed.
   *
   * The stream used to be a colour returned by the feature's paint(), which put
   * the water tone on the sloping, faceted floor of the cut. That reads as a
   * jagged blue sawtooth, because it IS the terrain: every facet of the bank
   * catches the light at a different angle and the "water" zigzags with them.
   * Real water is a separate surface with its own plane, and that is the whole
   * fix — it is not a triangles-versus-quads problem. Every renderer draws
   * triangles in the end, and two triangles of a flat quad shade identically;
   * what made it look bad was the surface being the wrong shape, not the wrong
   * primitive.
   *
   * `water.levelAt(x, z, ctx)` returns the water SURFACE height, which for a
   * stream is the valley floor it would have had without the cut. So the surface
   * runs downhill with the valley and stays dead level across it, which is what
   * water does.
   */
  const wpos = [], wcol = [];
  if (o.water) {
    const wcolor = o.water.color ?? [0.2, 0.5, 0.6];
    /* SWELL. A sea at one exact height is a sheet of glass, and the giveaway is
     * that it reads as a lid rather than as water. A few centimetres of noise on
     * the level is enough for the facets to catch the light unevenly, which is
     * all a low-poly sea needs. It is on the LEVEL, not on the mesh, so the
     * shoreline moves with it and the surface stays continuous. */
    const swell = o.water.swell ?? 0;
    const swellScale = o.water.swellScale ?? 9;
    const base = typeof o.water.levelAt === 'function'
      ? (x, z) => o.water.levelAt(x, z, ctx)
      : () => Number(o.water.level ?? 0);
    const levelAt = swell > 0
      ? (x, z) => base(x, z) + (fbm(x / swellScale, z / swellScale, seed + 9091, 2) - 0.5) * 2 * swell
      : base;
    const drop = o.water.drop ?? 0.04;   // sit a hair under the surface line

    /* The water level lives on the VERTEX GRID, not per quad.
     *
     * Both other ways were tried and both are visibly wrong. Sampling a level
     * per CORNER of each quad independently lets neighbouring quads tilt
     * opposite ways wherever the level function steps, and throws bright
     * vertical shards out of the surface. Sampling ONE level per quad fixes the
     * shards and breaks the sheet instead: adjacent quads sit at slightly
     * different heights with nothing joining them, so the river renders as a
     * checkerboard of floating tiles with the bed showing through the gaps.
     *
     * A shared vertex grid is the only arrangement that is both continuous and
     * flat: two quads meeting at an edge use the same two heights for it, by
     * construction.
     */
    const SENT = -1e5;
    const wl = new Float64Array(S * S);
    const blocked = new Uint8Array(S * S);   // ground water may never reach
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        /* No water inside the CLEARING. Levelling a town site raises the ground
         * through whatever watercourse ran across it, and the water surface,
         * which follows the river's own traced elevation, is then left perched
         * over the new ground as a bright sheet standing on edge. Filling the
         * channel is what levelling a site does anyway. Faded with the same mask
         * as the clearing, so the river thins out as it reaches it rather than
         * being chopped. */
        const dry = flatR > 0 ? flatMask(vx(i), vz(j)) : 0;
        if (dry > 0.5) blocked[j * S + i] = 1;
        const L = dry > 0.5 ? SENT : levelAt(vx(i), vz(j)) - drop;
        wl[j * S + i] = L <= SENT ? SENT : L;
      }
    }
    /* THE DRAIN — the guarantee, as opposed to the good intention.
     *
     * Everything above trusts `levelAt` to hand back a level the ground can
     * hold. A kit can measure that carefully (this one caps each pool at its
     * crater's own spill point) and still be wrong, because a level function
     * only ever looks at its own feature: terracing steps the whole block by
     * 4 m, a pad levels twenty metres of it, the clearing drops the middle, and
     * the barrier that actually decides where a pool drains can be further away
     * than any of them looked.
     *
     * So the surface is drained here, against the finished vertex grid, where
     * there is nothing left to be wrong about. Each pool is flooded outward at
     * its own level, THROUGH ground the level covers and without caring whether
     * the level function claimed water there — because that is precisely how a
     * pool escapes: over ground its author never sampled. The flood stops on
     * ground that stands above the level, and the LOWEST of those stopping
     * points is where the pool would really run out; the surface drops to just
     * under it. Lowering a level shrinks the body, which can expose a lower rim
     * still, so it runs to a fixed point — two or three passes in practice.
     *
     * AND THE BODY KEEPS THE GROUND IT FLOODED. This is the half that actually
     * removes the wall, and it took a measurement to see: lowering alone leaves
     * the SURFACE where the level function drew it, which on the terraced block
     * was the crater's own bowl, while the ground it covers carries on past that
     * at the same height. The sheet then ends in mid air a metre and a half over
     * a level bench that is plainly under it. Water fills what it reaches, so
     * every flooded vertex gets the level, and the sheet can only end where the
     * ground has risen through it — which is what a shoreline is.
     *
     * A pool that escapes further than `spread` metres is not standing water at
     * all, it is a sheet lying across the countryside, and it is emptied rather
     * than lowered. That case is a level measured against ground that has since
     * been terraced or levelled out from under it.
     *
     * A pool is the case this is right for and a RIVER is the case it is wrong
     * for: a watercourse is one connected body from source to mouth and flatting
     * it to its lowest point would empty the whole valley. `pools: true` is how
     * a kit says its water is standing water. */
    if (o.water.pools) {
      const reach = Math.ceil((o.water.spread ?? 30) / res);
      const cap = reach * reach * 4;
      const stack = [];
      /* Where the ground itself STOPS — the block boundary, and on an island the
       * ragged rim where quads were thrown away. A pool that reaches one of
       * these has nothing holding it in: it pours off the cut edge. There is no
       * level low enough to fix that, so the pool is emptied rather than
       * lowered, which is also what stops a sheet from ending in the air over
       * the skirt. */
      const spillsOff = new Uint8Array(S * S);
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          let open = 0;
          for (const [a, b] of [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]]) {
            if (a < 0 || b < 0 || a >= N || b >= N || !kept[b * N + a]) open = 1;
          }
          spillsOff[j * S + i] = open;
        }
      }
      for (let iter = 0; iter < 8; iter++) {
        const seen = new Int32Array(S * S).fill(-1);
        let changed = false, comp = 0;
        for (let s0 = 0; s0 < S * S; s0++) {
          if (seen[s0] >= 0 || wl[s0] <= SENT || hs[s0] >= wl[s0]) continue;
          const level = wl[s0];
          const cells = [];
          let barrier = Infinity, deepest = Infinity, escaped = false;
          seen[s0] = comp; stack.length = 0; stack.push(s0);
          while (stack.length) {
            const c = stack.pop();
            cells.push(c);
            if (hs[c] < deepest) deepest = hs[c];
            if (cells.length > cap || spillsOff[c]) { escaped = true; break; }
            const i = c % S, j = (c - i) / S;
            for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
              if (a < 0 || b < 0 || a >= S || b >= S) continue;
              const d = b * S + a;
              if (blocked[d]) continue;                         // a wall, not a rim
              if (hs[d] < level) {
                if (seen[d] < 0) { seen[d] = comp; stack.push(d); }
              } else if (hs[d] < barrier) barrier = hs[d];      // the dry rim
            }
          }
          comp++;
          /* maxDepth belongs on the LEVEL, not on the individual quad. Rejecting
           * quads for being too deep cuts a hole in the middle of a surface that
           * carries on around it, and the cut edge stands over the deep ground it
           * refused to cover — a wall of water, which is the very thing this
           * whole pass is about. Lowering the body until it is nowhere deeper
           * than the cap shrinks it from its own shoreline instead. */
          const target = escaped ? SENT
            : Math.min(level, barrier - 0.05, deepest + (o.water.maxDepth ?? 4));
          for (const c of cells) {
            const now = target <= SENT ? SENT : target;
            if (wl[c] !== now && (wl[c] > now || wl[c] <= SENT)) { wl[c] = now; changed = true; }
          }
        }
        if (!changed) break;
      }
    }

    /* A vertex just outside the water's reach still belongs to a quad that is
     * half under water, and it needs a height. Grown from its wet neighbours,
     * a couple of rings out, which is enough for the shoreline fringe.
     *
     * A GROWN LEVEL IS A HEIGHT, NOT A CLAIM THAT THERE IS WATER HERE, and the
     * two were being conflated. The grown value is the pool's own level carried
     * outward past the last place the level function said anything, so on the
     * downhill side of a bowl it lands on ground that is lower still — and the
     * wetness test, which only asks "is the ground under the level", then
     * counted those vertices as open water. The pool crawled two rings out over
     * the lip and stopped in mid air, a flat sheet standing above the field
     * beside it (the owner's screenshot). Grown vertices are recorded and are
     * allowed to CLOSE a quad, never to flood one. */
    const grown = new Uint8Array(S * S);
    for (let pass = 0; pass < 2; pass++) {
      const next = wl.slice();
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          if (wl[j * S + i] > SENT) continue;
          let sum = 0, n = 0;
          for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
            if (a < 0 || b < 0 || a >= S || b >= S) continue;
            const v = wl[b * S + a];
            if (v > SENT) { sum += v; n++; }
          }
          if (n) { next[j * S + i] = sum / n; grown[j * S + i] = 1; }
        }
      }
      wl.set(next);
    }
    /* One smoothing pass over the finished level field. A water surface that
     * changes height quickly between neighbouring vertices renders as a steep
     * facet, and a steep facet in a smooth material catches the key light as a
     * white shard — which is exactly what the outside of the bends looked like.
     * Averaging with the valid neighbours costs nothing and the shoreline moves
     * by centimetres. */
    {
      const sm = wl.slice();
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          if (wl[j * S + i] <= SENT) continue;
          let sum = wl[j * S + i], n = 1;
          for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
            if (a < 0 || b < 0 || a >= S || b >= S) continue;
            const v = wl[b * S + a];
            if (v > SENT) { sum += v; n++; }
          }
          sm[j * S + i] = sum / n;
        }
      }
      wl.set(sm);
    }

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (!kept[j * N + i]) continue;
        const corner = [[i, j], [i, j + 1], [i + 1, j + 1], [i + 1, j]];
        let wet = 0, known = 0, leaks = 0;
        for (const [a, b] of corner) {
          const L = wl[b * S + a];
          if (L <= SENT) continue;
          known++;
          if (vy(a, b) >= L) continue;
          // Under the level. Where the level was MEASURED that is open water;
          // where it was only grown outward it is the surface running past its
          // own shore onto lower ground, which is the perch the owner caught.
          if (grown[b * S + a]) leaks++; else wet++;
        }
        /* Two of four is the shoreline: fewer and the quad is bank, more and it
         * is open water. Taking any-corner-wet floods the bank instead.
         *
         * EXCEPT ON A DRAINED POOL, where one is enough and two leaves a hole.
         * The two-corner rule assumes a shore shallow enough that the quad
         * before the waterline is half wet, and a terraced or cut bank is not:
         * the ground climbs four metres in one quad, so the last cell has a
         * single submerged corner, fails the test, and the sheet stops a metre
         * short of the bank with its edge standing over ground that is plainly
         * under water. Extending it costs nothing — over the dry corners the
         * surface is below the ground and the terrain draws over it — and it is
         * only safe here because the drain has already proved the level is one
         * the ground can hold. */
        if (wet < (o.water.pools ? 1 : 2) || known < 4 || leaks) continue;
        /* And no perched water. A hollow that happens to sit near the course but
         * well below it would otherwise fill to the channel's level and read as
         * a flooded field rather than a river. */
        let deepest = 0;
        for (const [a, b] of corner) deepest = Math.max(deepest, wl[b * S + a] - vy(a, b));
        /* A SEA is unbounded: the seabed can be twenty metres down and the
         * surface is still the surface. maxDepth exists for a river, where water
         * perched in a hollow far from the channel reads as a flooded field. */
        if (deepest > (o.water.maxDepth ?? 4)) continue;
        const P = corner.map(([a, b]) => [vx(a), wl[b * S + a], vz(b)]);
        wpos.push(...P[0], ...P[1], ...P[2]);
        wpos.push(...P[0], ...P[2], ...P[3]);
        for (let q = 0; q < 6; q++) wcol.push(wcolor[0], wcolor[1], wcolor[2]);
      }
    }
  }

  /* ------------------------------------------------------- island skirt */

  if (edges === 'island') {
    const side = o.skirtColor ?? bands[0].color;
    /* The base ring is pulled INWARD, so the sides lean under the landmass
     * instead of dropping as a vertical extrusion. A straight prism reads as a
     * cookie cutter no matter how good the terrain on its lid is; the batter is
     * most of what makes this look like a piece of ground that was lifted out.
     * For a directed outline edge, (dz, -dx) is the inward perpendicular. */
    /* WALLS drop straight down from the outline to the slab floor.
     *
     * They used to lean inward, which looked better on a tall skirt and stopped
     * mattering once the slab became a constant thickness that follows the
     * ground: a 2.5 m rim reads as a slice cut out of the world whether or not
     * it is battered. What the batter cost was the underside. A tapered ring no
     * longer matches the quad grid, so the cap had to be triangulated from the
     * ring itself, and every triangulation of a 128 m blob from its own boundary
     * produces slivers — a centroid fan makes them 60 m long and 1 m wide, which
     * is what the owner found radiating out of the bottom of the reef.
     *
     * Straight walls keep the bottom ON THE GRID, so the cap is just quads.
     */
    for (const [i0, j0, i1, j1] of outline) {
      const ax = vx(i0), az = vz(j0), ay = vy(i0, j0), aby = floorAt(ax, az);
      const bx = vx(i1), bz = vz(j1), by = vy(i1, j1), bby = floorAt(bx, bz);
      // (a, aDown, bDown) + (a, bDown, b) faces outward for this winding.
      pos.push(ax, ay, az, ax, aby, az, bx, bby, bz);
      pos.push(ax, ay, az, bx, bby, bz, bx, by, bz);
      for (let k = 0; k < 6; k++) col.push(side[0], side[1], side[2]);
    }

    /* The underside, on the same grid as the top, ONE QUAD PER CELL.
     *
     * Merging each row into runs is the obvious saving and it is wrong here: the
     * slab floor follows the world, so a run's single long edge does not lie
     * along the per-cell edges the walls were built from. It measured 374
     * unpaired edges, which is 374 hairline gaps around the rim. Runs would only
     * be safe under a dead-flat plate, and a flat plate is what made the island
     * read as a block sitting on sloping ground in the first place. */
    const under = o.underColor ?? side;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (!kept[j * N + i]) continue;
        const x0 = vx(i), x1 = vx(i + 1), z0 = vz(j), z1 = vz(j + 1);
        const h = (x, z) => floorAt(x, z);
        // Reversed against the top faces, so the normal points down.
        pos.push(x0, h(x0, z0), z0, x1, h(x1, z1), z1, x0, h(x0, z1), z1);
        pos.push(x0, h(x0, z0), z0, x1, h(x1, z0), z0, x1, h(x1, z1), z1);
        for (let k = 0; k < 6; k++) col.push(under[0], under[1], under[2]);
      }
    }
  }

  /* ------------------------------------------------------------ queries */

  /** The height a caller should place something at. Identical to the mesh,
   *  including the island's base-plate clamp: a query that disagreed with the
   *  geometry would drop a prop through the floor of a fissure. */
  const groundAt = floorAt
    ? (wx, wz) => Math.max(sampleHeight(wx, wz), floorAt(wx, wz) + 0.4)
    : sampleHeight;

  function slopeAt(wx, wz) {
    const e = res / 2;
    const hx = groundAt(wx + e, wz) - groundAt(wx - e, wz);
    const hz = groundAt(wx, wz + e) - groundAt(wx, wz - e);
    const nx = -hx, nz = -hz, ny = 2 * e;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return Math.acos(clamp(ny / len, -1, 1)) * (180 / Math.PI);
  }

  /** Deterministic placement points, so a composition that scatters 40 rocks
   *  puts them in the same 40 places on every build. */
  function scatter(n, opt = {}) {
    const maxSlope = opt.maxSlope ?? 18;
    const minSlope = opt.minSlope ?? 0;
    const inset = opt.inset ?? 2;
    const avoidPads = opt.avoidPads !== false;
    const sseed = (opt.seed ?? seed) | 0;
    const out = [];
    for (let k = 0; k < n * 60 && out.length < n; k++) {
      const wx = ox + inset + hash2(k, 91, sseed) * (W - 2 * inset);
      const wz = oz + inset + hash2(k, 173, sseed + 31) * (W - 2 * inset);
      if (mask && islandMask(wx - ox, wz - oz, seed, W) <= 0.35) continue;
      if (avoidPads && pads.some((p) => padWeight(wx, wz, p, padBlend) > 0)) continue;
      const s = slopeAt(wx, wz);
      if (s < minSlope || s > maxSlope) continue;
      const y = groundAt(wx, wz);
      if (opt.minY !== undefined && y < opt.minY) continue;
      if (opt.maxY !== undefined && y > opt.maxY) continue;
      out.push({ x: wx, y, z: wz, slope: s, rot: hash2(k, 407, sseed + 77) * Math.PI * 2 });
    }
    return out;
  }

  /* ---------------------------------------------------- placement queries */

  /* WHERE CAN I BUILD? The question a town, a farm or a depot actually asks, and
   * the one a height field answers badly on its own: sampling heightAt() a few
   * times tells you nothing about whether a 20 m building will sit level.
   *
   * Scans the block for square footprints whose ground varies less than
   * `maxDrop` from corner to corner, largest first, and returns the ones that do
   * not overlap. A caller gets somewhere to put a village without knowing
   * anything about noise, features or how this kit builds its relief.
   *
   * Cached coarse grid, because the honest version is unusable: four footprint
   * sizes scanned at 2 m over a 128 m block is about 400,000 height samples, and
   * a height sample here runs the kit's features and its river. Sampling once
   * into a grid and scanning THAT is the same answer for a thousandth of the
   * work.
   */
  function flatAreas(opt = {}) {
    const maxDrop = opt.maxDrop ?? 0.75;
    const want = opt.count ?? 12;
    const minSize = opt.minSize ?? 8;
    const step = Math.max(res, 2);
    const G = Math.floor(W / step) + 1;
    const grid = new Float64Array(G * G);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) grid[j * G + i] = groundAt(ox + i * step, oz + j * step);
    }
    const at = (i, j) => grid[clamp(j, 0, G - 1) * G + clamp(i, 0, G - 1)];

    const sizes = [];
    for (let sz = Math.min(48, Math.floor(W / 3)); sz >= minSize; sz = Math.floor(sz / 1.5)) sizes.push(sz);
    const found = [];
    for (const size of sizes) {
      const half = size / 2 / step;
      for (let j = half; j + half < G; j += 1) {
        for (let i = half; i + half < G; i += 1) {
          let lo = Infinity, hi = -Infinity;
          // 5x5 over the footprint: corners and middle are what decide level.
          for (let b = -2; b <= 2; b++) {
            for (let a = -2; a <= 2; a++) {
              const h = at(Math.round(i + (a * half) / 2), Math.round(j + (b * half) / 2));
              if (h < lo) lo = h;
              if (h > hi) hi = h;
            }
          }
          const drop = hi - lo;
          if (drop > maxDrop) continue;
          const x = ox + i * step, z = oz + j * step;
          // Never straddle the seam: the outer band belongs to the neighbours.
          if (x - size / 2 < ox + SKIRT || x + size / 2 > ox + W - SKIRT) continue;
          if (z - size / 2 < oz + SKIRT || z + size / 2 > oz + W - SKIRT) continue;
          if (mask && islandMask(x - ox, z - oz, seed, W) < 0.95) continue;
          if (opt.avoidWater !== false && o.water) {
            const lv = typeof o.water.levelAt === 'function'
              ? o.water.levelAt(x, z, ctx) : Number(o.water.level ?? 0);
            if (lo < lv) continue;                     // partly under water
          }
          found.push({ x, z, size, y: Math.round(((lo + hi) / 2) * 4) / 4, drop: +drop.toFixed(3) });
        }
      }
    }
    found.sort((a, b) => (b.size - a.size) || (a.drop - b.drop));
    const kept = [];
    for (const f of found) {
      if (kept.length >= want) break;
      const clash = kept.some((k) => Math.abs(k.x - f.x) < (k.size + f.size) / 2
                                  && Math.abs(k.z - f.z) < (k.size + f.size) / 2);
      if (!clash) kept.push(f);
    }
    return kept;
  }

  /** Ground along a straight line, for laying a road, a wall or a bridge: the
   *  heights, the slope between consecutive samples, and whether each point is
   *  under water. A road is chosen by looking at this, not by hoping. */
  function profile(x0, z0, x1, z1, n = 32) {
    const out = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = lerp(x0, x1, t), z = lerp(z0, z1, t);
      const y = groundAt(x, z);
      const wet = o.water
        ? y < (typeof o.water.levelAt === 'function' ? o.water.levelAt(x, z, ctx) : Number(o.water.level ?? 0))
        : false;
      const prev = out[out.length - 1];
      const run = prev ? Math.sqrt((x - prev.x) ** 2 + (z - prev.z) ** 2) : 0;
      out.push({ x: +x.toFixed(2), z: +z.toFixed(2), y: +y.toFixed(2),
                 grade: prev && run > 0 ? +(((y - prev.y) / run) * 100).toFixed(1) : 0, wet });
    }
    return out;
  }

  /** The heights along one boundary, in order. The join test compares these
   *  between neighbours; in tile mode they are baseHeight() by construction. */
  function seam(side) {
    const out = new Float64Array(S);
    for (let k = 0; k < S; k++) {
      if (side === 'north') out[k] = hs[0 * S + k];
      else if (side === 'south') out[k] = hs[(S - 1) * S + k];
      else if (side === 'west') out[k] = hs[k * S + 0];
      else out[k] = hs[k * S + (S - 1)];
    }
    return out;
  }

  return {
    positions: new Float32Array(pos),
    colors: new Float32Array(col),
    tris: pos.length / 9,
    // Water is its own surface so the kit can give it its own material, and so
    // it never lands in the terrain's palette measurement as if it were ground.
    waterPositions: new Float32Array(wpos),
    waterColors: new Float32Array(wcol),
    waterTris: wpos.length / 9,
    chunk: CHUNK, span, width: W, res, edges, seed, cx, cz,
    /* The tone a NEIGHBOUR should blend toward: the band covering ordinary
     * ground, which is the one a viewer reads as "what this kit's floor is". */
    groundColor: (bands.find((b) => b.upTo > 0) ?? bands[bands.length - 1]).color,
    /* What this kit paints at a point, BEFORE any edge blending. A neighbour
     * asks this to blend toward; handing back the blended colour instead would
     * make two neighbours each chase the other. */
    colorAt: (wx, wz) => {
      /* Takes ONLY a position, and works out the height and the slope itself. It
       * has to be a pure function of (x, z): a neighbour calls it while shading
       * its own faces, and if the answer depended on the height THAT block
       * happens to have there, the two sides would mix different values and the
       * seam would not close. */
      const hy = groundAt(wx, wz);
      const ny = Math.cos((slopeAt(wx, wz) * Math.PI) / 180);
      for (let k = features.length - 1; k >= 0; k--) {
        const c = features[k].paint?.(wx, wz, hy, ny, ctx);
        if (c) return c;
      }
      if (cliff && ny < cliffCos) return cliff;
      const lift = flatR > 0 ? preFlat(wx, wz) - rawHeight(wx, wz) : 0;   // see faceColor
      const v = byRelief ? hy - baseHeight(wx, wz, seed) + lift : hy;
      for (const b of bands) if (v <= b.upTo) return b.color;
      return bands[bands.length - 1].color;
    },
    pads,
    heightAt: groundAt,
    flatAreas,
    profile,
    slopeAt,
    scatter,
    seam,
  };
}
/* === END TERRAIN CORE === */

/* ------------------------------------------------------------------ palette */

const COLORWAYS = {
  'green-shire':  { pasture: '#6f7c53', meadow: '#93a065', soil: '#684d38', stone: '#bdbbba', water: '#6390ac' },
  'harvest-gold': { pasture: '#8a8a52', meadow: '#c8bd7a', soil: '#856850', stone: '#cac9c9', water: '#758299' },
  'wet-spring':   { pasture: '#55703f', meadow: '#7d9a4e', soil: '#473427', stone: '#a8a9a6', water: '#5a86a3' },
  'winter-fell':  { pasture: '#6a705c', meadow: '#9aa08a', soil: '#4a423a', stone: '#cac9c9', water: '#758299' },
};
export const presets = COLORWAYS;

const ZONES = ['pasture', 'meadow', 'soil', 'stone', 'water'];

/* ------------------------------------------------------------------- params */

/* Terrain is a horizontal surface and the house 18 degrees barely sees one.
 * 28 shows the relief and still reads as a three-quarter view rather than a map. */
export const view = { heroEl: 28 };

export const params = {
  colorway: {
    type: 'choice', default: 'green-shire', label: 'Colorway',
    options: Object.keys(COLORWAYS),
    describe: 'Curated kit schemes. green-shire is the default muted olive pasture over brown earth, English downland in summer; harvest-gold bleaches the grass to straw and cools the water for late August; wet-spring saturates everything green for April; winter-fell greys the whole valley down without any snow on it.',
  },
  edges: {
    type: 'choice', default: 'island', label: 'Edges', affects: 'geometry',
    options: ['island', 'tile'],
    describe: 'island cuts the chunk to an irregular floating landmass with sides that skirt down and stop, which is how one piece of ground is presented on its own. tile keeps the full 64 x 64 m square and forces the outer 4 m to the shared world field, so this chunk joins any other kit\'s terrain edge to edge with no crack.',
  },
  res: {
    type: 'choice', default: 1, label: 'Detail', affects: 'geometry',
    options: [4, 2, 1, 0.5],
    describe: 'Metres per quad. 4 is coarse faceted ground, 2 is a mid read, 1 resolves the lynchet banks and the river channel properly and is the default. Two blocks can only be joined at the SAME setting.',
  },
  span: {
    type: 'range', default: 2, min: 1, max: 4, step: 1, label: 'Size', affects: 'geometry',
    describe: 'How many 64m chunks across the block is: 1 is a single 64x64m chunk, 4 is 256x256m and sixteen times the ground. Size and detail share one triangle budget, so past 2 the vertex pitch coarsens to hold it. Any size joins any other, because the outer edge still lands on chunk lines and still matches the shared world field there.',
  },
  relief: {
    type: 'range', default: 1, min: 0, max: 1.8, step: 0.05, label: 'Relief', affects: 'geometry',
    describe: 'Overall vertical exaggeration of everything this kit adds over the shared world field. 0 leaves bare rolling ground, 1 gives downland rising 4-6 m with a river cut through it, 1.8 makes a steep-sided valley the village has to terrace to farm at all.',
  },
  downs: {
    type: 'range', default: 1, min: 0, max: 1.6, step: 0.05, label: 'Downland', affects: 'geometry',
    describe: 'Strength of the broad rounded rises the fields run over. They are gentler and wider than the forest kit\'s hillocks, because this is grazed and ploughed land rather than wooded ground: long backs and open tops, the sort of hill a track goes over rather than around.',
  },
  lynchets: {
    type: 'range', default: 0.5, min: 0, max: 1, step: 0.05, label: 'Field terraces', affects: 'geometry',
    describe: 'Strength of the strip lynchets: the step-like banks that form where the same fields have been ploughed along the contour for centuries, so a hillside becomes a flight of shallow level shelves about 1.6 m apart rather than a smooth slope. They appear only in the field patches, never in the river channel, and they are the clearest sign on the ground that this land is farmed. 0 is unworked hillside.',
  },
  outcrops: {
    type: 'range', default: 1, min: 0, max: 1.6, step: 0.05, label: 'Stone outcrops', affects: 'geometry',
    describe: 'Size of the bare rock knolls pushing up through the turf, clustered rather than spread evenly. They read as stone rather than grass, they are what the village quarried its walls from, and they give the scatter points somewhere convincing to put loose rock.',
  },
  river: {
    type: 'range', default: 1, min: 0, max: 1.8, step: 0.05, label: 'River', affects: 'geometry',
    describe: 'Size of the watercourse crossing the valley: at 1 the channel reaches about 6 m wide and 2.8 m deep, with graded banks either side and bare earth showing on them. The course is TRACED downhill through the world, so it always flows somewhere and it widens and deepens as it goes, and the water in it is a real surface that falls along the valley and stays level across it. 0 removes the river and leaves unbroken ground.',
  },
  erosion: {
    type: 'range', default: 0, min: 0, max: 1, step: 0.05, label: 'Erosion', affects: 'geometry',
    describe: 'Weathers the landforms after they are built: hollows cut down and smooth out while crests stay sharp, which is what distinguishes ground water has worked on from ground noise made. At 1 it moves the ground by about 3 m either way and lowers the average by around a metre. The block edges are untouched at any setting, so an eroded block still joins its neighbours exactly.',
  },
  flatten: {
    type: 'range', default: 0, min: 0, max: 1, step: 0.05, label: 'Level clearing', affects: 'geometry',
    describe: 'Clears a LEVEL AREA IN THE MIDDLE of the block for the village green and the buildings round it, and leaves the farmland around it alone. The number is the size of that clearing: 0 is none, 0.5 is a circle roughly a third of the block across, 1 is as large as it can go without touching the edges. Its rim is soft, so the ground rises out of the clearing rather than stepping. The block\'s edges are never touched at any setting, so a levelled block still joins its neighbours exactly.',
  },
  pasture: {
    type: 'color', default: '#6f7c53', label: 'Pasture',
    describe: 'Albedo of the ordinary grazed grass, the largest area in the model. One flat matte tone.',
  },
  meadow: {
    type: 'color', default: '#93a065', label: 'Meadow',
    describe: 'Albedo of the lighter growth on the open tops of the downland, where the soil is thin and the grass is drier.',
  },
  soil: {
    type: 'color', default: '#684d38', label: 'Bare earth',
    describe: 'Albedo of the ploughed and trodden ground: the river banks, the hollows, and the risers of the field terraces where the plough has cut in.',
  },
  stone: {
    type: 'color', default: '#bdbbba', label: 'Stone',
    describe: 'Albedo of any face steeper than 62 degrees and of the rock knolls: bare stone and the island skirt.',
  },
  water: {
    type: 'color', default: '#6390ac', label: 'River water',
    describe: 'Albedo of the river surface. It is a separate mesh sitting on the water line, not a colour on the bed, so it stays flat across the channel however rough the bed under it is.',
  },
};

/* ------------------------------------------------------------------ helpers */

const LYNCHET_STEP = 1.6;   // riser height of a ploughed terrace

/** Broad rounded downland. Gated so the ground between the rises stays at the
 *  shared field: without a dead zone the whole block lifts by a metre or two
 *  and reads as a raised lawn rather than as hills standing in open country. */
function downAt(x, z, c) {
  /* Measured, not guessed. At (n - 0.54) / 0.32 three quarters of the block
   * came out at exactly zero relief and the hero render was a flat green plate
   * with a river on it: the gate is meant to leave open ground BETWEEN the
   * rises, not to leave the rises out. */
  const n = c.fbm(x / 31, z / 31, c.seed + 71, 3);
  return c.smooth(c.clamp((n - 0.44) / 0.34, 0, 1));
}

/** Bare rock knolls, clustered into patches. */
function outcropAt(x, z, c) {
  const patch = c.smooth(c.clamp((c.fbm(x / 43, z / 43, c.seed + 907, 2) - 0.63) / 0.19, 0, 1));
  if (patch <= 0) return 0;
  return patch * c.ridge(x / 7, z / 7, c.seed + 133, 2);
}

/** Where the fields are, and therefore where the plough has cut terraces.
 *  Broad patches with open ground between them, so the valley reads as farmland
 *  among rough grazing rather than as one continuous staircase. */
function fieldAt(x, z, c) {
  return c.smooth(c.clamp((c.fbm(x / 47, z / 47, c.seed + 311, 2) - 0.44) / 0.24, 0, 1));
}

/* -------------------------------------------------------------- the factory */

export function createAsset(o = {}) {
  const p = {};
  for (const k of Object.keys(params)) p[k] = o[k] !== undefined ? o[k] : params[k].default;
  const cw = COLORWAYS[p.colorway] ?? COLORWAYS['green-shire'];
  for (const z of ZONES) if (o[z] === undefined) p[z] = cw[z];

  // Vertex colour is LINEAR; the hex above is sRGB. THREE.Color converts on
  // construction, so read .r/.g/.b and never convert again.
  const rgb = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

  /* Well above the waterline at about +8 m, AND one of the few chunks a traced
   * watercourse actually crosses — a village kit whose river misses the block
   * shows none of its signature feature. Of the 169 chunks in the scanned
   * world only eighteen carry a course at all, and this is the highest of the
   * ones that carry a strong one. */
  const cx = o.cx ?? -5, cz = o.cz ?? 1;
  const seed = o.seed ?? 1;
  const res = Number(p.res);
  const relief = Number(p.relief);

  const kD = Number(p.downs), kO = Number(p.outcrops), kR = Number(p.river), kL = Number(p.lynchets);

  // The feature helpers only reach for the shared noise, so a minimal context is
  // enough to evaluate them outside buildChunk (the river needs the dry height).
  const ctx0 = { seed, fbm, ridge, vnoise, hash2, baseHeight,
                 clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
                 smooth: (t) => t * t * (3 - 2 * t), lerp: (a, b, t) => a + (b - a) * t };

  const features = [
    {
      name: 'downland',
      height: (x, z, c) => downAt(x, z, c) * 6.2 * relief * kD,
      paint: (x, z, h, ny, c) => (kD > 0.15 && downAt(x, z, c) > 0.74 ? rgb(p.meadow) : null),
    },
    {
      name: 'stone-outcrop',
      height: (x, z, c) => outcropAt(x, z, c) * 2.2 * relief * kO,
      paint: (x, z, h, ny, c) => (kO > 0.15 && outcropAt(x, z, c) > 0.45 ? rgb(p.stone) : null),
    },
    /* The RISERS of the terraces, which are bare earth: the plough cuts into the
     * bank every year and nothing grows on the face. Judged by slope rather
     * than by recomputing the step, and it is why cliffAngle below is set well
     * back — at 38 degrees the risers painted as bare STONE and the hillside
     * came out covered in pale scratches. */
    {
      name: 'field-terrace',
      paint: (x, z, h, ny, c) => (kL > 0.05 && ny < 0.6 && fieldAt(x, z, c) > 0.35 ? rgb(p.soil) : null),
    },
    {
      name: 'river',
      height: (x, z) => river.carve(x, z),
      // The BED is bare earth all the way down. The water above it is a real
      // surface built by the core, not a colour smeared on a slope.
      paint: (x, z) => (river.carve(x, z) < -0.12 ? rgb(p.soil) : null),
    },
  ];

  // Bands are metres of relief above the natural floor, not absolute height, so
  // the same module reads correctly on the valley floor and up on the down.
  const datum = baseHeight((cx + 0.5) * CHUNK, (cz + 0.5) * CHUNK, seed);
  const bands = [
    { upTo: -1.2, color: rgb(p.soil) },
    { upTo: 2.4, color: rgb(p.pasture) },
    { upTo: Infinity, color: rgb(p.meadow) },
  ];

  const span = Number(p.span);
  /* The DRY surface: what this ground would be if the river had never cut it.
   * The river needs it to know where its own water line sits, because the
   * channel is a displacement on top of the downland rather than a cut into the
   * bare world field. */
  const dryAt = (x, z) => baseHeight(x, z, seed)
    + downAt(x, z, ctx0) * 6.2 * relief * kD
    + outcropAt(x, z, ctx0) * 2.2 * relief * kO;

  const river = makeRiver({
    seed,
    x0: cx * CHUNK, z0: cz * CHUNK,
    x1: cx * CHUNK + CHUNK * span, z1: cz * CHUNK + CHUNK * span,
    width: 6 * kR,
    depth: 2.8 * relief * kR,
    surfaceAt: dryAt,
    // ONE watercourse. Two of them meeting inside a 128 m block read as a marsh,
    // and the water level steps where the nearest course changes.
    maxCourses: 1,
  });

  const t = buildChunk({
    /* PADS ARE THE COMPOSITION'S CALL, not the terrain's.
     *
     * The core has taken explicit `pads` and auto-`flats` since v1, but no kit
     * wrapper ever passed them on, so `T.pads` came back empty on every kit and
     * COMPOSE.md's "put buildings on T.pads" was advice nobody could follow.
     * Measured on the Space Base: 0 pads at every knob setting.
     *
     * Forwarded rather than defaulted. Asking for a pad DEFORMS the ground, so
     * the values here are exactly what the core already assumed when nothing
     * asked: the published terrain is unchanged, and a diorama that wants
     * somewhere level now has a way to say so. */
    pads: o.pads ?? [],
    flats: o.flats ?? 0,
    flatSize: o.flatSize,
    flatSnap: o.flatSnap,
    cx, cz, seed, res,
    span,
    edges: p.edges,
    flatten: Number(p.flatten),
    erosion: Number(p.erosion),
    features,
    /* LYNCHETS. Ploughing along a contour for centuries drags soil downhill
     * until the slope stands in shallow level shelves, so the operation is a
     * terrace — but a terrace applied ONLY where there are fields, which is
     * what makes it read as farming rather than as the reef kit's construction
     * stepping. Held out of the channel as well: a stepped river bed leaves the
     * water surface perched over risers instead of lying in a cut. */
    shape: kL > 0 ? (h, x, z, c) => {
      if (kR > 0.05 && river.carve(x, z) < -0.15) return h;
      const w = fieldAt(x, z, c) * kL;
      return w > 0 ? c.lerp(h, Math.round(h / LYNCHET_STEP) * LYNCHET_STEP, w) : h;
    } : null,
    bands,
    bandBy: 'relief',
    blend: o.blend ?? null,   // neighbour tones, wired by whoever lays the blocks
    cliff: rgb(p.stone),
    // Well back from the lynchet risers (about 58 degrees), so the terraces read
    // as earth banks and only genuine rock faces come out stone.
    cliffAngle: 62,
    water: kR > 0.05 ? { levelAt: (x, z) => river.levelAt(x, z), color: rgb(p.water), maxDepth: 2.2 * relief } : null,
    skirtDepth: 2.5,
    skirtColor: rgb(p.stone),
    underColor: rgb(p.soil),
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(t.positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(t.colors, 3));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0,
  }));
  mesh.name = 'farmland';

  const g = new THREE.Group();
  g.name = 'medieval-village-terrain';
  g.add(mesh);

  /* Water is its OWN mesh with its own material: flat-shaded like everything
   * else, but smoother, so it catches the key light as a sheet instead of
   * reading as wet mud. Kept out of the ground mesh so a buyer can hide it,
   * swap it or animate it without touching the terrain. */
  if (t.waterTris) {
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(t.waterPositions, 3));
    wg.setAttribute('color', new THREE.Float32BufferAttribute(t.waterColors, 3));
    wg.computeVertexNormals();
    const wm = new THREE.Mesh(wg, new THREE.MeshStandardMaterial({
      // Rough enough that the key light spreads across the channel instead of
      // burning one white patch into it.
      vertexColors: true, flatShading: true, roughness: 0.5, metalness: 0.05,
    }));
    wm.name = 'water';
    g.add(wm);
  }

  /* A lone island presents like every other asset in the catalogue: centred on
   * the origin, its middle on y = 0. A TILE keeps its true world position,
   * because that position IS the contract with its neighbours. */
  if (p.edges === 'island') {
    const mid = t.width / 2;
    g.position.set(-(cx * CHUNK + mid), -t.heightAt(cx * CHUNK + mid, cz * CHUNK + mid), -(cz * CHUNK + mid));
  }

  g.userData.terrain = {
    chunk: CHUNK, span: t.span, width: t.width, groundColor: t.groundColor, colorAt: t.colorAt, res, cx, cz, seed, edges: p.edges, datum,
    /* The RESOLVED knobs this block was built from. A composition picks its own
     * values (the Steampunk Farm village stands on relief 0.55, flatten 0.65,
     * causeway off), and without them nothing downstream can reproduce the same
     * ground: the kit editor would draw the terrain's defaults under a village
     * laid out on something else. */
    params: { ...p },
    heightAt: t.heightAt, slopeAt: t.slopeAt, scatter: t.scatter, seam: t.seam, pads: t.pads,
    // Placement queries: where can I build, and what does the ground do along a line.
    flatAreas: t.flatAreas, profile: t.profile,
  };
  return g;
}

export default createAsset;
