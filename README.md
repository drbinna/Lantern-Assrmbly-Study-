# Lantern — X650 Assembly Study

An interactive 3D explorer for the Holybro X650 research quadcopter, built with Three.js.
No CAD import — every component is procedural geometry.

## Use

Open `index.html`. No build step.

- **Stages** — assembled, inside (transparent top plate and Jetson), exploded
- **Click any part** for what it is and what it connects to
- **Toggles** — labels, wiring, propellers, battery, auto-rotate
- **Views** — perspective, top, side, centre stack

Cable colours: red battery power · teal CAN/UART · yellow ESC signal · violet USB/sensor

## Accuracy

The 650 mm motor spacing and four-arm layout are correct. Plate dimensions, component
positions, ESC placement and the battery envelope are estimated from photographs and
should be corrected against the real aircraft.

Each component is a single `part({...})` call with a position, explode direction and
description. Correcting one is a two-line edit. Improving this model as the real
aircraft is measured is the point of the exercise.

## Aircraft

Holybro X650 · PX4 · NVIDIA Jetson Orin NX on a PAB-BASE carrier · DroneCAN M9N GPS ·
Holybro PM08 power module · Intel RealSense depth camera · ATK-PMW3901 optical flow
