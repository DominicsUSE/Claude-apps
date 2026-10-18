-- ForgekinService: the starter egg in the Nursery and the Forgekin that follow you.
-- Data format matches Forgekin Milestone 1: profile.forgekin holds
-- { uid, species, rarity, level, xp }, profile.equippedForgekin holds up to 3 uids.
-- Models come from ReplicatedStorage.Assets.Forgekin.<Species> when present,
-- otherwise a simple stone-and-brass placeholder is used.

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Theme = require(ReplicatedStorage.Shared.Theme)
local DataService = require(script.Parent.DataService)
local QuestService = require(script.Parent.QuestService)

local STARTER_SPECIES = "Stoneback"
local MAX_EQUIPPED = 3

local ForgekinService = {}

local remotes
local followers = {} -- [Player] = { { model = Model, phase = number }, ... }
local hatching = {} -- [Player] = true while a hatch is playing

local function makePlaceholder(name)
	local model = Instance.new("Model")
	model.Name = name

	local body = Instance.new("Part")
	body.Name = "Body"
	body.Shape = Enum.PartType.Ball
	body.Size = Vector3.new(2.2, 2.2, 2.2)
	body.Color = Color3.fromRGB(112, 104, 96)
	body.Material = Enum.Material.Slate
	body.Parent = model

	for _, side in ipairs({ -1, 1 }) do
		local eye = Instance.new("Part")
		eye.Name = "Eye"
		eye.Shape = Enum.PartType.Ball
		eye.Size = Vector3.new(0.45, 0.45, 0.45)
		eye.Color = Theme.Color.Amber
		eye.Material = Enum.Material.Neon
		eye.CFrame = body.CFrame * CFrame.new(side * 0.45, 0.25, -0.95)
		eye.Parent = model
	end

	local plate = Instance.new("Part")
	plate.Name = "BrassPlate"
	plate.Size = Vector3.new(1.6, 0.25, 1.4)
	plate.Color = Theme.Color.Brass
	plate.Material = Enum.Material.Metal
	plate.CFrame = body.CFrame * CFrame.new(0, 1.05, 0.2)
	plate.Parent = model

	model.PrimaryPart = body
	return model
end

-- A decorative, non-colliding model of a species. Anchored; move it with PivotTo.
function ForgekinService.BuildModel(species)
	local assets = ReplicatedStorage:FindFirstChild("Assets")
	local folder = assets and assets:FindFirstChild("Forgekin")
	local prefab = folder and folder:FindFirstChild(species)
	local model = if prefab and prefab:IsA("Model") then prefab:Clone() else makePlaceholder(species)
	if not model.PrimaryPart then
		model.PrimaryPart = model:FindFirstChildWhichIsA("BasePart", true)
	end
	for _, part in ipairs(model:GetDescendants()) do
		if part:IsA("BasePart") then
			part.Anchored = true
			part.CanCollide = false
			part.CanQuery = false
			part.CanTouch = false
			part.Massless = true
		end
	end
	return model
end

local function equippedSpecies(profile)
	local list = {}
	for _, uid in ipairs(profile.equippedForgekin) do
		for _, fk in ipairs(profile.forgekin) do
			if type(fk) == "table" and fk.uid == uid and type(fk.species) == "string" then
				table.insert(list, fk.species)
				break
			end
		end
		if #list >= MAX_EQUIPPED then
			break
		end
	end
	return list
end

local function removeFollowers(player)
	for _, follower in ipairs(followers[player] or {}) do
		follower.model:Destroy()
	end
	followers[player] = nil
end

local function spawnFollowers(player)
	removeFollowers(player)
	local profile = DataService.Get(player)
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not profile or not root then
		return
	end
	local list = {}
	for _, species in ipairs(equippedSpecies(profile)) do
		local model = ForgekinService.BuildModel(species)
		if model.PrimaryPart then
			model.Name = player.Name .. "_" .. species
			model:PivotTo(root.CFrame * CFrame.new(0, 0, 3.5))
			model.Parent = workspace
			table.insert(list, { model = model, phase = math.random() * math.pi * 2 })
		else
			model:Destroy()
		end
	end
	followers[player] = list
end

-- chisle: server-side follow is simplest; move it to the client if many players lag.
local function updateFollowers(dt)
	local alpha = 1 - math.exp(-dt * 6)
	local t = os.clock()
	for player, list in pairs(followers) do
		local character = player.Character
		local root = character and character:FindFirstChild("HumanoidRootPart")
		if root then
			for i, follower in ipairs(list) do
				-- Spread out in a row behind the player.
				local bob = math.sin(t * 3 + follower.phase) * 0.25
				local goal = root.CFrame * CFrame.new((i - (#list + 1) / 2) * 2.8, bob - 1, 3.5)
				follower.model:PivotTo(follower.model:GetPivot():Lerp(goal, alpha))
			end
		end
	end
end

local function onStarterEgg(pedestal, prompt, player)
	local profile = DataService.Get(player)
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not profile or not root or hatching[player] then
		return
	end
	if (root.Position - pedestal.Position).Magnitude > prompt.MaxActivationDistance + 5 then
		return
	end
	if profile.flags.starterEggClaimed then
		remotes.Notify:FireClient(player, "You already hatched your starter Forgekin.", "info")
		return
	end

	hatching[player] = true
	local fk = {
		uid = ("%d_%d_%d"):format(player.UserId, os.time(), math.random(1000, 9999)),
		species = STARTER_SPECIES,
		rarity = "Common",
		level = 1,
		xp = 0,
	}
	table.insert(profile.forgekin, fk)
	if #profile.equippedForgekin < MAX_EQUIPPED then
		table.insert(profile.equippedForgekin, fk.uid)
	end
	profile.flags.starterEggClaimed = true
	profile.stats.hatched += 1

	local display = pedestal.Parent:FindFirstChild("StarterEggDisplay")
	remotes.EggHatched:FireClient(player, display or pedestal, STARTER_SPECIES)
	QuestService.Progress(player, "ForgekinHatched", 1)

	task.delay(1.3, function() -- let the egg wobble and burst first
		hatching[player] = nil
		if player.Parent then
			spawnFollowers(player)
		end
	end)
end

function ForgekinService.Init()
	remotes = ReplicatedStorage.Remotes

	local function hookEgg(pedestal)
		local prompt = pedestal:FindFirstChildWhichIsA("ProximityPrompt")
		if prompt then
			prompt.Triggered:Connect(function(player)
				onStarterEgg(pedestal, prompt, player)
			end)
		end
	end
	CollectionService:GetInstanceAddedSignal("StarterEgg"):Connect(hookEgg)
	for _, pedestal in ipairs(CollectionService:GetTagged("StarterEgg")) do
		hookEgg(pedestal)
	end

	local function watchCharacter(player)
		player.CharacterAdded:Connect(function(character)
			character:WaitForChild("HumanoidRootPart", 10)
			spawnFollowers(player)
		end)
	end
	Players.PlayerAdded:Connect(watchCharacter)
	for _, player in ipairs(Players:GetPlayers()) do
		watchCharacter(player)
	end

	DataService.OnLoaded(function(player)
		if player.Character then
			spawnFollowers(player)
		end
	end)

	Players.PlayerRemoving:Connect(function(player)
		removeFollowers(player)
		hatching[player] = nil
	end)

	RunService.Heartbeat:Connect(updateFollowers)
end

return ForgekinService
