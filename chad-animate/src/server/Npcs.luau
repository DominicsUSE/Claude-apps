--[[
	Npcs (ModuleScript, child of the ChadWorld Script)

	Spawns demo characters that show off each animation. The server only
	moves them; every client animates them because they carry the
	ChadConfig.NPC_TAG tag.
]]

local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")
local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(ReplicatedStorage:WaitForChild("ChadConfig"))
local World = require(script.Parent:WaitForChild("World"))

local Npcs = {}

local function rgb(r, g, b)
	return Color3.fromRGB(r, g, b)
end

local ROSTER = {
	{ name = "Stroller Sam", mode = "track", speeds = { 6 }, lane = -4, start = 0, skin = rgb(234, 184, 146), shirt = rgb(70, 130, 180), legs = rgb(60, 60, 70) },
	{ name = "Walker Wren", mode = "track", speeds = { 12 }, lane = 0, start = 60, skin = rgb(160, 110, 80), shirt = rgb(200, 90, 90), legs = rgb(40, 50, 80) },
	{ name = "Sprinter Sol", mode = "track", speeds = { 12, 24 }, lane = 4, start = 180, skin = rgb(110, 75, 55), shirt = rgb(242, 178, 52), legs = rgb(30, 30, 36) },
	{ name = "Bench Bea", mode = "sit", skin = rgb(250, 210, 170), shirt = rgb(120, 180, 120), legs = rgb(90, 70, 60) },
	{ name = "Hopper Hal", mode = "hop", skin = rgb(205, 150, 110), shirt = rgb(150, 100, 200), legs = rgb(50, 50, 50) },
	{ name = "Swimmer Sky", mode = "swim", skin = rgb(240, 196, 160), shirt = rgb(40, 170, 200), legs = rgb(40, 170, 200) },
	{ name = "Climber Cam", mode = "climb", skin = rgb(140, 95, 70), shirt = rgb(230, 120, 40), legs = rgb(70, 60, 50) },
}

local function flat(v)
	return Vector3.new(v.X, 0, v.Z)
end

local function spawnNpc(spec, position, parent)
	local description = Instance.new("HumanoidDescription")
	description.HeadColor = spec.skin
	description.LeftArmColor = spec.skin
	description.RightArmColor = spec.skin
	description.TorsoColor = spec.shirt
	description.LeftLegColor = spec.legs
	description.RightLegColor = spec.legs

	local ok, model = pcall(function()
		return Players:CreateHumanoidModelFromDescriptionAsync(description, Enum.HumanoidRigType.R15)
	end)
	if not ok or not model then
		warn("ChadWorld: could not create NPC " .. spec.name .. ": " .. tostring(model))
		return nil
	end

	model.Name = spec.name
	local animate = model:FindFirstChild("Animate")
	if animate then
		animate:Destroy()
	end
	local humanoid = model:FindFirstChildOfClass("Humanoid")
	humanoid.DisplayName = spec.name
	model:PivotTo(CFrame.new(position + Vector3.new(0, 3, 0)))
	CollectionService:AddTag(model, Config.NPC_TAG)
	model.Parent = parent

	local root = humanoid.RootPart
	if root then
		-- Keep physics on the server so MoveTo stays smooth near players.
		pcall(function()
			root:SetNetworkOwner(nil)
		end)
	end
	return model, humanoid
end

local function alive(model, humanoid)
	return model.Parent ~= nil and humanoid.Parent == model and humanoid.Health > 0
end

-- Walk to `target`; returns when close (in XZ and height) or after `timeout`.
local function walkTo(model, humanoid, target, timeout)
	local root = humanoid.RootPart
	local started = os.clock()
	while alive(model, humanoid) and os.clock() - started < timeout do
		humanoid:MoveTo(target)
		local position = root.Position
		if (flat(position) - flat(target)).Magnitude < 2.5 and math.abs(position.Y - target.Y) < 4 then
			return true
		end
		task.wait(0.2)
	end
	return false
end

local BEHAVIORS = {}

