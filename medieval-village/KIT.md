# Medieval Village Kit

**Building with this? Read `API.md` (one paragraph: the whole API of kit.mjs, stage.mjs and clips.mjs) and stop.**
Three lines build the place: `import { buildKit } from './kit.mjs'; const place = await buildKit({ folder: './' }); scene.add(place.group);`. The rest of this file is reference.

https://polyfork.dev/kit/medieval-village-kit-ca0b43

60 of 60 parts, packed 2026-11-18.
Kits fill up over time: if this says fewer parts than the site does, re-download.

## What is in this folder

Every part twice: `<part>.glb` for any engine, `<part>.mjs` as a drop-in three.js
module with its options. `scene.glb` is the composed kit scene, the whole thing
arranged as one file.

BUILD THE WHOLE PLACE IN ONE CALL. `kit.mjs` in this folder does it:

```js
import { buildKit } from './kit.mjs';          // serve this folder over http
const place = await buildKit({ folder: './' });   // all 559 placements, merged to a few draw calls
scene.add(place.group);                        // then place.tick(elapsedSeconds) in your loop
```

You get `place.bounds`, `place.boxes()` (a Box3 per placement tall enough to walk into),
`place.of(key)`, `place.terrain` with `place.groundAt(x, z)`, and the placed people idling.
LIGHT IT WITH `stage.mjs`, not with ACES tone mapping at exposure 1: these colours are authored for
no tone mapping under a hemisphere, a warm key and a cool rim, and the usual tutorial rig turns them
muddy. `const look = stage(renderer, scene, { time: 'day' }); look.shadows(place.group);
look.ground(place); await place.surround(); look.follow(player);` then `look.update()` each frame.
`look.setTime(0..1)` runs day to night. `place.surround()` scatters the kit's own trees past its edge.

`clips.mjs` makes any of the humanoids walk: `const anim = await animate(character);
anim.locomotion(metresPerSecond)`. The page needs an import map for `three` and `three/addons/`.

`LAYOUT.json` is the composition: 559 placements of 34 parts, the arrangement
every picture of this kit was taken in. Each row is a part key, a position in
metres (`x`,`y`,`z`, Y up), rotations in degrees (`ry` about Y, and `rx`/`rz` where
present, applied in XYZ order: an upright turn can be written rx = rz = 180 with ry),
an optional scale `s`, and `params` — the knob values
that placement was built with, where they differ from the part's defaults.

```js
for (const p of LAYOUT) {
  const o = createAsset({ THREE, ...(p.params || {}) });   // from `${p.part}.mjs`
  o.position.set(p.x, p.y, p.z);
  const D = Math.PI / 180;   // all three, XYZ order (three.js's default): some upright rows say rx = rz = 180
  o.rotation.set((p.rx || 0) * D, (p.ry || 0) * D, (p.rz || 0) * D);
  if (p.s) o.scale.setScalar(p.s);
  scene.add(o);
}
```

The row whose part is `_terrain` is the ground rather than a model: it carries a
`module` and the knobs `terrain.mjs` was generated with.

## The ground

`terrain.mjs` generates this kit's own ground; `TERRAIN.json` holds the knob values
it is composed and photographed at. It is a program, not a mesh, so it rebuilds at
any size and the parts sit on it at the same scale they were built for.

```js
import { createAsset as terrain } from './terrain.mjs';
scene.add(terrain(await (await fetch('./TERRAIN.json')).json()));
```

## Using them together

The kit agrees on the knobs below. Knobs not listed here are local to one part, vary them freely.

- **`colorway`** (44 of 60 parts): 44 different option sets. Every part has this knob and its values are curated for that part, so a
  value from one part is not valid on another. Each `.mjs` lists its own in the header.

**Scale.** Everything snaps to a 2m grid; wall modules are 2m wide and 3m tall, doorways 2.1m, roof pitch a constant 45 degrees, and all props share a 1-unit = 1-meter scale.

**Palette.** `#6390ac`, `#7b3730`, `#a55c4f`, `#473427`, `#684d38`, `#dbcfb2`, `#6f7c53`, `#856850`, `#e0dfdf`, `#44434b`, `#bdaa93`, `#31333b`, `#e5e5e5`, `#758299`, `#9f7b59`, `#251d19`

## Parts

60 parts. `PARTS.json` beside this file lists each one on one line: file, size, knobs with their options and defaults, colour zones, rig nodes, lit zones. `grep '"<key>"' PARTS.json` rather than opening its `.mjs`.

Every part also has its own page with renders and live options:
https://polyfork.dev/kit/medieval-village-kit-ca0b43

## Building this with an AI agent?

Point it at https://polyfork.dev/prompt.txt. The same assembly contract above is
machine-readable at https://polyfork.dev/api/kits/medieval-village-kit-ca0b43 (the `usage` field), and it
updates as the kit fills up, which this file does not.
