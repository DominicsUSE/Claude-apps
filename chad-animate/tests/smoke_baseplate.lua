-- Smoke test for dist/ChadBaseplate_Installer.lua: plain Baseplate place,
-- animator only, every player spawns as the gray R15 dummy.
local M, mock, installerSource = ...
local Vector3 = M.Vector3
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

-- A fresh Baseplate place.
local game = mock.newGame()
local Workspace = game:GetService("Workspace")
local StarterPlayer = game:GetService("StarterPlayer")
local StarterPlayerScripts = StarterPlayer:FindFirstChildOfClass("StarterPlayerScripts")
local StarterCharacterScripts = StarterPlayer:FindFirstChildOfClass("StarterCharacterScripts")
local ServerScriptService = game:GetService("ServerScriptService")
local Lighting = game:GetService("Lighting")

local baseplate = Instance.new("Part")
baseplate.Name = "Baseplate"
baseplate.Parent = Workspace
Instance.new("SpawnLocation").Parent = Workspace

mock.context = "plugin"
local ok, err = pcall(mock.runSource, installerSource, "Installer")
check("installer runs in the command bar", ok, tostring(err))
ok, err = pcall(mock.runSource, installerSource, "Installer")
check("installer can run twice", ok, tostring(err))
mock.context = "game"

check("Baseplate kept", Workspace:FindFirstChild("Baseplate") == baseplate)
check("exactly one spawn", count(Workspace:GetDescendants(), function(o) return o:IsA("SpawnLocation") end) == 1)
check("no world, NPCs or server script",
	Workspace:FindFirstChild("ChadWorld") == nil and Workspace:FindFirstChild("ChadNpcs") == nil
	and #ServerScriptService:GetChildren() == 0)
check("lighting untouched", #Lighting:GetChildren() == 0)
check("animator installed with its modules",
	StarterPlayerScripts:FindFirstChild("ChadAnimate") ~= nil
	and StarterPlayerScripts.ChadAnimate:FindFirstChild("Rig") ~= nil
	and StarterPlayerScripts.ChadAnimate:FindFirstChild("Gait") ~= nil
	and count(StarterPlayerScripts:GetChildren(), function(o) return o.Name == "ChadAnimate" end) == 1)
check("default Animate replaced", StarterCharacterScripts:FindFirstChild("Animate") ~= nil)
check("avatar loading off", StarterPlayer.LoadCharacterAppearance == false)
check("walk speed set from config", StarterPlayer.CharacterWalkSpeed == 12, tostring(StarterPlayer.CharacterWalkSpeed))

local dummies = count(StarterPlayer:GetChildren(), function(o) return o.Name == "StarterCharacter" end)
local dummy = StarterPlayer:FindFirstChild("StarterCharacter")
check("one StarterCharacter dummy", dummies == 1, tostring(dummies))
local humanoid = dummy and dummy:FindFirstChildOfClass("Humanoid")
check("dummy is an R15 humanoid", humanoid ~= nil and humanoid.RigType == Enum.HumanoidRigType.R15)
check("dummy root is its PrimaryPart", dummy ~= nil and dummy.PrimaryPart == dummy:FindFirstChild("HumanoidRootPart"))
check("dummy has 15 Motor6Ds",
	dummy ~= nil and count(dummy:GetDescendants(), function(o) return o:IsA("Motor6D") end) == 15)
check("dummy has a head mesh and face",
	dummy ~= nil and dummy.Head:FindFirstChildOfClass("SpecialMesh") ~= nil and dummy.Head:FindFirstChild("face") ~= nil)
check("dummy has nothing but body parts and a humanoid",
	dummy ~= nil and count(dummy:GetChildren(), function(o) return o:IsA("BasePart") end) == 16
	and #dummy:GetChildren() == 17)

-- Rest pose: soles on the floor (HRP at y = 3, HipHeight 2).
local soles = {}
for _, side in ipairs({ "Left", "Right" }) do
	local foot = dummy[side .. "Foot"]
	table.insert(soles, foot.CFrame.Y - foot.Size.Y / 2)
end
check("dummy's feet rest on the floor", math.abs(soles[1]) < 1e-6 and math.abs(soles[2]) < 1e-6,
	string.format("%.3f %.3f", soles[1], soles[2]))

-- The animator's Rig module accepts the dummy.
local Rig = mock.run(StarterPlayerScripts.ChadAnimate.Rig)
local joints = Rig.findJoints(dummy)
local rig = joints and Rig.measure(humanoid, dummy.HumanoidRootPart, joints)
check("Rig finds and measures the dummy", rig ~= nil and math.abs(rig.legLength - 1.8) < 1e-6
	and math.abs(rig.groundY + 3) < 1e-6, rig and string.format("leg %.2f floor %.2f", rig.legLength, rig.groundY))

-- Spawn as the dummy and walk, then run.
local Players = game:GetService("Players")
local player = mock.newRaw("Player")
mock.setRaw(player, "Name", "Tester")
humanoid.Health = 100
humanoid.WalkSpeed = 12
mock.setRaw(humanoid, "RootPart", dummy.HumanoidRootPart)
Instance.new("Animator").Parent = humanoid
dummy.Parent = Workspace
mock.setRaw(player, "Character", dummy)
mock.setRaw(Players, "LocalPlayer", player)
mock.players = { player }

ok, err = pcall(mock.run, StarterPlayerScripts.ChadAnimate)
check("client script starts", ok, tostring(err))
pcall(mock.stepThreads)

local RunService = game:GetService("RunService")
local root = dummy.HumanoidRootPart
local knee = dummy.LeftLowerLeg.LeftKnee
local minKnee = 0
local function frames(n, velocity)
	for _ = 1, n do
		mock.setRaw(humanoid, "__state", Enum.HumanoidStateType.Running)
		root.AssemblyLinearVelocity = velocity
		mock.clock = mock.clock + 1 / 60
		RunService.PreSimulation:Fire(1 / 60)
		local t = knee.Transform
		minKnee = math.min(minKnee, math.atan2(t.m[8], t.m[9]))
	end
end
ok, err = pcall(function()
	frames(60, Vector3.new(0, 0, 0))
	frames(90, Vector3.new(0, 0, -12))
end)
check("dummy idles and walks", ok, tostring(err))
check("dummy's knees bend while walking", minKnee < -0.3, string.format("%.3f", minKnee))

local sprint = mock.actions and mock.actions.ChadAnimateSprint
local shift = { KeyCode = Enum.KeyCode.LeftShift, UserInputType = Enum.UserInputType.Keyboard }
if sprint then
	sprint("ChadAnimateSprint", Enum.UserInputState.Begin, shift)
	ok, err = pcall(frames, 90, Vector3.new(0, 0, -22))
end
check("holding Shift runs", sprint ~= nil and ok and humanoid.WalkSpeed > 22, tostring(humanoid.WalkSpeed))

results.warnings = mock.warnings
return results
