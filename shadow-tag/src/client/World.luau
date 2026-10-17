--!strict
-- Client-side atmosphere: per-zone darkness, fluorescent flicker, Shadow
-- night vision, flashlight tells and noise pings for Shadows, the departure
-- board and the crouch camera. Purely visual; no gameplay authority.

local CollectionService = game:GetService("CollectionService")
local Lighting = game:GetService("Lighting")
local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")
local Workspace = game:GetService("Workspace")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Config = require(Shared.Config)
local Net = require(Shared.Net)
local Zones = require(Shared.Zones)

local player = Players.LocalPlayer
local state = Net.state()

local AMBIENT = {
	Lobby = Color3.fromRGB(95, 95, 102),
	Lit = Color3.fromRGB(56, 56, 64),
	Dark = Color3.fromRGB(7, 7, 10),
	ShadowLit = Color3.fromRGB(72, 76, 92),
	ShadowDark = Color3.fromRGB(42, 46, 62),
}
local ZONE_TEXT = { On = "POWER ON", Off = "NO POWER", Restored = "EMERGENCY POWER" }
local ZONE_COLOR = {
	On = Color3.fromRGB(235, 238, 245),
	Off = Color3.fromRGB(255, 70, 60),
	Restored = Color3.fromRGB(255, 190, 40),
}

local World = {}

local function zoneState(zone: string?): string
	return if zone then state:GetAttribute("Zone_" .. zone) or "On" else "On"
end

local function root(): BasePart?
	local character = player.Character
	return character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
end

local function marker(adornee: Instance, label: string, color: Color3): BillboardGui
	local gui = Instance.new("BillboardGui")
	gui.Adornee = adornee
	gui.AlwaysOnTop = true
	gui.Size = UDim2.fromOffset(70, 26)
	gui.LightInfluence = 0
	local text = Instance.new("TextLabel")
	text.Size = UDim2.fromScale(1, 1)
	text.BackgroundTransparency = 1
	text.Font = Enum.Font.GothamBlack
	text.TextScaled = true
	text.TextColor3 = color
	text.TextStrokeTransparency = 0.3
	text.Text = label
	text.Parent = gui
	gui.Parent = player:WaitForChild("PlayerGui")
	return gui
end

