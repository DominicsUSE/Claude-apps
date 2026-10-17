# Shadow Tag: Lights Out

Round-based hide-and-seek horror for 8–10 players, set in an abandoned subway station. One player is secretly The Shadow. Every 30 seconds another zone loses power. Survivors must board the last train before it leaves; tagged survivors become Shadows.

Pure Luau, synced with [Rojo](https://rojo.space). The map is built from code at server start (`src/server/MapBuilder.luau`), so the place file contains only scripts.

## Run it

```sh
rojo build default.project.json -o ShadowTag.rbxlx   # open the file in Studio
# or live-sync: rojo serve, then connect from the Rojo Studio plugin
```

In Studio, use **Test > Start** with 1 player to fight the AI Shadow, or 2+ players for PvP. In Game Settings, set max players to 10.

## Round flow

| Phase | Time | What happens |
|---|---|---|
| Lobby | 15 s | Street hall, lights on |
| Hiding | 10 s | Everyone spawns as a survivor; one player is secretly told they are The Shadow |
| Round | 4 min | The Shadow transforms and one zone blacks out; another every 30 s. Train doors open at 1:30, final call at 0:45, doors close at 0:00 |
| Results | 10 s | "Survivors Escaped" if anyone boarded, otherwise "The Shadows Consumed the Station" |

With fewer than 2 players, or if every Shadow leaves mid-round, an AI Shadow hunts instead. It sees survivors in line of sight, spots lit flashlights from further away, hears sprinting and investigates breaker noise.

## Controls

| Action | Keyboard | Gamepad | Mobile |
|---|---|---|---|
| Sprint (drains stamina, loud footsteps) | Shift (hold) | L3 | SPRINT |
| Crouch (slow, silent) | C / Ctrl | B | CROUCH |
| Flashlight | F | Y | LIGHT |
| Throw glowstick | Left click / G | R2 | GLOW |
| Breaker / board train | E (hold) | X | tap the large prompt |

## Mechanics

- **Flashlight**: about 90 s of battery, recharges while off. While on, Shadows see a marker on you from 90 studs.
- **Glowsticks**: start with 2, max 4, pick up more around the map. A lit glowstick lasts 15 s. Survivors inside its 11-stud light can't be tagged, and Shadows inside move 40% slower.
- **Breakers** (maintenance room): hold to restore a dark zone for 20 s. The noise shows every Shadow roughly where you are.
- **The Shadow**: no flashlight, night vision, 15% faster in dark zones, tags on touch. Can't use breakers or board the train.

## Server authority

Clients only send intents (sprint, crouch, flashlight, glowstick direction). The server:

- runs stamina, battery, speed, crouch and glowstick counts
- detects tags itself by distance plus a wall raycast every frame, so clients never report tags
- validates breakers and train boarding by role, phase, distance and cooldown
- rate-limits remotes
- pulls back characters that move much faster than their assigned speed

## Files

```
src/shared   Config (every tunable), Zones, Net (remotes + GameState), Sounds
src/server   MapBuilder, Power, Roster, Glowsticks, Breakers, Train, Tagging, ShadowForm, ShadowBot, Round
src/client   Input, Hud, Prompts, World (lighting/visual tells), Audio
```

## Audio

Every sound uses a file that ships with the Roblox client (`rbxasset://sounds/...`), re-pitched, so the game has audio out of the box. For real atmosphere, replace the `id` values in `src/shared/Sounds.luau` with Creator Store audio (search: *water drip*, *subway rumble*, *fluorescent buzz*, *heartbeat*, *horror sting*, *train horn*, *dark ambient*).

## Performance

- Streaming is off (the map is about 1k parts).
- Fluorescent fixtures use non-shadowed SurfaceLights.
- Only your own flashlight casts shadows, set locally.
- Flicker, ambient darkness and markers run client-side, so they cost no network traffic.
