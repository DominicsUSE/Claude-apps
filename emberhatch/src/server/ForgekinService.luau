-- ForgekinService: the starter egg in the Nursery and the Forgekin that follows you.
-- Uses ReplicatedStorage.Assets.Forgekin.<Name> if that model exists,
-- otherwise a simple stone-and-brass placeholder.

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Theme = require(ReplicatedStorage.Shared.Theme)
local DataService = require(script.Parent.DataService)
local QuestService = require(script.Parent.QuestService)

local STARTER_FORGEKIN = "Stoneback"
local FOLLOW_OFFSET = CFrame.new(2.8, 0, 3.2) -- behind and to the right of the player

local ForgekinService = {}

local remotes
local followers = {} -- [Player] = { model = Model, phase = number }
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

local function buildModel(id)
	local assets = ReplicatedStorage:FindFirstChild("Assets")
	local folder = assets and assets:FindFirstChild("Forgekin")
	local prefab = folder and folder:FindFirstChild(id)
	local model = if prefab and prefab:IsA("Model") then prefab:Clone() else makePlaceholder(id)
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

local function removeFollower(player)
	local follower = followers[player]
	if follower then
		follower.model:Destroy()
		followers[player] = nil
	end
end

local function spawnFollower(player)
	removeFollower(player)
	local profile = DataService.Get(player)
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not profile or profile.activeForgekin == "" or not root then
		return
	end
	local model = buildModel(profile.activeForgekin)
	if not model.PrimaryPart then
		model:Destroy()
		return
	end
	model.Name = player.Name .. "_Forgekin"
	model:PivotTo(root.CFrame * FOLLOW_OFFSET)
	model.Parent = workspace
	followers[player] = { model = model, phase = math.random() * math.pi * 2 }
end

-- chisle: server-side follow is simplest; move it to the client if many players lag.
local function updateFollowers(dt)
	local alpha = 1 - math.exp(-dt * 6)
	local t = os.clock()
	for player, follower in pairs(followers) do
		local character = player.Character
		local root = character and character:FindFirstChild("HumanoidRootPart")
		if root then
			local bob = math.sin(t * 3 + follower.phase) * 0.25
			local goal = root.CFrame * FOLLOW_OFFSET * CFrame.new(0, bob - 1, 0)
			follower.model:PivotTo(follower.model:GetPivot():Lerp(goal, alpha))
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
	if #profile.forgekin > 0 then
		remotes.Notify:FireClient(player, "You already hatched your starter Forgekin.", "info")
		return
	end

	hatching[player] = true
	table.insert(profile.forgekin, { id = STARTER_FORGEKIN })
	profile.stats.hatched += 1
	DataService.SetActiveForgekin(player, STARTER_FORGEKIN)

	local display = pedestal.Parent:FindFirstChild("StarterEggDisplay")
	remotes.EggHatched:FireClient(player, display or pedestal, STARTER_FORGEKIN)
	QuestService.Progress(player, "ForgekinHatched", 1)

	task.delay(1.3, function() -- let the egg wobble and burst first
		hatching[player] = nil
		if player.Parent then
			spawnFollower(player)
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
			spawnFollower(player)
		end)
	end
	Players.PlayerAdded:Connect(watchCharacter)
	for _, player in ipairs(Players:GetPlayers()) do
		watchCharacter(player)
	end

	DataService.OnLoaded(function(player)
		if player.Character then
			spawnFollower(player)
		end
	end)

	Players.PlayerRemoving:Connect(function(player)
		removeFollower(player)
		hatching[player] = nil
	end)

	RunService.Heartbeat:Connect(updateFollowers)
end

return ForgekinService
