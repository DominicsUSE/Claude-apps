# EMBERHATCH — Milestone A

**HATCH · FORGE · EXPLORE**

Milestone A takes mining out of the game and replaces it with collecting:

- **Ember Shards**: small glowing shards. Walk up and press **Collect**. The shard flies into you, "+1 Ember Shard" floats up, and the shard comes back 8 seconds later.
- **Ember Crystal Pods**: big crystal clusters. Hold **Break** for 1 second. The pod bursts and gives 3–10 Ember Shards plus a few coins, then grows back after 30–60 seconds. Rare (violet) pods can also give **Crystal Cores**. One is hidden behind the boulders in the north-west corner of the Sunken Grove.

`EmberHatch.rbxlx` is the game file. Open it in Roblox Studio and press **Play**.

## Open and play

1. Download `EmberHatch.rbxlx` (on GitHub: open the file, then **Download raw file**).
2. Double-click it, or in Roblox Studio use **File → Open from File**.
3. Press **Play**. The world builds itself when the game starts, so Workspace looks empty until then.

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

Your current scripts weren't in this repository, so this file is a complete, working Milestone A on its own. To bring it into the place you've been building:

1. **Delete the old mining scripts and objects**: OreService, PickaxeService, MiningHUD, StaminaService, any ore nodes (and their tag), pickaxe tools in StarterPack or ServerStorage, and the mining remotes (RequestMine, RequestSwing, OreHit, OreBroken, OreCrack, OreRespawn, StaminaUpdated).
2. **Copy in** `ReplicatedStorage.Shared`, `ServerScriptService.Server` and `StarterPlayer.StarterPlayerScripts.Client` from `EmberHatch.rbxlx`. They replace your old DataService, HubBuilder, HubConfig, ZoneConfig, PortalService, PortalPanel and HUD scripts.
3. **Keep your old saves:** in `Server/DataService`, set `STORE_NAME` and `KEY_PREFIX` to the ones your old DataService used. On load, coins, gems, XP, level and settings carry over, and every field from the removed systems is dropped.
4. **Your own Forgekin models:** put them in `ReplicatedStorage.Assets.Forgekin` (for example `Stoneback`). Without them, a stone-and-brass placeholder follows you.

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

Rebuild the game file after editing:

```
rojo build default.project.json -o EmberHatch.rbxlx
```

Check that no removed-system words came back into any script:

```
python3 tools/check_words.py
```
