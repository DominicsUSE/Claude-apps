-- ResourceService: Ember Shard pickups and Ember Crystal Pods.
-- Anything tagged "EmberShard" (a Part) or "CrystalPod" (a Model or Part) works,
-- whether it was spawned from ResourceConfig or placed by hand in Studio.
-- The server checks every collection: the resource is up, the player is alive
-- and close, and they aren't spamming. Clients only get told what happened.

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Theme = require(ReplicatedStorage.Shared.Theme)
local HubConfig = require(ReplicatedStorage.Shared.HubConfig)
local ResourceConfig = require(ReplicatedStorage.Shared.ResourceConfig)
local DataService = require(script.Parent.DataService)
local QuestService = require(script.Parent.QuestService)

local SHARD_TAG = "EmberShard"
local POD_TAG = "CrystalPod"

local ResourceService = {}

local rng = Random.new()
local available = {} -- [Instance] = true while it can be collected
local hooked = setmetatable({}, { __mode = "k" }) -- [Instance] = true once its prompt is wired
local lastShard = {} -- [Player] = os.clock()
local lastPod = {} -- [Player] = os.clock()
local remotes
local resourceFolder

-- ── Helpers ──────────────────────────────────────────────

local function positionOf(inst)
	return if inst:IsA("Model") then inst:GetPivot().Position else inst.Position
end

-- Hides or restores every part, light, emitter and prompt in a resource.
local function setShown(inst, shown)
	local parts = if inst:IsA("BasePart") then { inst } else {}
	for _, descendant in ipairs(inst:GetDescendants()) do
		if descendant:IsA("BasePart") then
			table.insert(parts, descendant)
		elseif descendant:IsA("ParticleEmitter") or descendant:IsA("Light") or descendant:IsA("ProximityPrompt") then
			descendant.Enabled = shown
		end
	end
	for _, part in ipairs(parts) do
		if part:GetAttribute("ShownTransparency") == nil then
			part:SetAttribute("ShownTransparency", part.Transparency)
			part:SetAttribute("ShownCollide", part.CanCollide)
		end
		part.Transparency = if shown then part:GetAttribute("ShownTransparency") else 1
		part.CanCollide = shown and part:GetAttribute("ShownCollide")
	end
end

-- The player's root part if they are alive and within reach, else nil.
local function rootNear(player, position, maxDistance)
	local character = player.Character
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not humanoid or humanoid.Health <= 0 or not root then
		return nil
	end
	if (root.Position - position).Magnitude > maxDistance then
		return nil
	end
	return root
end

local function groundAt(position)
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { resourceFolder }
	local hit = workspace:Raycast(position + Vector3.new(0, 60, 0), Vector3.new(0, -120, 0), params)
	return if hit then hit.Position else position
end

-- Decides what one pod gives. Runs only on the server.
local function rollPodReward(isRare)
	local cfg = ResourceConfig.Pod
	local shards = rng:NextInteger(cfg.shardsMin, cfg.shardsMax)
	local coins = rng:NextInteger(cfg.coinsMin, cfg.coinsMax)
	local cores = 0
	if isRare and rng:NextNumber() < cfg.rareCoreChance then
		cores = rng:NextInteger(cfg.rareCoresMin, cfg.rareCoresMax)
	end
	return shards, cores, coins
end

-- ── Collection ───────────────────────────────────────────

local function onShardTriggered(shard, prompt, player)
	if not available[shard] then
		return
	end
	local now = os.clock()
	if now - (lastShard[player] or 0) < ResourceConfig.ShardCooldown then
		return
	end
	local profile = DataService.Get(player)
	local position = positionOf(shard)
	if not profile or not rootNear(player, position, prompt.MaxActivationDistance + 5) then
		return
	end

	lastShard[player] = now
	available[shard] = nil
	setShown(shard, false)

	local amount = ResourceConfig.Shard.amount
	DataService.Add(player, "emberShards", amount)
	profile.stats.shardsCollected += amount
	remotes.ResourceCollected:FireClient(player, { kind = "shard", position = position, shards = amount })
	DataService.AddXP(player, ResourceConfig.Shard.xp * amount)
	QuestService.Progress(player, "ShardCollected", amount)

	task.delay(ResourceConfig.Shard.respawnSeconds, function()
		if shard.Parent then
			available[shard] = true
			setShown(shard, true)
		end
	end)
end

