--!nocheck
-- Plays EMBERHATCH from a script on top of engine.luau and writes a report.
-- Run from the emberhatch folder:
--   lune run playtest/run.luau live      (DataStores working, like a live server)
--   lune run playtest/run.luau studio    (Studio with API access off, on a phone)

local fs = require("@lune/fs")
local serde = require("@lune/serde")
local process = require("@lune/process")
local roblox = require("@lune/roblox")

local Engine = require("./engine")

local Vector3, CFrame = roblox.Vector3, roblox.CFrame
local task = Engine.task
local MODE = process.args[1] or "live"
math.randomseed(tonumber(process.args[2]) or 7)

local STORE = "FORGEKIN_PLAYERDATA_V1"
local T0 = 1760000000 -- engine's os.time() at t=0
local BANNED = { "mine", "mines", "mining", "miner", "miners", "ore", "ores", "pickaxe", "pickaxes" }

-- ── Results ──────────────────────────────────────────────

local results, metrics, notes = {}, {}, {}
local section = "Setup"
local function check(name, ok, detail)
	table.insert(results, { section = section, name = name, ok = ok == true, detail = detail })
end
local function metric(name, value)
	table.insert(metrics, { name = name, value = value })
end

-- ── Helpers ──────────────────────────────────────────────

local game, CollectionService, PPS
local path = {}

local function waitFor(condition, timeout)
	local deadline = Engine.now() + timeout
	while not condition() and Engine.now() < deadline do
		task.wait(0.1)
	end
	return condition()
end

local function root(player)
	return player.Character and player.Character:FindFirstChild("HumanoidRootPart")
end

local function flat(v)
	return Vector3.new(v.X, 0, v.Z)
end

local function promptOf(inst)
	return inst:FindFirstChildWhichIsA("ProximityPrompt", true)
end

local function positionOf(inst)
	return if inst:IsA("Model") then inst:GetPivot().Position else inst.Position
end

local function groundY(position)
	local exclude = {}
	for _, player in ipairs(game.Players:GetPlayers()) do
		if player.Character then
			table.insert(exclude, player.Character)
		end
	end
	local resources = Engine.workspace:FindFirstChild("Resources")
	if resources then
		table.insert(exclude, resources)
	end
	local npcs = Engine.workspace:FindFirstChild("EmberHollow") and Engine.workspace.EmberHollow:FindFirstChild("NPCs")
	if npcs then
		table.insert(exclude, npcs)
	end
	local rayParams = {
		FilterType = roblox.Enum.RaycastFilterType.Exclude,
		FilterDescendantsInstances = exclude,
	}
	local hit = Engine.workspace:Raycast(position + Vector3.new(0, 4, 0), Vector3.new(0, -40, 0), rayParams)
	return if hit then hit.Position.Y else 0
end

-- Walks in a straight line at 16 studs/s until within `stop` studs of the target.
local function walkTo(player, target, stop)
	stop = stop or 3
	local lastLog = -1
	while true do
		local r = root(player)
		local offset = flat(target) - flat(r.Position)
		if offset.Magnitude <= stop then
			return
		end
		local dt = task.wait(1 / 30)
		local stepLength = math.min(offset.Magnitude - stop + 0.01, 16 * dt)
		local nextPos = flat(r.Position) + offset.Unit * stepLength
		nextPos = Vector3.new(nextPos.X, groundY(nextPos) + 3, nextPos.Z)
		player.Character:PivotTo(CFrame.lookAt(nextPos, nextPos + offset.Unit))
		if player == Engine.localPlayer and Engine.now() - lastLog > 0.5 then
			lastLog = Engine.now()
			table.insert(path, { x = nextPos.X, z = nextPos.Z })
		end
	end
end

-- Presses (or holds) a prompt the way the engine would: only if it's enabled and in reach.
local function usePrompt(player, prompt)
	local r = root(player)
	local reach = (r.Position - prompt.Parent.Position).Magnitude
	if not prompt.Enabled or reach > prompt.MaxActivationDistance then
		return false
	end
	local isLocal = player == Engine.localPlayer
	if prompt.HoldDuration > 0 then
		prompt.PromptButtonHoldBegan:Fire(player)
		if isLocal then
			PPS.PromptButtonHoldBegan:Fire(prompt, player)
		end
		task.wait(prompt.HoldDuration)
		prompt.PromptButtonHoldEnded:Fire(player)
		if isLocal then
			PPS.PromptButtonHoldEnded:Fire(prompt, player)
		end
	end
	prompt.Triggered:Fire(player)
	if isLocal then
		PPS.PromptTriggered:Fire(prompt, player)
	end
	task.wait(0.05)
	return true
