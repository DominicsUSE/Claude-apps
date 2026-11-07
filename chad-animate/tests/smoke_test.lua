-- End-to-end smoke test against the API-checked mock engine:
-- installer (Studio command bar) -> server script + NPCs -> client animator.
local M, mock, installerSource = ...
local CFrame, Vector3 = M.CFrame, M.Vector3
local Instance, Enum = mock.Instance, mock.Enum

local results = {}
local function check(name, ok, detail)
	table.insert(results, { name = name, ok = ok and true or false, detail = detail or "" })
end

local function count(list, pred)
	local n = 0
	for _, x in ipairs(list) do
		if pred(x) then n = n + 1 end
	end
	return n
end

-- An R15 character made only through checked Instance.new / property sets.
function mock.makeCharacter(name)
	local char = Instance.new("Model")
	char.Name = name
	local parts = {}
	local function part(partName, sx, sy, sz)
		local p = Instance.new(partName == "Head" and "Part" or "MeshPart")
		p.Name = partName
		p.Size = Vector3.new(sx, sy, sz)
		p.Parent = char
		parts[partName] = p
	end
	part("HumanoidRootPart", 2, 2, 1)
	part("LowerTorso", 2, 0.4, 1)
	part("UpperTorso", 2, 1.6, 1)
	part("Head", 2, 1, 1)
	for _, s in ipairs({ "Left", "Right" }) do
		part(s .. "UpperArm", 1, 1, 1)
		part(s .. "LowerArm", 1, 0.8, 1)
		part(s .. "Hand", 1, 0.3, 1)
		part(s .. "UpperLeg", 1, 0.95, 1)
		part(s .. "LowerLeg", 1, 0.85, 1)
		part(s .. "Foot", 1, 0.3, 1)
	end
	local function joint(jointName, p0, p1, c0, c1)
		local j = Instance.new("Motor6D")
		j.Name = jointName
		j.Part0 = parts[p0]
		j.Part1 = parts[p1]
		j.C0 = c0
		j.C1 = c1
		j.Parent = parts[p1]
	end
	local P = CFrame.new
	joint("Root", "HumanoidRootPart", "LowerTorso", P(0, -1, 0), P(0, 0, 0))
	joint("Waist", "LowerTorso", "UpperTorso", P(0, 0.2, 0), P(0, -0.8, 0))
	joint("Neck", "UpperTorso", "Head", P(0, 0.8, 0), P(0, -0.5, 0))
	for _, s in ipairs({ "Left", "Right" }) do
		local x = (s == "Left") and -1 or 1
		joint(s .. "Shoulder", "UpperTorso", s .. "UpperArm", P(x, 0.6, 0), P(-x * 0.5, 0.4, 0))
		joint(s .. "Elbow", s .. "UpperArm", s .. "LowerArm", P(0, -0.45, 0), P(0, 0.35, 0))
		joint(s .. "Wrist", s .. "LowerArm", s .. "Hand", P(0, -0.4, 0), P(0, 0.1, 0))
		joint(s .. "Hip", "LowerTorso", s .. "UpperLeg", P(x * 0.5, -0.2, 0), P(0, 0.4, 0))
		joint(s .. "Knee", s .. "UpperLeg", s .. "LowerLeg", P(0, -0.45, 0), P(0, 0.4, 0))
		joint(s .. "Ankle", s .. "LowerLeg", s .. "Foot", P(0, -0.4, 0), P(0, 0, 0.2))
	end
	local humanoid = Instance.new("Humanoid")
	humanoid.RigType = Enum.HumanoidRigType.R15
	humanoid.HipHeight = 2
	humanoid.Health = 100
	humanoid.WalkSpeed = 16
	humanoid.Parent = char
	mock.setRaw(humanoid, "RootPart", parts.HumanoidRootPart)
	Instance.new("Animator").Parent = humanoid
	local animate = Instance.new("LocalScript")
	animate.Name = "Animate"
	animate.Parent = char
	return char, humanoid, parts
end

--============================================================
-- 1. Installer in a fresh Baseplate place (command bar = plugin context)
--============================================================

local game = mock.newGame()
local Workspace = game:GetService("Workspace")
local StarterPlayer = game:GetService("StarterPlayer")
local StarterCharacterScripts = StarterPlayer:FindFirstChildOfClass("StarterCharacterScripts")
local StarterPlayerScripts = StarterPlayer:FindFirstChildOfClass("StarterPlayerScripts")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local Lighting = game:GetService("Lighting")

