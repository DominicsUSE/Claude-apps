-- PortalService: gates in the Portal Plaza and the way back to the hub.
-- A prompt tagged "Portal" with a Portal attribute (zone id) teleports the player
-- once the server confirms their level. Landing spots are parts tagged
-- "ZoneEntry_<ZoneId>"; the player is placed on the ground found below them.

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local ZoneConfig = require(ReplicatedStorage.Shared.ZoneConfig)
local DataService = require(script.Parent.DataService)

local PortalService = {}

local remotes
local lastUse = {} -- [Player] = os.clock()

local function landingFor(zoneId)
	local entry = CollectionService:GetTagged("ZoneEntry_" .. zoneId)[1]
	if not entry or not entry:IsA("BasePart") then
		return nil
	end
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { entry }
	local hit = workspace:Raycast(entry.Position + Vector3.new(0, 20, 0), Vector3.new(0, -60, 0), params)
	local ground = if hit then hit.Position else entry.Position
	-- Keep the entry part's facing so players arrive looking into the area.
	return CFrame.new(ground + Vector3.new(0, 3.5, 0)) * entry.CFrame.Rotation
end

local function teleport(player, zoneId, promptPart)
	local now = os.clock()
	if now - (lastUse[player] or 0) < 1.5 then
		return
	end
	local zone = ZoneConfig.Zones[zoneId]
	local profile = DataService.Get(player)
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not zone or not profile or not root then
		return
	end
	if promptPart and (root.Position - promptPart.Position).Magnitude > 20 then
		return
	end
	lastUse[player] = now

	if profile.level < zone.unlockLevel then
		remotes.Notify:FireClient(
			player,
			("%s unlocks at level %d."):format(zone.displayName, zone.unlockLevel),
			"error"
		)
		return
	end

	local landing = landingFor(zoneId)
	if not landing then
		remotes.Notify:FireClient(player, zone.displayName .. " opens soon.", "info")
		return
	end

	remotes.PortalFlash:FireClient(player, zone.portalGlow or Color3.fromRGB(255, 214, 150), zone.displayName)
	task.wait(0.15)
	if character.Parent then
		character:PivotTo(landing)
		player:SetAttribute("Zone", zoneId)
	end
end

local function hookPortal(prompt)
	if not prompt:IsA("ProximityPrompt") then
		return
	end
	prompt.Triggered:Connect(function(player)
		local zoneId = prompt:GetAttribute("Portal")
		if type(zoneId) == "string" then
			teleport(player, zoneId, prompt.Parent:IsA("BasePart") and prompt.Parent or nil)
		end
	end)
end

function PortalService.Init()
	remotes = ReplicatedStorage.Remotes

	CollectionService:GetInstanceAddedSignal("Portal"):Connect(hookPortal)
	for _, prompt in ipairs(CollectionService:GetTagged("Portal")) do
		hookPortal(prompt)
	end

	-- Everyone (re)spawns in the hub.
	local function watch(player)
		player:SetAttribute("Zone", ZoneConfig.Hub)
		player.CharacterAdded:Connect(function()
			player:SetAttribute("Zone", ZoneConfig.Hub)
		end)
	end
	Players.PlayerAdded:Connect(watch)
	for _, player in ipairs(Players:GetPlayers()) do
		watch(player)
	end
	Players.PlayerRemoving:Connect(function(player)
		lastUse[player] = nil
	end)
end

return PortalService
