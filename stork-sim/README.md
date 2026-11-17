# Stork Field Sim

A browser flight simulator for the Stork VTOL mapping real farm fields. Part of Lantern.

- **Campaign:** three real fields in Wagoner County, OK, with USDA NASS Crop Sequence Boundaries
  outlines, USDA NAIP imagery and USGS 3DEP elevation baked in (`levels/`).
- **Free play:** any USDA field in the lower 48, using Esri World Imagery and live 3DEP elevation.
- **Flight model (`sim.js`):** 6-DOF quadplane built from the Stork's measured wing (0.30 m², 1.61 m span)
  and motor layout, with ArduPilot-style modes (QLOITER, FBWA, AUTO, QRTL), transitions, wind and gusts,
  weathervaning, a battery/power model and ground contact.
- **Camera:** Walksnail Avatar HD Pro modelled as a 160° equidistant fisheye, 1920 px wide, looking down.
  Coverage only counts where ground detail meets the level's cm/px target.

No build step: open `index.html` from a static server.

## Assumptions to check against the real aircraft

All-up weight 2.6 kg, 6S 5000 mAh battery (111 Wh), F90 lift motors with 7" props, 9" pusher,
aerodynamic coefficients estimated (not wind-tunnel measured), camera mounted looking straight down,
1 km line-of-sight ring. These are in `AC` and `CAM` at the top of `sim.js`.

Par times come from automated reference flights (best plan +10%).