local baseplate = Instance.new("Part")
baseplate.Name = "Baseplate"
baseplate.Parent = Workspace
Instance.new("SpawnLocation").Parent = Workspace
local legacy = Instance.new("LocalScript")
legacy.Name = "ChadAnimate"
legacy.Parent = StarterCharacterScripts

mock.context = "plugin"
local ok, err = pcall(mock.runSource, installerSource, "Installer")
check("installer runs in the command bar", ok, tostring(err))
ok, err = pcall(mock.runSource, installerSource, "Installer")
check("installer can run twice", ok, tostring(err))
mock.context = "game"

local world = Workspace:FindFirstChild("ChadWorld")
check("world built", world ~= nil)
if not world then
	results.worldObjects = 0
	results.warnings = mock.warnings
	return results
end
check("default Baseplate removed", Workspace:FindFirstChild("Baseplate") == nil)
check("exactly one spawn (ours)", count(Workspace:GetDescendants(), function(o) return o:IsA("SpawnLocation") end) == 1)
check("no duplicate scripts after a second run",
	count(StarterPlayerScripts:GetChildren(), function(o) return o.Name == "ChadAnimate" end) == 1
	and count(ServerScriptService:GetChildren(), function(o) return o.Name == "ChadWorld" end) == 1
	and count(ReplicatedStorage:GetChildren(), function(o) return o.Name == "ChadConfig" end) == 1)
check("animator installed with its modules",
	StarterPlayerScripts.ChadAnimate:IsA("LocalScript") and StarterPlayerScripts.ChadAnimate:FindFirstChild("Gait") ~= nil
	and StarterPlayerScripts.ChadAnimate:FindFirstChild("Rig") ~= nil)
check("default Animate replaced, old V4 script removed",
	StarterCharacterScripts:FindFirstChild("Animate") ~= nil and StarterCharacterScripts:FindFirstChild("ChadAnimate") == nil)
check("walk speed set from config", StarterPlayer.CharacterWalkSpeed == 12, tostring(StarterPlayer.CharacterWalkSpeed))
check("lighting set up", Lighting:FindFirstChildOfClass("Atmosphere") ~= nil and Lighting:FindFirstChildOfClass("Sky") ~= nil)

local water, seats, trusses = 0, 0, 0
for _, entry in ipairs(mock.log) do
	if entry.method == "FillBlock" and entry.args[3] == Enum.Material.Water then
		water = water + 1
	end
end
for _, o in ipairs(world:GetDescendants()) do
	if o:IsA("Seat") then seats = seats + 1 end
	if o:IsA("TrussPart") then trusses = trusses + 1 end
end
check("pool filled with terrain water", water >= 1)
check("benches have seats", seats == 4, tostring(seats))
check("climbable trusses (tower + pool)", trusses == 2, tostring(trusses))
results.worldObjects = #world:GetDescendants()

-- Footprints for the top-down map preview.
results.parts = {}
for _, o in ipairs(world:GetDescendants()) do
	if o:IsA("BasePart") then
		local props = rawget(o, "__props")
		local cf, size, color = props.CFrame, props.Size, props.Color
		if cf and size then
			local shape = props.Shape and props.Shape.Name or "Block"
			table.insert(results.parts, {
				name = o.Name, class = o.ClassName, shape = shape,
				m = { cf.m[1], cf.m[2], cf.m[3], cf.m[4], cf.m[5], cf.m[6], cf.m[7], cf.m[8], cf.m[9] },
				p = { cf.p[1], cf.p[2], cf.p[3] }, size = { size.X, size.Y, size.Z },
				color = color and { color.R, color.G, color.B } or { 0.6, 0.6, 0.6 },
			})
		end
	end
end

--============================================================
-- 2. Server script: world kept, NPCs spawned and moving
--============================================================

local server = ServerScriptService.ChadWorld
ok, err = pcall(mock.run, server)
check("server script starts", ok, tostring(err))
for _ = 1, 60 do
	mock.clock = mock.clock + 0.2
	ok, err = pcall(mock.stepThreads)
	if not ok then break end
end
check("NPC behaviours run for 12 s", ok, tostring(err))

