-- EMBERHATCH client entry point: HUD, collection effects, portal gate styling.

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local HUD = require(script.Parent.HUD)
local CollectVFX = require(script.Parent.CollectVFX)

local player = Players.LocalPlayer
local remotes = ReplicatedStorage:WaitForChild("Remotes")

HUD.Build()
CollectVFX.Init(HUD)
HUD.TitleCard()

remotes.Notify.OnClientEvent:Connect(HUD.Toast)
remotes.PortalFlash.OnClientEvent:Connect(HUD.Flash)
remotes.ResourceCollected.OnClientEvent:Connect(CollectVFX.Collect)
remotes.PodBroken.OnClientEvent:Connect(CollectVFX.PodBurst)
remotes.EggHatched.OnClientEvent:Connect(CollectVFX.Hatch)

-- Portal gates look open or locked for *this* player's level.
-- Only the look changes here; the server still checks the level on use.
local function styleGate(prompt)
	local unlockLevel = prompt:GetAttribute("UnlockLevel")
	if not unlockLevel then
		return
	end
	local open = (player:GetAttribute("Level") or 1) >= unlockLevel
	prompt.ActionText = if open then "Enter" else ("Locked · Lv %d"):format(unlockLevel)
	local surface = prompt.Parent and prompt.Parent.Parent and prompt.Parent.Parent:FindFirstChild("Surface")
	if surface then
		surface.Transparency = if open then 0.3 else 0.8
		local light = surface:FindFirstChildOfClass("PointLight")
		if light then
			light.Brightness = if open then 2 else 0.4
		end
	end
end

local function styleAllGates()
	for _, prompt in ipairs(CollectionService:GetTagged("Portal")) do
		styleGate(prompt)
	end
end
CollectionService:GetInstanceAddedSignal("Portal"):Connect(styleGate)
player:GetAttributeChangedSignal("Level"):Connect(styleAllGates)
styleAllGates()
