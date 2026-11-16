# Stork VTOL — Assembly Study

Interactive 3D assembly of the Flightory Stork with the VTOL conversion pack, built in Three.js
from the original print files (STL). Part of Lantern.

- **Assembled / Exploded / Build sequence** — eight steps, following the order in the VTOL manual
- **Click any part** for what it does, which kit it comes from, and its print size
- Base-kit parts are white; VTOL-pack parts are green (toggle "VTOL pack")
- Add `#clean` to the URL for a chrome-free view for screenshots

## Files

- `index.html` — the page (no build step)
- `stork.json` — part list, descriptions, build steps, explode vectors
- `stork.bin` — decimated, pre-positioned meshes (positions, normals, indices)

## Accuracy

Every printed part is positioned from its own file coordinates: fuselage sections are matched at
their joints, the VTOL variants are fitted onto the stock parts (≈1 mm fit error), the wing and
V-tail roots are matched to their sockets in FUS 3 and FUS 6, and the left side mirrors the right.
Result: 1613 mm span (spec 1620), skid and fin tip touching the same ground plane.

Estimated, not taken from the files: the boom's fore-aft position (centred on the boom mounts),
the hatch fit, and the motors/props, which are simple shapes drawn to the manual's spec
(500 mm 10×10 booms, T-Motor F90 + 7″ lift props, 28xx pusher + 9″ prop).