local function updateBoard()
	local phase = state:GetAttribute("Phase")
	local t = state:GetAttribute("TimeLeft") or 0
	local status = if phase == "Results"
		then "DEPARTED"
		elseif phase == "Round" and state:GetAttribute("TrainOpen") then "NOW BOARDING"
		elseif phase == "Round" then "ARRIVING"
		elseif phase == "Hiding" then "DELAYED"
		else "NOT IN SERVICE"
	local time = if phase == "Round" then string.format("DEPARTS  %d:%02d", t // 60, t % 60) else "DEPARTS  --:--"
	for _, board in CollectionService:GetTagged("DepartureBoard") do
		for _, gui in board:GetChildren() do
			if gui:IsA("SurfaceGui") then
				(gui:FindFirstChild("Time") :: TextLabel).Text = time;
				(gui:FindFirstChild("Status") :: TextLabel).Text = status
			end
		end
	end
end

function World.init(setZone: (string, Color3) -> ())
	local air = Lighting:WaitForChild("StationAir") :: Atmosphere
	local vision = Instance.new("ColorCorrectionEffect")
	vision.Name = "NightVision"
	vision.TintColor = Color3.fromRGB(170, 190, 255)
	vision.Saturation = -0.5
	vision.Brightness = 0.05
	vision.Enabled = false
	vision.Parent = Lighting
	local consume = Instance.new("ColorCorrectionEffect")
	consume.Name = "ConsumeFlash"
	consume.Parent = Lighting

	-- Zone darkness and night vision.
	local currentZone: string? = nil
	local lastAmbient: Color3? = nil
	task.spawn(function()
		while true do
			local r = root()
			local zone = r and Zones.at(r.Position)
			if zone then
				currentZone = zone
			end
			local phase = state:GetAttribute("Phase")
			local shadow = player:GetAttribute("Role") == "Shadow"
			local zs = zoneState(currentZone)
			local dark = zs == "Off"
			local ambient = if phase == "Lobby" or phase == "Results"
				then AMBIENT.Lobby
				elseif shadow then (if dark then AMBIENT.ShadowDark else AMBIENT.ShadowLit)
				else (if dark then AMBIENT.Dark else AMBIENT.Lit)
			if ambient ~= lastAmbient then
				lastAmbient = ambient
				local info = TweenInfo.new(1.2)
				TweenService:Create(Lighting, info, { Ambient = ambient }):Play()
				TweenService:Create(air, info, { Density = if dark and not shadow then 0.52 else 0.38 }):Play()
			end
			vision.Enabled = shadow
			if currentZone then
				setZone(string.upper(Zones.ById[currentZone].name) .. "   -   " .. ZONE_TEXT[zs], ZONE_COLOR[zs])
			end
			task.wait(0.25)
		end
	end)

	-- Fluorescent flicker and dying flashlight batteries (Brightness and
	-- Transparency are never written by the server, so local edits are safe).
	local flickering: { BasePart } = {}
	for _, fixture in CollectionService:GetTagged("LightFixture") do
		if fixture:GetAttribute("Flicker") then
			table.insert(flickering, fixture)
		end
	end
	task.spawn(function()
		while true do
			for _, fixture in flickering do
				local light = fixture:FindFirstChildOfClass("SurfaceLight")
				if light and zoneState(fixture:GetAttribute("Zone")) ~= "Off" and math.random() < 0.05 then
					light.Brightness = 0.15
					fixture.Transparency = 0.7
					task.delay(math.random() * 0.2 + 0.04, function()
						light.Brightness = 1.25
						fixture.Transparency = 0
					end)
				end
			end
			for _, other in Players:GetPlayers() do
				local flashlight = other.Character and other.Character:FindFirstChild("Flashlight")
				local spot = flashlight and flashlight:FindFirstChildOfClass("SpotLight")
				if spot then
					local low = (other:GetAttribute("Battery") or 100) < Config.BatteryFlickerBelow
					spot.Brightness = if low and math.random() < 0.35 then 0.4 else Config.FlashlightBrightness
				end
			end
			task.wait(0.1)
		end
	end)

	-- Own flashlight casts shadows (local only, keeps others cheap); crouch camera.
	local function onCharacter(character: Model)
		character.ChildAdded:Connect(function(child)
			if child.Name == "Flashlight" then
				local spot = child:WaitForChild("SpotLight", 5) :: SpotLight?
				if spot then
					spot.Shadows = true
				end
			end
		end)
	end
	player.CharacterAdded:Connect(onCharacter)
	if player.Character then
		onCharacter(player.Character)
	end
	player:GetAttributeChangedSignal("Crouching"):Connect(function()
		local humanoid = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
		if humanoid then
			local offset = if player:GetAttribute("Crouching") then Vector3.new(0, -1.6, 0) else Vector3.zero
			TweenService:Create(humanoid, TweenInfo.new(0.25), { CameraOffset = offset }):Play()
		end
	end)
	player:GetAttributeChangedSignal("Role"):Connect(function()
		if player:GetAttribute("Role") == "Transforming" then
			consume.Brightness = -0.6
			consume.Saturation = -1
			TweenService:Create(consume, TweenInfo.new(2.2), { Brightness = 0, Saturation = 0 }):Play()
		end
	end)

	-- Shadows see a faint tell on survivors whose flashlight is on.
	local tells: { [Player]: BillboardGui } = {}
	task.spawn(function()
		while true do
			local me = root()
			local hunting = player:GetAttribute("Role") == "Shadow"
			for _, other in Players:GetPlayers() do
				local otherRoot = other.Character and other.Character:FindFirstChild("HumanoidRootPart")
				local show = hunting
					and other ~= player
					and me ~= nil
					and otherRoot ~= nil
					and other:GetAttribute("Role") == "Survivor"
					and other:GetAttribute("FlashlightOn") == true
					and ((otherRoot :: BasePart).Position - (me :: BasePart).Position).Magnitude <= Config.ShadowSeesFlashlightsWithin
				local tell = tells[other]
				if show and (not tell or tell.Adornee ~= otherRoot) then
					if tell then
						tell:Destroy()
					end
					tells[other] = marker(otherRoot :: Instance, "◉", Color3.fromRGB(255, 235, 160))
				elseif not show and tell then
					tell:Destroy()
					tells[other] = nil
				end
			end
			task.wait(0.25)
		end
	end)

	Net.event("Noise").OnClientEvent:Connect(function(position: Vector3)
		local attachment = Instance.new("Attachment")
		attachment.WorldPosition = position
		attachment.Parent = Workspace.Terrain
		local gui = marker(attachment, "NOISE", Color3.fromRGB(255, 80, 60))
		task.delay(Config.NoisePingDuration, function()
			gui:Destroy()
			attachment:Destroy()
		end)
	end)

	state.AttributeChanged:Connect(updateBoard)
	updateBoard()
end

return World
