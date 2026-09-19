# X650 · Build and session log

**Aircraft:** Holybro X650 development kit
**Owner:** ORU Computing & Mathematics Department (loaned)
**Team:** Obi, Zviko
**Project:** Lantern

---

## Aircraft configuration, as established

### Airframe
| Item | Value |
|---|---|
| Frame | Holybro X650, 650 mm motor-to-motor, folding carbon arms |
| Airframe type | Quadrotor X · Generic Quadcopter |
| Motor positions | M1–M4, labelled on the frame plates |
| Landing gear | Splayed carbon A-frame, foam skids with red end caps |

### Flight control
| Item | Value |
|---|---|
| Baseboard | PAB-BASE-OrinNX-RC04 (Pixhawk Autopilot Bus + Jetson carrier, one board) |
| Flight controller | Installed on the baseboard, **ArduPilot** firmware |
| Firmware version | 1.15.4 |
| USB port | Labelled **FMU-USB**, on the baseboard below the FC module |
| Spare | A second Pixhawk 6X exists, uninstalled |

### Compute and sensing
| Item | Value |
|---|---|
| Companion computer | NVIDIA Jetson Orin NX, active fan |
| Depth camera | Intel RealSense, front of battery tray, USB 3 to Jetson |
| Optical flow | ATK-PMW3901, downward — for indoor position hold |
| GPS / compass | **M10** (not M9N), on folding mast |

### Radios
| Item | Value |
|---|---|
| Telemetry | 915 MHz, 100 mW, on the baseboard |
| RC | ELRS modules found boxed — TX module and receiver, not yet bound |
| Transmitter | RadioMaster TX16S, EdgeTX |

### Power
| Item | Value |
|---|---|
| Flight battery | Tattu 12000 mAh **6S**, 22.2 V, 80C, 266.4 Wh, XT90 |
| Power module | Holybro PM08, DroneCAN |
| Distribution | PDB01-V1.2 — 1 × XT60 in, 6 × XT60 out |
| Arm power | XT30 per arm to the ESCs |
| Charger | HOTA S6 dual, 400 W AC / 650 W DC |
| Transmitter cells | 4 × 18650 3000 mAh, Efest LUC V6 charger — **different chemistry, keep separate** |

### Propellers
| Item | Value |
|---|---|
| Fitted (removed) | T-Motor clamp hubs with Gemfan blades |
| Spares | 5 bagged pairs, **Gemfan 1555T, 1CCW1CW** — 10 props total |
| Handedness marking | Yellow dot = one rotation, no dot = the other |
| Condition | 2 of the 4 removed props are **damaged** — frayed leading edge, chipped tip. Scrap. |
| Retention | Collet hub, 2 × M2.5 countersunk screws per prop |

---

## What has been verified in QGroundControl

Connected 19 September via FMU-USB, QGroundControl v5.1.4 on macOS.

| Item | Status |
|---|---|
| Airframe | ✅ Quadrotor X, Generic Quadcopter |
| Sensors | ✅ Compass 0, Compass 1, Gyro, Accelerometer — all Ready |
| Radio | ✅ Roll 1, Pitch 2, Yaw 4, Throttle 3 |
| Power | ✅ Power module source, 6 cells, 4.20 V full / 3.50 V empty |
| Flight modes | Mode switch on Channel 5; Mode 1 Altitude, Mode 2 Manual, 3–6 unassigned |
| Safety | Low battery → Warning · RC loss → Return · RTL climb 98.4 ft · RTL then Land |
| Joystick | ❌ None detected |
| Vehicle state | "Not Ready · Hold" — normal indoors, no GPS fix, no RC |

**Read:** the aircraft is far more configured than assumed. Someone did real setup work.

---

## Work completed

**Inventory.** Every component photographed and identified, including the optical flow board, the power module, the CSI camera and ribbon, the USB-to-UART adapter and the connector spares.

**Propellers removed.** All four off, screws retained, handedness marking understood. Two identified as damaged and withdrawn from service.

**Battery removed** and set aside. Aircraft is bare and safe on the bench.

**Flight controller located.** Initially believed absent — it is installed under the property sticker. The USB port is FMU-USB on the baseboard, not the Jetson's port. This was the cause of every failed connection attempt.

**QGroundControl connected** and the configuration summary read.

---

## Open items

| Item | Status |
|---|---|
| **Battery voltage** | Never measured. 6S should read 22–24.6 V. Needs a multimeter before the pack is used. |
| **Fireproof charging bag** | Not obtained. 266 Wh is a serious amount of stored energy. |
| **Masking tape and marker** | For labelling. Not obtained. |
| **USB-A female to USB-C male adapter** | Not needed any more — the existing cable reached FMU-USB. Still useful. |
| **Replacement props** | Not needed — 5 bagged pairs on hand. Confirm Gemfan hubs fit the T-Motor clamps. |
| **Motor test** | Not yet run. Needs the battery. |
| **RC binding** | Not started. ELRS modules found but unbound. |
| **SD card** | Presence in the FC not confirmed. ArduPilot wants one for logging. |

---

## Corrections made along the way

These were wrong at some point and are worth recording so they don't resurface.

- The GPS is an **M10**, not an M9N.
- The flight controller **is** installed. The bare-looking area was the property sticker covering it.
- The firmware is **ArduPilot**, not PX4 — QGroundControl still works, but parameter names and deeper configuration follow ArduPilot conventions, and Mission Planner would be the native tool.
- ESCs live **inside the arm tubes**, not on the frame.
- The correct USB port is **FMU-USB**, not the port beside the Debug button.

---

## Safety rules adopted

- Propellers off for all bench work. Last on, first off.
- Battery disconnected and contacts taped whenever not in active use.
- Motor direction verified with props off before any flight.
- ESC calibration deferred — not needed, and not a safe first procedure.
- Nothing flies outdoors without University authorisation.

---

## Next session

1. Measure the battery. Under 21 V on a 6S pack means stop and reassess.
2. Confirm an SD card is in the flight controller.
3. Connect the battery, press the safety switch, run the **motor test** in QGroundControl — one motor at a time, low throttle, props off.
4. Record which motor each output drives and which way it turns. Compare against the Quadrotor X diagram.
5. A wrong direction is a wiring fix: swap any two of the three bullet connectors between that ESC and its motor.