function BEHAVIORS.track(model, humanoid, spec)
	local root = humanoid.RootPart
	local distance = spec.start
	local speedIndex = 1
	local switchAt = os.clock() + 7
	humanoid.WalkSpeed = spec.speeds[1]
	while alive(model, humanoid) do
		-- Keep aiming a little ahead so the NPC never stops at a waypoint.
		while (flat(World.trackPoint(distance, spec.lane)) - flat(root.Position)).Magnitude < 8 do
			distance = distance + 2
		end
		humanoid:MoveTo(World.trackPoint(distance, spec.lane))
		if #spec.speeds > 1 and os.clock() > switchAt then
			speedIndex = speedIndex % #spec.speeds + 1
			humanoid.WalkSpeed = spec.speeds[speedIndex]
			switchAt = os.clock() + 7
		end
		task.wait(0.15)
	end
end

function BEHAVIORS.sit(model, humanoid)
	local benches = Workspace:FindFirstChild(World.FOLDER_NAME)
	benches = benches and benches:FindFirstChild("Benches")
	local seat = nil
	if benches then
		for _, bench in ipairs(benches:GetChildren()) do
			local s = bench:FindFirstChildOfClass("Seat")
			if s and not s.Occupant then
				seat = s
				break
			end
		end
	end
	while alive(model, humanoid) do
		if seat and not humanoid.Sit then
			seat:Sit(humanoid)
		end
		task.wait(2)
	end
end

function BEHAVIORS.hop(model, humanoid)
	local p = World.PARKOUR
	local spots = { Vector3.new(p.X - 12, 0, p.Z), Vector3.new(p.X - 22, 0, p.Z) }
	local i = 1
	humanoid.WalkSpeed = 10
	while alive(model, humanoid) do
		walkTo(model, humanoid, spots[i], 6)
		for _ = 1, 3 do
			humanoid.Jump = true
			task.wait(1.2)
		end
		i = i % #spots + 1
	end
end

function BEHAVIORS.swim(model, humanoid)
	local p = World.POOL
	local x = (p.MIN_X + p.MAX_X) / 2 - 6
	local ends = { Vector3.new(x, -1, p.MIN_Z + 5), Vector3.new(x, -1, p.MAX_Z - 5) }
	local i = 1
	humanoid.WalkSpeed = 12
	while alive(model, humanoid) do
		walkTo(model, humanoid, ends[i], 12)
		i = i % #ends + 1
	end
end

function BEHAVIORS.climb(model, humanoid)
	local t = World.TOWER
	local x0 = t.X - 6
	humanoid.WalkSpeed = 12
	while alive(model, humanoid) do
		walkTo(model, humanoid, Vector3.new(x0 - 6, 0, t.Z - 3), 10) -- line up with the truss
		walkTo(model, humanoid, Vector3.new(x0 + 3, t.HEIGHT, t.Z - 3), 14) -- climb onto the top
		walkTo(model, humanoid, Vector3.new(x0 + 22, 0, t.Z), 10) -- off the far edge onto the sand
		task.wait(1.5)
		-- Walk back around the south side, not under the tower into the truss.
		walkTo(model, humanoid, Vector3.new(x0 + 22, 0, t.Z + 12), 6)
		walkTo(model, humanoid, Vector3.new(x0 - 6, 0, t.Z + 12), 10)
	end
end

local SPAWN_POINTS = {
	track = function(spec)
		return World.trackPoint(spec.start, spec.lane)
	end,
	sit = function()
		return Vector3.new(10, 0, 10)
	end,
	hop = function()
		return Vector3.new(World.PARKOUR.X - 12, 0, World.PARKOUR.Z)
	end,
	swim = function()
		local p = World.POOL
		return Vector3.new((p.MIN_X + p.MAX_X) / 2 - 6, 0, 0)
	end,
	climb = function()
		return Vector3.new(World.TOWER.X - 12, 0, World.TOWER.Z - 3)
	end,
}

function Npcs.start()
	local parent = Workspace:FindFirstChild("ChadNpcs")
	if parent then
		parent:Destroy()
	end
	parent = Instance.new("Folder")
	parent.Name = "ChadNpcs"
	parent.Parent = Workspace

	for _, spec in ipairs(ROSTER) do
		task.spawn(function()
			-- Respawn if the NPC is ever lost (fell out of the world, reset...).
			while true do
				local model, humanoid = spawnNpc(spec, SPAWN_POINTS[spec.mode](spec), parent)
				if model then
					local ok, err = pcall(BEHAVIORS[spec.mode], model, humanoid, spec)
					if not ok then
						warn("ChadWorld: NPC " .. spec.name .. " stopped: " .. tostring(err))
					end
					model:Destroy()
				end
				task.wait(5)
			end
		end)
	end
end

return Npcs
