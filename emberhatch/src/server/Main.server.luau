-- EMBERHATCH server entry point. Builds the world, creates remotes, starts services.

local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

-- Server → client only. Clients never send gameplay requests: every action goes
-- through a ProximityPrompt, which the server checks itself.
local remotes = Instance.new("Folder")
remotes.Name = "Remotes"
for _, name in ipairs({ "Notify", "ResourceCollected", "PodBroken", "EggHatched", "PortalFlash" }) do
	local remote = Instance.new("RemoteEvent")
	remote.Name = name
	remote.Parent = remotes
end
remotes.Parent = ReplicatedStorage

local Server = script.Parent
local DataService = require(Server.DataService)
local QuestService = require(Server.QuestService)
local ResourceService = require(Server.ResourceService)
local ForgekinService = require(Server.ForgekinService)
local HubNPCService = require(Server.HubNPCService)
local PortalService = require(Server.PortalService)

require(Server.HubBuilder).Build()
require(Server.GroveBuilder).Build()

DataService.Init()
QuestService.Init()
ResourceService.Init()
ForgekinService.Init()
HubNPCService.Init()
PortalService.Init()

-- Hub stations that open in later milestones.
local HUB_MESSAGES = {
	ForgeStation = "The Forge Station is warming up. Recipes arrive soon.",
	EggShop = "The Egg Shop opens soon. Your starter egg waits in the Nursery.",
	QuestBoard = "Your quests are listed on the right of your screen.",
	UpgradeShop = "Upgrades arrive soon.",
}
local function hookHubPrompt(prompt)
	prompt.Triggered:Connect(function(player)
		local message = HUB_MESSAGES[prompt:GetAttribute("HubObject")]
		if message then
			remotes.Notify:FireClient(player, message, "info")
		end
	end)
end
CollectionService:GetInstanceAddedSignal("HubPrompt"):Connect(hookHubPrompt)
for _, prompt in ipairs(CollectionService:GetTagged("HubPrompt")) do
	hookHubPrompt(prompt)
end

-- Load players last, after every service has registered its callbacks.
DataService.Start()
