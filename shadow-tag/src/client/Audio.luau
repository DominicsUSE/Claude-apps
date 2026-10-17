--!strict
-- Ambience and feedback sounds, all played locally: music drone, distant
-- train rumble, drips, light buzz, heartbeat near Shadows, footstep
-- loudness by stance and the tag sting.

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local SoundService = game:GetService("SoundService")
local Workspace = game:GetService("Workspace")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Config = require(Shared.Config)
local Net = require(Shared.Net)
local Sounds = require(Shared.Sounds)

local player = Players.LocalPlayer
local state = Net.state()

local Audio = {}

local function nearestShadow(from: Vector3): number
	local best = math.huge
	for _, model in CollectionService:GetTagged("ShadowCharacter") do
		local r = model:FindFirstChild("HumanoidRootPart") :: BasePart?
		if r and model ~= player.Character then
			best = math.min(best, (r.Position - from).Magnitude)
		end
	end
	return best
end

function Audio.init()
	Sounds.make("AmbientMusic", SoundService):Play()
	local rumble = Sounds.make("TrainRumble", SoundService)
	rumble:Play()

	-- Rumble swells now and then, like a train passing far away.
	task.spawn(function()
		while true do
			rumble.Volume = 0.15
			task.wait(math.random(18, 35))
			for i = 1, 30 do
				rumble.Volume = 0.15 + math.sin(i / 30 * math.pi) * 0.6
				task.wait(0.2)
			end
		end
	end)

	-- Drips from points near the camera.
	local drips = CollectionService:GetTagged("DripPoint")
	task.spawn(function()
		while true do
			task.wait(math.random() * 2.5 + 1.2)
			local camera = Workspace.CurrentCamera
			local point = drips[math.random(#drips)] :: BasePart?
			if camera and point and (point.Position - camera.CFrame.Position).Magnitude < 90 then
				Sounds.play("Drip", point)
			end
		end
	end)

	-- Buzz on flickering fixtures while their zone has power.
	for _, fixture in CollectionService:GetTagged("LightFixture") do
		if fixture:GetAttribute("Flicker") then
			local buzz = Sounds.make("LightBuzz", fixture)
			local zoneKey = "Zone_" .. fixture:GetAttribute("Zone")
			local function refresh()
				buzz.Playing = state:GetAttribute(zoneKey) ~= "Off"
			end
			state:GetAttributeChangedSignal(zoneKey):Connect(refresh)
			refresh()
		end
	end

	-- Heartbeat (lub-dub) speeds up as a Shadow closes in.
	task.spawn(function()
		while true do
			local r = player.Character and player.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
			local distance = if r and player:GetAttribute("Role") == "Survivor" then nearestShadow(r.Position) else math.huge
			if distance < Config.HeartbeatRange then
				local closeness = 1 - distance / Config.HeartbeatRange
				for _ = 1, 2 do
					local beat = Sounds.play("Heartbeat", SoundService)
					beat.Volume = 0.3 + closeness * 0.7
					task.wait(0.18)
				end
				task.wait(1.1 - closeness * 0.75)
			else
				task.wait(0.3)
			end
		end
	end)

	-- Default footsteps are quiet when walking, silent when crouched, loud when sprinting.
	task.spawn(function()
		while true do
			for _, other in Players:GetPlayers() do
				local running = other.Character and other.Character:FindFirstChild("Running", true)
				if running and running:IsA("Sound") then
					running.Volume = if other:GetAttribute("Sprinting") then 0.9 elseif other:GetAttribute("Crouching") then 0 else 0.2
				end
			end
			task.wait(0.25)
		end
	end)

	Net.event("Tagged").OnClientEvent:Connect(function()
		Sounds.play("TagSting", SoundService)
	end)
end

return Audio