end

local function walkAndUse(player, inst)
	local prompt = promptOf(inst)
	walkTo(player, prompt.Parent.Position, prompt.MaxActivationDistance - 2)
	return usePrompt(player, prompt)
end

local function inGrove(position)
	return position.Z > 300
end

local function nearestAvailable(player, tags, filter)
	local best, bestDistance
	local here = root(player).Position
	for _, tag in ipairs(tags) do
		for _, inst in ipairs(CollectionService:GetTagged(tag)) do
			local prompt = promptOf(inst)
			local position = positionOf(inst)
			if prompt and prompt.Enabled and (not filter or filter(position, inst)) then
				local distance = (flat(position) - flat(here)).Magnitude
				if not bestDistance or distance < bestDistance then
					best, bestDistance = inst, distance
				end
			end
		end
	end
	return best
end

local function quests(player)
	local list = serde.decode("json", player:GetAttribute("QuestState") or "[]")
	local byId = {}
	for _, quest in ipairs(list) do
		byId[quest.id] = quest
	end
	return byId, list
end

local function lastRemote(name, since)
	for i = #Engine.clientRemoteLog, 1, -1 do
		local entry = Engine.clientRemoteLog[i]
		if entry.remote == name and entry.t >= (since or 0) then
			return entry
		end
	end
	return nil
end

local function notifiedSince(since, pattern)
	for _, entry in ipairs(Engine.clientRemoteLog) do
		if entry.remote == "Notify" and entry.t >= since and tostring(entry.args[1]):find(pattern) then
			return entry.args[1]
		end
	end
	return nil
end

local function guiTextExists(container, text)
	for _, inst in ipairs(container:GetDescendants()) do
		if inst:IsA("TextLabel") and inst.Text:find(text, 1, true) then
			return true
		end
	end
	return false
end

local function stored(userId)
	local entries = Engine.stores[STORE] or {}
	local raw = entries["u_" .. userId]
	return raw and serde.decode("json", raw)
end

local function server(name)
	return Engine.moduleValue(game.ServerScriptService.Server[name])
end

local function keysOf(t)
	local list = {}
	for k in pairs(t or {}) do
		table.insert(list, tostring(k))
	end
	table.sort(list)
	return list
end

local function bannedWordIn(text)
	local lower = " " .. text:lower() .. " "
	for _, word in ipairs(BANNED) do
		if lower:find("%f[%a]" .. word .. "%f[%A]") then
			return word
		end
	end
	return nil
end

-- ── Legacy saves used by the live run ────────────────────

local legacy = {
	version = 1,
	coins = 340,
	gems = 12,
	level = 3,
	xp = 150,
	stamina = 64,
	carryUsed = 27,
	inventory = { Stone = 14, Coal = 8, Copper = 5 },
	pickaxes = { { id = "RustyPick", tier = 1, quality = 1, durability = 80, maxDurability = 100 } },
	equippedPickaxe = "RustyPick",
	forgekin = { { uid = "2002_1700000000_1234", species = "Stoneback", rarity = "Common", level = 1, xp = 0 } },
	equippedForgekin = { "2002_1700000000_1234" },
	unlockedZones = { SunkenQuarry = true },
	discoveredEggs = {},
	questProgress = { MineFirstOre = true },
	flags = { starterEggClaimed = true },
	stats = { totalOresMined = 27, totalOresByType = { Stone = 14 }, totalCoinsEarned = 340, playSeconds = 900 },
}

-- ── Scenarios ────────────────────────────────────────────