local npcFolder = Workspace:FindFirstChild("ChadNpcs")
local npcs = npcFolder and npcFolder:GetChildren() or {}
local CollectionService = game:GetService("CollectionService")
check("7 NPCs spawned", #npcs == 7, tostring(#npcs))
check("NPCs tagged for animation", #CollectionService:GetTagged("ChadAnimate") == 7)
check("NPCs lose their default Animate", count(npcs, function(m) return m:FindFirstChild("Animate") ~= nil end) == 0)
local moves = count(mock.log, function(e) return e.method == "MoveTo" end)
check("NPCs are given MoveTo targets", moves > 50, tostring(moves))
local bea = npcFolder and npcFolder:FindFirstChild("Bench Bea")
check("Bench Bea sits down", bea ~= nil and bea.Humanoid.Sit == true)
local sol = npcFolder and npcFolder:FindFirstChild("Sprinter Sol")
check("Sprinter Sol switches to running", sol ~= nil and sol.Humanoid.WalkSpeed == 24,
	sol and tostring(sol.Humanoid.WalkSpeed))

--============================================================
-- 3. Client animator: local player + tagged NPC
--============================================================

local Players = game:GetService("Players")
local player = mock.newRaw("Player")
mock.setRaw(player, "Name", "Tester")
local char, humanoid, parts = mock.makeCharacter("Tester")
char.Parent = Workspace
mock.setRaw(player, "Character", char)
mock.setRaw(Players, "LocalPlayer", player)
mock.players = { player }

local client = StarterPlayerScripts.ChadAnimate
ok, err = pcall(mock.run, client)
check("client script starts", ok, tostring(err))
pcall(mock.stepThreads)

local RunService = game:GetService("RunService")
local root = parts.HumanoidRootPart
local function frame(state, velocity)
	mock.setRaw(humanoid, "__state", state)
	root.AssemblyLinearVelocity = velocity
	mock.clock = mock.clock + 1 / 60
	RunService.PreSimulation:Fire(1 / 60)
end

local knee = parts.LeftLowerLeg:FindFirstChild("LeftKnee")
local errors = 0
local minKnee = 0
local S = Enum.HumanoidStateType
local script = {
	{ S.Running, Vector3.new(0, 0, 0), 60 },
	{ S.Running, Vector3.new(0, 0, -12), 90 },
	{ S.Jumping, Vector3.new(0, 50, -12), 5 },
	{ S.Freefall, Vector3.new(0, -40, -12), 30 },
	{ S.Running, Vector3.new(0, 0, -12), 30 },
	{ S.Climbing, Vector3.new(0, 8, 0), 40 },
	{ S.Swimming, Vector3.new(0, 0, -10), 40 },
	{ S.Running, Vector3.new(0, 0, 0), 20 },
}
ok, err = pcall(function()
	for _, step in ipairs(script) do
		for _ = 1, step[3] do
			frame(step[1], step[2])
			local t = knee.Transform
			minKnee = math.min(minKnee, math.atan2(t.m[8], t.m[9]))
		end
		mock.stepThreads()
	end
end)
check("client animates through idle/walk/jump/fall/climb/swim", ok, tostring(err))
check("knee joint is being driven", minKnee < -0.3, string.format("%.3f", minKnee))
check("default Animate disabled on the local character", char.Animate.Enabled == false)
check("walk speed eased to config walk speed", math.abs(humanoid.WalkSpeed - 12) < 0.5, tostring(humanoid.WalkSpeed))

-- Hold Shift: WalkSpeed should climb toward the run speed.
local sprint = mock.actions and mock.actions.ChadAnimateSprint
local shift = { KeyCode = Enum.KeyCode.LeftShift, UserInputType = Enum.UserInputType.Keyboard }
if sprint then
	sprint("ChadAnimateSprint", Enum.UserInputState.Begin, shift)
	for _ = 1, 90 do
		frame(S.Running, Vector3.new(0, 0, -20))
	end
end
check("holding Shift raises WalkSpeed toward run speed", sprint ~= nil and humanoid.WalkSpeed > 22, tostring(humanoid.WalkSpeed))
if sprint then
	sprint("ChadAnimateSprint", Enum.UserInputState.End, shift)
end

local npcKnee = npcs[1] and npcs[1]:FindFirstChild("LeftLowerLeg") and npcs[1].LeftLowerLeg:FindFirstChild("LeftKnee")
check("NPC joints animated on the client", npcKnee ~= nil and npcKnee.Transform ~= nil
	and math.abs(npcKnee.Transform.m[9] - 1) > 1e-4)

results.warnings = mock.warnings
return results
