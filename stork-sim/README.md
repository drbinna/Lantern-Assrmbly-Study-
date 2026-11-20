# Stork Field Sim

A browser flight simulator for the Stork VTOL mapping real farm fields. Part of Lantern.

- **Campaign:** three real fields in Wagoner County, OK, with USDA NASS Crop Sequence Boundaries
  outlines, USDA NAIP imagery and USGS 3DEP elevation baked in (`levels/`).
- **Free play:** any USDA field in the lower 48, using Esri World Imagery and live 3DEP elevation.
- **Flight model (`sim.js`):** 6-DOF quadplane built from the Stork's measured wing (0.30 m², 1.61 m span)
  and motor layout, with ArduPilot-style modes (QLOITER, FBWA, AUTO, QRTL), transitions, wind and gusts,
  weathervaning, a battery/power model and ground contact.
- **Rings on every field:** each survey plan (campaign and free play) is turned into a ring course along the
  mapping lines at the chosen altitude. Rings show how to fly the plan; the field is complete only when every
  ring is flown (or missed) and you land on the pad. Missing a ring costs the third star.
- **Ring courses (`course.js`):** fly through floating rings in order, then land on the pad. Rings sit on a
  smooth racing line (centripetal Catmull-Rom) that the autopilot can follow for a demo lap; clipping a ring
  with a wingtip costs 3 s. Par times come from autopilot laps on fixed gust seeds.
- **Sound (`audio.js`):** synthesised live with Web Audio, no recordings. Each lift motor and the pusher is an
  oscillator at its blade-pass frequency (RPM from thrust, 2 blades) plus motor whine (7 pole pairs),
  prop-wash and wind noise, distance filtering from the camera, ESC arming tones, ring chimes and crash sounds.
- **Camera:** Walksnail Avatar HD Pro modelled as a 160° equidistant fisheye, 1920 px wide, looking down.
  Coverage only counts where ground detail meets the level's cm/px target.

No build step: open `index.html` from a static server.

## Assumptions to check against the real aircraft

All-up weight 2.6 kg, 6S 5000 mAh battery (111 Wh), F90 lift motors with 7" props, 9" pusher,
aerodynamic coefficients estimated (not wind-tunnel measured), camera mounted looking straight down,
1 km line-of-sight ring. These are in `AC` and `CAM` at the top of `sim.js`.

Par times come from automated reference flights (best plan +10%).
