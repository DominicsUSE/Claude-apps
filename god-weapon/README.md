# God Weapon

An auto-aim Tool for your own Roblox game. Click and it hits the nearest valid target near your crosshair. All targeting and damage run on the server, so exploiters can't fake hits.

## Setup in Studio

1. In `StarterPack`, add a `Tool` named `GodWeapon`. Set `RequiresHandle` to false, or add a `Handle` part with a model.
2. Inside the Tool, add a `RemoteEvent` named `Fire`.
3. Inside the Tool, add a `Script` and paste `GodWeapon.server.lua` into it.
4. Inside the Tool, add a `LocalScript` and paste `GodWeapon.client.lua` into it.
5. To make NPCs hittable, select the NPC model and add the tag `Target` to it (Properties panel, Tags).

## Settings

Edit the `Settings` table at the top of `GodWeapon.server.lua`:

| Setting | Default | Meaning |
|---|---|---|
| `Damage` | `math.huge` | Damage per shot. `math.huge` kills in one hit. |
| `Range` | `500` | Maximum distance in studs. |
| `ConeAngle` | `15` | How far off the crosshair (in degrees) a target can be. |
| `Cooldown` | `0.2` | Seconds between shots. |
| `TeamCheck` | `true` | Skip players on your team. |
| `WallCheck` | `true` | Skip targets behind walls. |
| `LockPart` | `"Head"` | Body part to aim at. |
| `NPCTag` | `"Target"` | Tag that marks NPCs as hittable. |

## Testing

Use Test > Clients and Servers with 2 players, or tag an R15 rig with `Target`.
