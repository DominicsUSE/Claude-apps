# EMBERHATCH — Milestone A

**HATCH · FORGE · EXPLORE**

Milestone A takes mining out of the game and replaces it with collecting:

- **Ember Shards**: small glowing shards. Walk up and press **Collect**. The shard flies into you, "+1 Ember Shard" floats up, and the shard comes back 8 seconds later.
- **Ember Crystal Pods**: big crystal clusters. Hold **Break** for 1 second. The pod bursts and gives 3–10 Ember Shards plus a few coins, then grows back after 30–60 seconds. Rare (violet) pods can also give **Crystal Cores**. One is hidden behind the boulders in the north-west corner of the Sunken Grove.

`EmberHatch.rbxl` is the game file. Open it in Roblox Studio and press **Play**. (`EmberHatch.rbxlx` is the same place saved as text.)

## Open and play

1. Download `EmberHatch.rbxl` (on GitHub: open the file, then **Download raw file**).
2. Double-click it, or in Roblox Studio use **File → Open from File**.
3. The whole world is already in Workspace: Ember Hollow, the Sunken Grove, every shard and pod, and the lighting. Move or restyle anything in Studio, then press **Play**.

You spawn on the amber circle. The first shard is a few steps ahead. Follow the amber trail north to the Forge.

**Saving:** Studio only saves progress once the place is published and **Game Settings → Security → Enable Studio Access to API Services** is on. Without that, the game still runs and tells you that saving is off.

## What's in the game

| Where | What |
|---|---|
| Top left | Area name (Ember Hollow, Sunken Grove) |
| Top center | Coins, gems, level, XP bar |
| Right | Starter quests, with a hint for the next one |
| Bottom left | Ember Shards and Crystal Cores |
| Bottom right | Recent pickups |

Ember Hollow layout: spawn in the south, Forge Station in the center, Nursery and Egg Shop to the east, Quest Board and Upgrade Shop to the west, Portal Plaza to the north. The Sunken Grove portal is open from the start. Fungal Hollow opens at level 5 and Cinderworks at level 10; their areas get built in Milestone E.

Starter quests:

1. Collect your first Ember Shard
2. Hatch a Forgekin (starter egg in the Nursery)
3. Break an Ember Crystal Pod
4. Forge your first item (the Forge Station comes in a later milestone)
5. Unlock Fungal Hollow (reach level 5)

All rewards and progress are decided on the server. Clients can't send any gameplay requests: every action goes through a ProximityPrompt, which the server checks for distance, cooldowns and whether the shard or pod is actually there.

## Moving this into your existing place

This build is matched to your Forgekin Milestone 1 project and the Milestone A repair pass:

- **Saves carry over.** It uses your existing DataStore (`FORGEKIN_PLAYERDATA_V1`, keys `u_<UserId>`). Coins, gems, level, XP, settings, hatched Forgekin and equipped Forgekin are kept. Ores, pickaxes, stamina, carry capacity and the old mining quests are dropped from each save the next time it's written.
- **Forgekin data is the same.** Hatched Forgekin are stored as `{ uid, species, rarity, level, xp }`, and up to 3 equipped ones follow you. Players who already hatched Stoneback keep it and can't hatch the starter egg again.
- **The hub NPCs from the repair pass are still here**: four Forgekin wander Ember Hollow, rest between walks and stay away from the Forge.

To switch your place over, in this order:

1. **Back up your place** (File → Save to File As…).
2. **Delete the old scripts.** In `ServerScriptService`: RemotesSetup, DataService, InventoryService, StaminaService, OreService, PickaxeService, ForgekinService, ZoneService, QuestService, PlayerStatsService, HubBuilder, HubNPCService, PortalService, HubInteractionService and Main. In `StarterPlayerScripts`: HUDRoot, HUDController, HUDInit, MiningController, MiningHUD, NotificationOverlay, ForgekinPanel, InventoryPanel, QuestTracker, HubMinimap and PortalPanel. In `ReplicatedStorage.Shared`: GameConfig, OreConfig, ForgekinConfig, HubConfig, ZoneConfig and Theme.
3. **Delete the old world pieces:** `Workspace.ForgeHollow` (the hub is now built as `EmberHollow`), `Workspace.Hub` and its SpawnLocation, and every part tagged `OreNode`. Delete `Workspace.SunkenQuarry` too, or rename it to `SunkenGrove` and tag one part in it `ZoneEntry_SunkenGrove` (that's where players land).
4. **Copy in** `ReplicatedStorage.Shared`, `ServerScriptService.Server` and `StarterPlayer.StarterPlayerScripts.Client` from `EmberHatch.rbxl`. To get the built world too, also copy `Workspace.EmberHollow`, `Workspace.SunkenGrove`, `Workspace.Resources` and the three effects in `Lighting`; without them the scripts build the world when the server starts.
5. **Keep** `ReplicatedStorage.Assets.Forgekin` (your Stoneback model). Without it, a stone-and-brass placeholder is used.

Settings, sound, loading screen and mobile controls weren't in the files you sent, so they aren't in this build. To keep your Settings panel: leave SettingsService, SettingsPanel and their RemoteEvents in place, move `UILibrary` into the new `ReplicatedStorage.Shared`, and add `require(Server.SettingsService).Init()` to `Server/Main`. The new Theme still has every key the old UILibrary uses.

### Placing shards and pods by hand

Any Part tagged `EmberShard`, or any Model tagged `CrystalPod`, works automatically. Give a pod the attribute `Rare = true` to make it a core pod. To stop the built-in spawns, empty the lists in `Shared/ResourceConfig`.

A hand-built Sunken Grove (a folder named `SunkenGrove` in Workspace) needs a part tagged `ZoneEntry_SunkenGrove` where players land. A hand-built hub goes in a folder named `EmberHollow`.

## Tuning

Everything about collecting is in `src/shared/ResourceConfig.luau`: respawn times, pod rewards, rare core chance, XP, and where shards and pods are placed. Quests and rewards are in `src/shared/QuestConfig.luau`.

## For developers

The source is a [Rojo](https://rojo.space) project:

```
src/shared  → ReplicatedStorage.Shared       (Theme, configs)
src/server  → ServerScriptService.Server     (Main, DataService, ResourceService, QuestService,
                                              ForgekinService, PortalService, HubBuilder, GroveBuilder)
src/client  → StarterPlayerScripts.Client    (Main, HUD, CollectVFX)
```

Rebuild the game file after editing. Rojo builds the scripts, then the bake step runs the world builders once and saves the world into the place:

```
rojo build default.project.json -o build/scripts.rbxlx
lune run tools/bake.luau
```

Playtest the built file without Studio (needs [Lune](https://lune-org.github.io/docs), e.g. `cargo install lune`):

```
lune run playtest/run.luau live
lune run playtest/run.luau studio
python3 playtest/map.py playtest/out/world-live.json playtest/map.png
```

Each run prints its result and writes a report to `playtest/out/`. The latest results are in `playtest/REPORT.md`.

Check that no removed-system words came back into any script:

```
python3 tools/check_words.py
```