local function onPodTriggered(pod, prompt, player)
	if not available[pod] then
		return
	end
	local now = os.clock()
	if now - (lastPod[player] or 0) < ResourceConfig.PodCooldown then
		return
	end
	local profile = DataService.Get(player)
	local position = positionOf(pod)
	if not profile or not rootNear(player, position, prompt.MaxActivationDistance + 5) then
		return
	end

	lastPod[player] = now
	available[pod] = nil
	setShown(pod, false)

	local rare = pod:GetAttribute("Rare") == true
	local shards, cores, coins = rollPodReward(rare)
	remotes.PodBroken:FireAllClients(position, rare)

	DataService.Add(player, "emberShards", shards)
	DataService.Add(player, "coins", coins)
	if cores > 0 then
		DataService.Add(player, "crystalCores", cores)
	end
	profile.stats.podsBroken += 1
	profile.stats.shardsCollected += shards
	profile.stats.coresFound += cores

	remotes.ResourceCollected:FireClient(player, {
		kind = "pod",
		position = position,
		shards = shards,
		cores = cores,
		coins = coins,
	})
	DataService.AddXP(player, ResourceConfig.Shard.xp * shards + ResourceConfig.Pod.xpBonus)
	QuestService.Progress(player, "PodBroken", 1)
	QuestService.Progress(player, "ShardCollected", shards)

	task.delay(rng:NextNumber(ResourceConfig.Pod.respawnMin, ResourceConfig.Pod.respawnMax), function()
		if pod.Parent then
			available[pod] = true
			setShown(pod, true)
		end
	end)
end

-- Gives a tagged resource its prompt and starts listening to it.
local function hook(inst, isPod)
	if hooked[inst] then
		return
	end
	local prompt = inst:FindFirstChildWhichIsA("ProximityPrompt", true)
	if not prompt then
		local host = if inst:IsA("Model")
			then inst.PrimaryPart or inst:FindFirstChildWhichIsA("BasePart", true)
			else inst
		if not host or not host:IsA("BasePart") then
			warn("[ResourceService] Tagged resource has no part to hold a prompt:", inst:GetFullName())
			return
		end
		prompt = Instance.new("ProximityPrompt")
		prompt.RequiresLineOfSight = false
		if isPod then
			prompt.ActionText = "Break"
			prompt.ObjectText = if inst:GetAttribute("Rare") then "Rare Crystal Pod" else "Ember Crystal Pod"
			prompt.HoldDuration = ResourceConfig.Pod.holdSeconds
			prompt.MaxActivationDistance = ResourceConfig.Pod.promptDistance
		else
			prompt.ActionText = "Collect"
			prompt.ObjectText = "Ember Shard"
			prompt.HoldDuration = 0
			prompt.MaxActivationDistance = ResourceConfig.Shard.promptDistance
		end
		prompt.Parent = host
	end

	hooked[inst] = true
	available[inst] = true
	local handler = if isPod then onPodTriggered else onShardTriggered
	prompt.Triggered:Connect(function(player)
		handler(inst, prompt, player)
	end)
end

-- ── Builders for config-placed resources ─────────────────

local function makeShard(groundPosition)
	local shard = Instance.new("Part")
	shard.Name = "EmberShard"
	shard.Size = Vector3.new(0.8, 1.6, 0.8)
	shard.CFrame = CFrame.new(groundAt(groundPosition) + Vector3.new(0, ResourceConfig.Shard.hoverHeight, 0))
		* CFrame.Angles(0, rng:NextNumber(0, math.pi * 2), math.rad(14))
	shard.Color = Theme.Color.Shard
	shard.Material = Enum.Material.Neon
	shard.Anchored = true
	shard.CanCollide = false
	shard.CanTouch = false
	shard.CanQuery = false
	shard.CastShadow = false

	local sparkle = Instance.new("ParticleEmitter")
	sparkle.Texture = "rbxasset://textures/particles/sparkles_main.dds"
	sparkle.Color = ColorSequence.new(Theme.Color.Amber)
	sparkle.LightEmission = 1
	sparkle.Rate = 3
	sparkle.Lifetime = NumberRange.new(0.6, 1)
	sparkle.Speed = NumberRange.new(0.4, 1)
	sparkle.SpreadAngle = Vector2.new(180, 180)
	sparkle.Size = NumberSequence.new({
		NumberSequenceKeypoint.new(0, 0.25),
		NumberSequenceKeypoint.new(1, 0),
	})
	sparkle.Parent = shard

	-- Spin and bob are drawn by each client (see CollectVFX).
	shard:SetAttribute("Spin", 1.6)
	shard:SetAttribute("Bob", 0.25)
	CollectionService:AddTag(shard, "Spin")
	CollectionService:AddTag(shard, SHARD_TAG)
	shard.Parent = resourceFolder