local function bootChecks()
	section = "World"
	check("Server starts with no script errors", #Engine.errors == 0, Engine.errors[1])
	local ws = Engine.workspace
	check("Ember Hollow hub is built", ws:FindFirstChild("EmberHollow") ~= nil)
	check("Sunken Grove is built", ws:FindFirstChild("SunkenGrove") ~= nil)
	local shards = CollectionService:GetTagged("EmberShard")
	local pods = CollectionService:GetTagged("CrystalPod")
	local rare = 0
	for _, pod in ipairs(pods) do
		if pod:GetAttribute("Rare") then
			rare += 1
		end
	end
	check("28 Ember Shards placed (12 hub, 16 grove)", #shards == 28, #shards .. " shards")
	check("7 Crystal Pods placed, 1 of them rare", #pods == 7 and rare == 1, ("%d pods, %d rare"):format(#pods, rare))
	local missing = 0
	for _, inst in ipairs(shards) do
		if not promptOf(inst) then
			missing += 1
		end
	end
	for _, inst in ipairs(pods) do
		if not promptOf(inst) then
			missing += 1
		end
	end
	check("Every shard and pod has a prompt", missing == 0, missing .. " missing")
	local lowest = math.huge
	for _, shard in ipairs(shards) do
		lowest = math.min(lowest, shard.Position.Y - groundY(shard.Position))
	end
	check("Shards float above the ground, none buried", lowest > 1, ("lowest %.2f studs above ground"):format(lowest))
	local npcs = ws.EmberHollow:FindFirstChild("NPCs")
	check("4 Forgekin NPCs wander the hub", npcs and #npcs:GetChildren() == 4)

	local parts, lights, emitters = 0, 0, 0
	for _, inst in ipairs(ws:GetDescendants()) do
		if inst:IsA("BasePart") then
			parts += 1
		elseif inst:IsA("Light") then
			lights += 1
		elseif inst:IsA("ParticleEmitter") then
			emitters += 1
		end
	end
	metric("Parts in the world", parts)
	metric("Lights", lights)
	metric("Particle emitters", emitters)
end

local function textScan()
	section = "Text"
	local found = {}
	for _, inst in ipairs(game:GetDescendants()) do
		local ok, text = pcall(function()
			if inst:IsA("TextLabel") or inst:IsA("TextButton") then
				return inst.Text
			elseif inst:IsA("ProximityPrompt") then
				return inst.ActionText .. " " .. inst.ObjectText
			end
			return nil
		end)
		if ok and text then
			local word = bannedWordIn(text)
			if word then
				table.insert(found, ("%s: %q"):format(inst:GetFullName(), text))
			end
		end
	end
	for _, entry in ipairs(Engine.clientRemoteLog) do
		if entry.remote == "Notify" then
			local word = bannedWordIn(tostring(entry.args[1]) .. " " .. tostring(entry.args[3] or ""))
			if word then
				table.insert(found, "Notify: " .. tostring(entry.args[1]))
			end
		end
	end
	check("No removed-system words in any sign, label, prompt or message", #found == 0, found[1])
end

local function liveRun()
	bootChecks()

	section = "Joining"
	local player = Engine.addPlayer(1001, "Tester", true)
	task.wait(0.1)
	Engine.spawnCharacter(player)
	local spawnedAt = Engine.now()
	waitFor(function()
		return player:GetAttribute("DataLoaded")
	end, 5)
	check("Profile loads", player:GetAttribute("DataLoaded") == true)
	check("Saving is on", player:GetAttribute("SaveMode") == "ok", player:GetAttribute("SaveMode"))
	local hud = player.PlayerGui:FindFirstChild("EmberHatchHUD")
	check("HUD is built", hud ~= nil)
	check("Title card reads EMBERHATCH / HATCH · FORGE · EXPLORE", hud and guiTextExists(hud, "EMBERHATCH") and guiTextExists(hud, "HATCH · FORGE · EXPLORE"))
	local byId, list = quests(player)
	check("5 starter quests listed", #list == 5, #list)
	check("Spawn faces north toward the Forge", root(player).CFrame.LookVector.Z < -0.9)
	check("Area panel says Ember Hollow", hud and guiTextExists(hud.Area, "Ember Hollow"))

	section = "First Ember Shard"
	local shard = nearestAvailable(player, { "EmberShard" })
	walkAndUse(player, shard)
	local firstPickup = Engine.now() - spawnedAt
	metric("Seconds from spawn to first Ember Shard", ("%.1f"):format(firstPickup))
	check("First shard collected within 10 seconds", firstPickup <= 10, ("%.1f s"):format(firstPickup))
	check("Ember Shards = 1", player:GetAttribute("EmberShards") == 1, player:GetAttribute("EmberShards"))
	byId = quests(player)
	check("Quest 'Collect your first Ember Shard' complete", byId.FirstShard and byId.FirstShard.done)
	check("Quest reward: 25 coins", player:GetAttribute("Coins") == 25, player:GetAttribute("Coins"))
	check("Shard disappears and its prompt turns off", shard.Transparency == 1 and not promptOf(shard).Enabled)
	task.wait(0.5)
	check("Client was told about the pickup", lastRemote("ResourceCollected") ~= nil)
	check("Floating '+1 Ember Shard' text appears", guiTextExists(player.PlayerGui, "+1 Ember Shard"))
	check("Pickup feed shows '+1 Ember Shard'", guiTextExists(hud.PickupFeed, "+1 Ember Shard"))
	check("Quest-complete toast shows", guiTextExists(hud.Toasts, "Quest complete"))
	task.wait(8)
	check("Shard comes back after 8 seconds", shard.Transparency == 0 and promptOf(shard).Enabled)

	section = "Cheating"
	local before = player:GetAttribute("EmberShards")
	local far = nearestAvailable(player, { "EmberShard" }, inGrove)
	promptOf(far).Triggered:Fire(player) -- what an exploit firing a prompt from the hub looks like
	task.wait(0.1)
	check("Collecting a Sunken Grove shard from the hub is rejected", player:GetAttribute("EmberShards") == before)
	local near = nearestAvailable(player, { "EmberShard" })
	walkTo(player, near.Position, 5)
	promptOf(near).Triggered:Fire(player)
	promptOf(near).Triggered:Fire(player)
	task.wait(0.1)
	check("Firing one shard's prompt twice pays once", player:GetAttribute("EmberShards") == before + 1)

	section = "Ember Crystal Pod"
	local pod = nearestAvailable(player, { "CrystalPod" })
	local shardsBefore, coinsBefore = player:GetAttribute("EmberShards"), player:GetAttribute("Coins")
	local holdStart = Engine.now()
	walkAndUse(player, pod)
	local payload = lastRemote("ResourceCollected", holdStart)
	payload = payload and payload.args[1]
	check("Break needs a 1-second hold", promptOf(pod).HoldDuration == 1)
	check("Pod gives 3–10 Ember Shards", payload and payload.shards >= 3 and payload.shards <= 10, payload and payload.shards)
	check("Pod gives 4–12 coins", payload and payload.coins >= 4 and payload.coins <= 12, payload and payload.coins)
	check(
		"HUD totals match what the pod gave (+50 coin quest reward)",
		payload
			and player:GetAttribute("EmberShards") == shardsBefore + payload.shards
			and player:GetAttribute("Coins") == coinsBefore + payload.coins + 50
	)
	byId = quests(player)
	check("Quest 'Break an Ember Crystal Pod' complete", byId.BreakPod and byId.BreakPod.done)
	check("Pod disappears and stops blocking", pod.Rock.Transparency == 1 and pod.Rock.CanCollide == false)
	check("Pod burst effect plays", Engine.emitted > 0)
	local brokeAt = Engine.now()
	task.wait(29)
	check("Pod stays broken for at least 30 seconds", not promptOf(pod).Enabled)
	waitFor(function()
		return promptOf(pod).Enabled
	end, 32)
	local respawn = Engine.now() - brokeAt
	check("Pod grows back within 30–60 seconds", promptOf(pod).Enabled and respawn <= 61, ("%.0f s"):format(respawn))

	section = "Starter egg"
	local pedestal = CollectionService:GetTagged("StarterEgg")[1]
	local spawnPoint = Engine.workspace.EmberHollow.Spawn.PlayerSpawn.Position
	metric("Walk from spawn to the starter egg (seconds at normal speed)", ("%.0f"):format((flat(pedestal.Position) - flat(spawnPoint)).Magnitude / 16))
	local hatchAt = Engine.now()
	walkAndUse(player, pedestal)
	check("Client plays the hatch (egg wobble + burst)", lastRemote("EggHatched", hatchAt) ~= nil)
	task.wait(1.6)
	local follower = Engine.workspace:FindFirstChild("Tester_Stoneback")
	check("Stoneback appears next to the player", follower ~= nil)
	local profile = server("DataService").Get(player)
	local fk = profile.forgekin[1]
	check("Saved like Milestone 1: { uid, species, rarity, level, xp }", fk and fk.species == "Stoneback" and type(fk.uid) == "string" and fk.rarity == "Common")
	check("Stoneback is equipped", fk and profile.equippedForgekin[1] == fk.uid)
	byId = quests(player)
	check("Quest 'Hatch a Forgekin' complete, +5 gems", byId.HatchForgekin and byId.HatchForgekin.done and player:GetAttribute("Gems") == 5)
	walkTo(player, root(player).Position + Vector3.new(-30, 0, 0), 0.5)
	task.wait(1)
	local gap = follower and (follower:GetPivot().Position - root(player).Position).Magnitude
	check("Stoneback follows the player", gap and gap < 8, gap and ("%.1f studs behind"):format(gap))
	local again = Engine.now()
	walkAndUse(player, pedestal)
	task.wait(0.2)
	check("Starter egg can't be hatched twice", #profile.forgekin == 1 and notifiedSince(again, "already hatched") ~= nil)

	section = "Hub stations"
	local anvil = Engine.workspace.EmberHollow.Forge.Anvil
	local pressed = Engine.now()
	walkAndUse(player, anvil)
	check("Forge Station says it opens soon", notifiedSince(pressed, "Forge Station") ~= nil)

	section = "Portals"
	local gates = {}
	for _, prompt in ipairs(CollectionService:GetTagged("Portal")) do
		local id = prompt:GetAttribute("Portal")
		if prompt:GetAttribute("UnlockLevel") then
			gates[id] = prompt
		end
	end
	check("Fungal Hollow gate shows 'Locked · Lv 5'", gates.FungalHollow.ActionText == "Locked · Lv 5", gates.FungalHollow.ActionText)
	local tried = Engine.now()
	walkTo(player, gates.FungalHollow.Parent.Position, 6)
	usePrompt(player, gates.FungalHollow)
	check("Locked gate refuses below level 5", notifiedSince(tried, "unlocks at level 5") ~= nil and player:GetAttribute("Zone") == "EmberHollow")
	task.wait(1.6)
	walkTo(player, gates.SunkenGrove.Parent.Position, 6)
	usePrompt(player, gates.SunkenGrove)
	task.wait(0.4)
	local entry = CollectionService:GetTagged("ZoneEntry_SunkenGrove")[1]
	check("Sunken Grove gate teleports into the grove", player:GetAttribute("Zone") == "SunkenGrove")
	check("Player lands on the ground at the grove entrance", (root(player).Position - entry.Position).Magnitude < 5, tostring(root(player).Position))
	check("Area panel switches to Sunken Grove", guiTextExists(hud.Area, "Sunken Grove"))
	table.insert(path, { x = root(player).Position.X, z = root(player).Position.Z, jump = true })

	section = "Playing to level 5 in the Sunken Grove"
	local playStart = Engine.now()
	local collected, broken = 0, 0
	while player:GetAttribute("Level") < 5 and Engine.now() - playStart < 30 * 60 do
		local target = nearestAvailable(player, { "EmberShard", "CrystalPod" }, inGrove)
		if target then
			if walkAndUse(player, target) then
				if CollectionService:HasTag(target, "CrystalPod") then
					broken += 1
				else
					collected += 1
				end
			end
		else
			task.wait(1)
		end
	end
	local minutes = (Engine.now() - playStart) / 60
	metric("Minutes from spawning to level 5 (includes test pauses, ~1.5 min)", ("%.1f"):format((Engine.now() - spawnedAt) / 60))
	metric("Minutes of grove play from level 1–2 to level 5", ("%.1f"):format(minutes))
	metric("Shards picked up / pods broken on the way", collected .. " / " .. broken)
	check("Reaches level 5 (unlocks Fungal Hollow)", player:GetAttribute("Level") >= 5, ("%.1f min"):format(minutes))
	byId = quests(player)
	check("Quest 'Unlock Fungal Hollow' complete, +10 gems", byId.UnlockFungal and byId.UnlockFungal.done and player:GetAttribute("Gems") == 15, player:GetAttribute("Gems"))
	check("Fungal Hollow gate now shows 'Enter'", gates.FungalHollow.ActionText == "Enter", gates.FungalHollow.ActionText)
	check("XP bar text matches the server", guiTextExists(hud.Stats, ("%d / %d"):format(player:GetAttribute("XP"), player:GetAttribute("XPNext"))))

	section = "Rare pod and Crystal Cores"
	local rarePod
	for _, pod2 in ipairs(CollectionService:GetTagged("CrystalPod")) do
		if pod2:GetAttribute("Rare") then
			rarePod = pod2
		end
	end
	local cores = player:GetAttribute("CrystalCores")
	local rareBreaks = 0
	while player:GetAttribute("CrystalCores") == cores and rareBreaks < 4 do
		waitFor(function()
			return promptOf(rarePod).Enabled
		end, 65)
		if walkAndUse(player, rarePod) then
			rareBreaks += 1
		end
	end
	check("Rare pod gives Crystal Cores", player:GetAttribute("CrystalCores") > cores, ("%d core(s) after %d break(s)"):format(player:GetAttribute("CrystalCores") - cores, rareBreaks))
	check("Crystal Cores panel updates", guiTextExists(hud.Resources, tostring(player:GetAttribute("CrystalCores"))))

	section = "Going home"
	local home = CollectionService:GetTagged("Portal")
	local returnGate
	for _, prompt in ipairs(home) do
		if prompt:GetAttribute("Portal") == "EmberHollow" then
			returnGate = prompt
		end
	end
	walkTo(player, returnGate.Parent.Position, 6)
	usePrompt(player, returnGate)
	task.wait(0.4)
	check("Return gate brings the player back to Ember Hollow", player:GetAttribute("Zone") == "EmberHollow" and root(player).Position.Z < 100)
	table.insert(path, { x = root(player).Position.X, z = root(player).Position.Z, jump = true })
	task.wait(1.6)
	walkTo(player, gates.FungalHollow.Parent.Position, 6)
	local opened = Engine.now()
	usePrompt(player, gates.FungalHollow)
	check("Fungal Hollow (level 5) says it opens soon", notifiedSince(opened, "Fungal Hollow opens soon") ~= nil)

	section = "Saving"
	local save = stored(1001)
	check("Autosave wrote the profile", save ~= nil and save._lock and save._lock.jobId == "mock-server-1")
	local finalShards, finalCores, finalCoins = player:GetAttribute("EmberShards"), player:GetAttribute("CrystalCores"), player:GetAttribute("Coins")
	Engine.removePlayer(player)
	task.wait(1)
	save = stored(1001)
	check("Leaving saves everything", save and save.emberShards == finalShards and save.crystalCores == finalCores and save.coins == finalCoins)
	check("Leaving releases the session lock", save and save._lock == nil)
	check("Follower is removed when the player leaves", Engine.workspace:FindFirstChild("Tester_Stoneback") == nil)

	local back = Engine.addPlayer(1001, "Tester", false)
	Engine.spawnCharacter(back)
	waitFor(function()
		return back:GetAttribute("DataLoaded")
	end, 5)
	task.wait(0.5)
	check("Rejoining restores shards, cores and coins", back:GetAttribute("EmberShards") == finalShards and back:GetAttribute("CrystalCores") == finalCores and back:GetAttribute("Coins") == finalCoins)
	check("Rejoining brings Stoneback back", Engine.workspace:FindFirstChild("Tester_Stoneback") ~= nil)
	byId = quests(back)
	check("Finished quests stay finished", byId.FirstShard.done and byId.BreakPod.done and byId.HatchForgekin.done and byId.UnlockFungal.done)

	section = "Old Forgekin save (Milestone 1 format)"
	local veteran = Engine.addPlayer(2002, "Veteran", false)
	Engine.spawnCharacter(veteran)
	waitFor(function()
		return veteran:GetAttribute("DataLoaded")
	end, 5)
	task.wait(0.5)
	check("Coins and gems carry over (340 / 12)", veteran:GetAttribute("Coins") >= 340 and veteran:GetAttribute("Gems") >= 12, ("%s coins, %s gems"):format(veteran:GetAttribute("Coins"), veteran:GetAttribute("Gems")))
	check("Level carries over (3 or more)", veteran:GetAttribute("Level") >= 3, veteran:GetAttribute("Level"))
	check("XP is below the next level", veteran:GetAttribute("XP") < veteran:GetAttribute("XPNext"), ("%d / %d"):format(veteran:GetAttribute("XP"), veteran:GetAttribute("XPNext")))
	check("Their Stoneback follows them", Engine.workspace:FindFirstChild("Veteran_Stoneback") ~= nil)
	byId = quests(veteran)
	check("'Hatch a Forgekin' counts as done (they already have one)", byId.HatchForgekin and byId.HatchForgekin.done)
	Engine.removePlayer(veteran)
	task.wait(1)
	save = stored(2002)
	local leftovers = {}
	for _, key in ipairs({ "inventory", "pickaxes", "equippedPickaxe", "stamina", "carryUsed", "unlockedZones", "questProgress" }) do
		if save[key] ~= nil then
			table.insert(leftovers, key)
		end
	end
	for _, key in ipairs({ "totalOresMined", "totalOresByType" }) do
		if save.stats[key] ~= nil then
			table.insert(leftovers, "stats." .. key)
		end
	end
	check("Removed-system data is gone from the save", #leftovers == 0, table.concat(leftovers, ", "))
	check("Forgekin and equipped list are kept", save.forgekin[1].species == "Stoneback" and save.equippedForgekin[1] == save.forgekin[1].uid)
	notes.legacyKeys = table.concat(keysOf(save), ", ")

	section = "Session lock"
	-- Another server saved this profile a few seconds ago and still holds it.
	Engine.stores[STORE].u_3003 = serde.encode("json", { coins = 5, _lock = { jobId = "other-server", time = T0 + math.floor(Engine.now()) - 5 } })
	local locked = Engine.addPlayer(3003, "Rejoiner", false)
	waitFor(function()
		return #Engine.kicks > 0
	end, 40)
	local kick = Engine.kicks[1]
	check("Profile still locked by another server: player is asked to rejoin", kick and kick.player == "Rejoiner" and kick.message:find("still saving") ~= nil, kick and kick.message)
	check("Locked profile is left untouched", stored(3003)._lock.jobId == "other-server" and stored(3003).coins == 5)
	local stale = Engine.addPlayer(4004, "Returner", false)
	waitFor(function()
		return stale:GetAttribute("DataLoaded")
	end, 10)
	check("Stale lock from a crashed server is taken over", stale:GetAttribute("DataLoaded") == true and stored(4004)._lock.jobId == "mock-server-1")
	locked = nil

	section = "Server shutdown"
	Engine.shutdown()
	task.wait(2)
	check("Shutdown saves and unlocks everyone", stored(1001)._lock == nil and stored(4004)._lock == nil)

	textScan()
end

local function studioRun()
	bootChecks()

	section = "Studio test, API access off, phone screen"
	local player = Engine.addPlayer(1001, "Tester", true)
	task.wait(0.1)
	Engine.spawnCharacter(player)
	local joined = Engine.now()
	waitFor(function()
		return player:GetAttribute("DataLoaded")
	end, 5)
	local loadTime = Engine.now() - joined
	check("Game still loads without DataStores", player:GetAttribute("DataLoaded") == true)
	check("…in under a second (no retry stalls)", loadTime < 1, ("%.2f s"):format(loadTime))
	check("Save mode is 'offline'", player:GetAttribute("SaveMode") == "offline")
	task.wait(0.2)
	local hud = player.PlayerGui.EmberHatchHUD
	check("HUD tells the player saving is off", guiTextExists(hud.Toasts, "Saving is off"))
	check("Only one DataStore call was tried", Engine.storeCalls <= 1, Engine.storeCalls .. " calls")
	local feedLift = hud.PickupFeed.Position.Y.Offset
	check("Pickup feed sits above the jump button on touch screens", feedLift <= -150, feedLift)
	local shard = nearestAvailable(player, { "EmberShard" })
	walkAndUse(player, shard)
	check("Collecting still works", player:GetAttribute("EmberShards") == 1)
	Engine.removePlayer(player)
	task.wait(0.5)
	check("Nothing was written to a DataStore", next(Engine.stores[STORE] or {}) == nil)
	textScan()
end

-- ── Run ──────────────────────────────────────────────────

if MODE == "studio" then
	Engine.isStudio = true
	Engine.storeFailure = "403: StudioAccessToApisNotAllowed"
else
	Engine.stores[STORE] = {
		u_2002 = serde.encode("json", legacy),
		u_4004 = serde.encode("json", { coins = 9, _lock = { jobId = "crashed-server", time = T0 - 10000 } }),
	}
end

Engine.boot(process.args[3] or "EmberHatch.rbxlx")
game = Engine.game
CollectionService = game:GetService("CollectionService")
PPS = game:GetService("ProximityPromptService")
if MODE == "studio" then
	Engine.setRaw(game:GetService("UserInputService"), "TouchEnabled", true)
end
local prebuiltShards = #CollectionService:GetTagged("EmberShard")
local prebuilt = Engine.workspace:FindFirstChild("EmberHollow") ~= nil
	and Engine.workspace:FindFirstChild("SunkenGrove") ~= nil
	and prebuiltShards == 28
Engine.runServerScripts()
table.insert(results, 1, {
	section = "World",
	name = "The place file already holds the whole world (opens complete in Studio)",
	ok = prebuilt,
	detail = prebuiltShards .. " shards before any script ran",
})

Engine.play(if MODE == "studio" then studioRun else liveRun)

section = "Script health"
check("No script errors during the whole session", #Engine.errors == 0, Engine.errors[1])

-- ── Report ───────────────────────────────────────────────

local passed, failed = 0, 0
local lines = { ("## %s run"):format(if MODE == "studio" then "Studio (API access off, phone)" else "Live server"), "" }
local current
for _, r in ipairs(results) do
	if r.section ~= current then
		current = r.section
		table.insert(lines, "")
		table.insert(lines, "**" .. current .. "**")
		table.insert(lines, "")
	end
	if r.ok then
		passed += 1
	else
		failed += 1
	end
	local detail = if r.detail ~= nil then " — " .. tostring(r.detail):gsub("\n.*", "") else ""
	table.insert(lines, ("- %s %s%s"):format(if r.ok then "✅" else "❌", r.name, detail))
end
if #metrics > 0 then
	table.insert(lines, "")
	table.insert(lines, "**Numbers**")
	table.insert(lines, "")
	for _, m in ipairs(metrics) do
		table.insert(lines, ("- %s: %s"):format(m.name, tostring(m.value)))
	end
end
if #Engine.warnings > 0 then
	table.insert(lines, "")
	table.insert(lines, "**Warnings printed by the game**")
	table.insert(lines, "")
	for _, w in ipairs(Engine.warnings) do
		table.insert(lines, "- `" .. w:gsub("\n", " ") .. "`")
	end
end
if #Engine.errors > 0 then
	table.insert(lines, "")
	table.insert(lines, "**Script errors**")
	table.insert(lines, "")
	for _, e in ipairs(Engine.errors) do
		table.insert(lines, "```")
		table.insert(lines, e)
		table.insert(lines, "```")
	end
end
table.insert(lines, 2, ("%d passed, %d failed, %.0f minutes of play simulated."):format(passed, failed, Engine.now() / 60))

fs.writeDir("playtest/out")
fs.writeFile(("playtest/out/report-%s.md"):format(MODE), table.concat(lines, "\n") .. "\n")

-- World snapshot for the map.
local parts = {}
for _, inst in ipairs(Engine.workspace:GetDescendants()) do
	if inst:IsA("BasePart") and inst.Transparency < 1 and inst.Size.X * inst.Size.Z > 0.5 then
		local cf, s = inst.CFrame, inst.Size
		local top = -math.huge
		for _, c in ipairs({ { -1, -1, -1 }, { 1, 1, 1 }, { -1, 1, 1 }, { 1, -1, 1 }, { 1, 1, -1 }, { -1, -1, 1 }, { 1, -1, -1 }, { -1, 1, -1 } }) do
			top = math.max(top, (cf * Vector3.new(c[1] * s.X / 2, c[2] * s.Y / 2, c[3] * s.Z / 2)).Y)
		end
		local entry = { name = inst.Name, y = top, color = inst.Color:ToHex(), x = cf.Position.X, z = cf.Position.Z }
		local shape = if inst:IsA("Part") then inst.Shape.Name else "Block"
		if shape == "Ball" then
			entry.radius = math.min(s.X, s.Y, s.Z) / 2
		elseif shape == "Cylinder" and math.abs(cf.RightVector.Y) > 0.9 then
			entry.radius = math.min(s.Y, s.Z) / 2 -- upright cylinder: round footprint
		else
			entry.corners = {}
			for _, c in ipairs({ { -1, -1, -1 }, { 1, -1, -1 }, { 1, 1, -1 }, { -1, 1, -1 }, { -1, -1, 1 }, { 1, -1, 1 }, { 1, 1, 1 }, { -1, 1, 1 } }) do
				local p = cf * Vector3.new(c[1] * s.X / 2, c[2] * s.Y / 2, c[3] * s.Z / 2)
				table.insert(entry.corners, { p.X, p.Z })
			end
		end
		table.insert(parts, entry)
	end
end
local markers = {}
for _, tag in ipairs({ "EmberShard", "CrystalPod", "Portal", "StarterEgg" }) do
	for _, inst in ipairs(CollectionService:GetTagged(tag)) do
		local p = if inst:IsA("ProximityPrompt") then inst.Parent.Position else positionOf(inst)
		table.insert(markers, { tag = tag, x = p.X, z = p.Z, rare = inst:GetAttribute("Rare") == true, label = if inst:IsA("ProximityPrompt") then inst:GetAttribute("Portal") else nil })
	end
end
fs.writeFile(("playtest/out/world-%s.json"):format(MODE), serde.encode("json", { parts = parts, markers = markers, path = path }))

print(("%s: %d passed, %d failed"):format(MODE, passed, failed))
for _, r in ipairs(results) do
	if not r.ok then
		print("  FAIL [" .. r.section .. "] " .. r.name .. (if r.detail ~= nil then " — " .. tostring(r.detail) else ""))
	end
end
for _, e in ipairs(Engine.errors) do
	print(e)
end
process.exit(if failed == 0 then 0 else 1)