end

local CRYSTALS = {
	-- offset from the rock's top, size, tilt
	{ Vector3.new(0, 1.8, 0), Vector3.new(1.4, 3.6, 1.4), CFrame.Angles(0, 0, 0) },
	{ Vector3.new(1.1, 1.2, 0.5), Vector3.new(1, 2.6, 1), CFrame.Angles(0, 0, -0.45) },
	{ Vector3.new(-1, 1.1, -0.6), Vector3.new(1, 2.4, 1), CFrame.Angles(0.3, 0, 0.4) },
	{ Vector3.new(0.2, 0.9, 1.2), Vector3.new(0.8, 2, 0.8), CFrame.Angles(-0.5, 0, 0.1) },
}

local function makePod(groundPosition, rare)
	local model = Instance.new("Model")
	model.Name = if rare then "RareCrystalPod" else "CrystalPod"
	local ground = groundAt(groundPosition)
	local glow = if rare then Theme.Color.Core else Theme.Color.Shard

	local rock = Instance.new("Part")
	rock.Name = "Rock"
	rock.Size = Vector3.new(4.2, 1.4, 4.2)
	rock.CFrame = CFrame.new(ground + Vector3.new(0, 0.7, 0)) * CFrame.Angles(0, rng:NextNumber(0, math.pi), 0)
	rock.Color = Color3.fromRGB(62, 56, 52)
	rock.Material = Enum.Material.Slate
	rock.Anchored = true
	rock.Parent = model

	for index, crystal in ipairs(CRYSTALS) do
		local part = Instance.new("Part")
		part.Name = "Crystal" .. index
		part.Size = crystal[2]
		part.CFrame = rock.CFrame * CFrame.new(crystal[1]) * crystal[3]
		part.Color = if index == 1 then glow else glow:Lerp(Color3.new(0, 0, 0), 0.2)
		part.Material = Enum.Material.Neon
		part.Anchored = true
		part.CanCollide = index == 1
		part.CastShadow = false
		part.Parent = model
		if index == 1 then
			local light = Instance.new("PointLight")
			light.Color = glow
			light.Range = 12
			light.Brightness = 1.4
			light.Shadows = false
			light.Parent = part
		end
	end

	model.PrimaryPart = rock
	model:SetAttribute("Rare", rare)
	CollectionService:AddTag(model, POD_TAG)
	model.Parent = resourceFolder
end

local function spawnFromConfig()
	for _, position in ipairs(ResourceConfig.HubShards) do
		makeShard(position)
	end
	for _, pod in ipairs(ResourceConfig.HubPods) do
		makePod(pod.position, pod.rare == true)
	end
	local grove = HubConfig.GroveOrigin
	for _, offset in ipairs(ResourceConfig.GroveShards) do
		makeShard(grove + offset)
	end
	for _, pod in ipairs(ResourceConfig.GrovePods) do
		makePod(grove + pod.position, pod.rare == true)
	end
end

function ResourceService.Init()
	remotes = ReplicatedStorage.Remotes

	-- A saved place may already hold the resources (built in Studio or baked by tools/bake.luau).
	local prebuilt = workspace:FindFirstChild("Resources")
	resourceFolder = prebuilt or Instance.new("Folder")
	resourceFolder.Name = "Resources"
	resourceFolder.Parent = workspace

	for tag, isPod in pairs({ [SHARD_TAG] = false, [POD_TAG] = true }) do
		CollectionService:GetInstanceAddedSignal(tag):Connect(function(inst)
			hook(inst, isPod)
		end)
		CollectionService:GetInstanceRemovedSignal(tag):Connect(function(inst)
			available[inst] = nil
		end)
		for _, inst in ipairs(CollectionService:GetTagged(tag)) do
			hook(inst, isPod)
		end
	end

	if not prebuilt then
		spawnFromConfig()
	end

	Players.PlayerRemoving:Connect(function(player)
		lastShard[player] = nil
		lastPod[player] = nil
	end)
end

return ResourceService
