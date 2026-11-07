--[[
	ChadAnimate (LocalScript in StarterPlayer > StarterPlayerScripts)
	Children: Rig (ModuleScript), Gait (ModuleScript)

	Procedural R15 animation for every character this client can see: your
	own, other players' and tagged NPCs. Each client animates everyone
	locally from replicated physics (velocity, humanoid state, seat), so
	other players see the same walk, run, jump, climb, swim and sit poses
	without any network traffic.

	Controls (your own character):
	  Hold Left/Right Shift, or gamepad L3, to run.
	  Touch devices get a RUN button.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local ContextActionService = game:GetService("ContextActionService")
local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local Config = require(ReplicatedStorage:WaitForChild("ChadConfig"))
local Rig = require(script:WaitForChild("Rig"))
local Gait = require(script:WaitForChild("Gait"))

local localPlayer = Players.LocalPlayer
local IDENTITY = CFrame.new()
local SIDES = { "Left", "Right" }
local State = Enum.HumanoidStateType

local LIMP_STATES = {
	[State.Physics] = true,
	[State.Ragdoll] = true,
	[State.FallingDown] = true,
	[State.PlatformStanding] = true,
	[State.GettingUp] = true,
	[State.Dead] = true,
}

--============================================================
-- Sprint input (local player)
-- Each held input is tracked separately, so releasing Shift doesn't
-- cancel a held L3. Typing in chat never starts a sprint.
--============================================================

local SPRINT_ACTION = "ChadAnimateSprint"
local heldInputs = {}
local sprintHeld = false

local function refreshSprint()
	sprintHeld = next(heldInputs) ~= nil
end

local function onSprint(_, inputState, inputObject)
	local id = nil
	if inputObject then
		if inputObject.KeyCode ~= Enum.KeyCode.None then
			id = inputObject.KeyCode
		else
			id = inputObject.UserInputType
		end
	end

	if inputState == Enum.UserInputState.Begin then
		if inputObject and inputObject.UserInputType == Enum.UserInputType.Keyboard
			and UserInputService:GetFocusedTextBox() then
			return Enum.ContextActionResult.Pass
		end
		if id then
			heldInputs[id] = true
		end
	elseif inputState == Enum.UserInputState.End or inputState == Enum.UserInputState.Cancel then
		if id then
			heldInputs[id] = nil
		end
	end
	refreshSprint()
	return Enum.ContextActionResult.Sink
end

ContextActionService:BindAction(
	SPRINT_ACTION,
	onSprint,
	Config.TOUCH_RUN_BUTTON,
	Enum.KeyCode.LeftShift,
	Enum.KeyCode.RightShift,
	Enum.KeyCode.ButtonL3
)
if Config.TOUCH_RUN_BUTTON then
	ContextActionService:SetTitle(SPRINT_ACTION, "RUN")
	ContextActionService:SetDescription(SPRINT_ACTION, "Hold to run")
end

UserInputService.WindowFocusReleased:Connect(function()
	table.clear(heldInputs)
	refreshSprint()
end)
UserInputService.GamepadDisconnected:Connect(function()
	heldInputs[Enum.KeyCode.ButtonL3] = nil
	refreshSprint()
end)

-- WalkSpeed eases between walk and run. Movement is client-owned physics
-- in Roblox; validate speed on the server if your game is competitive.
local currentSpeed = Config.WALK_SPEED

local function updateLocalSpeed(dt)
	local character = localPlayer.Character
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	if not humanoid or humanoid.Health <= 0 then
		return
	end
	local target = sprintHeld and Config.RUN_SPEED or Config.WALK_SPEED
	currentSpeed = currentSpeed + (target - currentSpeed) * (1 - math.exp(-Config.SPEED_CHANGE_RATE * dt))
	if math.abs(humanoid.WalkSpeed - currentSpeed) > 0.01 then
		humanoid.WalkSpeed = currentSpeed
	end
end

--============================================================
-- Character controllers
--============================================================

local controllers = {} -- [Model] = controller
local failedAt = {} -- [Model] = os.clock() of the last error, to back off
local warnedR6 = false

local function seedFor(model)
	local name = model.Name
	local sum = 0
	for i = 1, #name do
		sum = sum + string.byte(name, i) * i
	end
	return (sum % 997) / 97
end

-- Roblox's default Animate script would fight over the joints. The
-- installer replaces it with an empty "Animate"; this is the fallback.
local function stopDefaultAnimation(character, humanoid)
	for _, child in ipairs(character:GetChildren()) do
		if child.Name == "Animate" and child:IsA("BaseScript") then
			child.Enabled = false
		end
	end
	local animator = humanoid:FindFirstChildOfClass("Animator")
	if animator then
		for _, track in ipairs(animator:GetPlayingAnimationTracks()) do
			track:Stop(0)
		end
	end
end

local function release(ctrl)
	for _, joint in pairs(ctrl.joints) do
		if joint.Parent then
			joint.Transform = IDENTITY
		end
	end
end

local function isValid(ctrl)
	local model = ctrl.model
	if ctrl.humanoid.Parent ~= model or not ctrl.root:IsDescendantOf(model) then
		return false
	end
	-- Avatar loading can swap body parts and their joints after spawn.
	for _, joint in pairs(ctrl.joints) do
		if not joint:IsDescendantOf(model) then
			return false
		end
	end
	return true
end

local function createController(model)
	local humanoid = model:FindFirstChildOfClass("Humanoid")
	if not humanoid or humanoid.Health <= 0 then
		return nil
	end
	local isLocal = model == localPlayer.Character
	if humanoid.RigType ~= Enum.HumanoidRigType.R15 then
		if isLocal and not warnedR6 then
			warnedR6 = true
			warn("ChadAnimate needs R15 avatars. Set Game Settings > Avatar > Avatar Type to R15.")
		end
		return nil
	end
	local root = humanoid.RootPart
	if not root then
		return nil
	end
	local joints = Rig.findJoints(model)
	if not joints then
		return nil
	end
	local rig = Rig.measure(humanoid, root, joints)
	if not rig then
		return nil
	end

	if isLocal then
		stopDefaultAnimation(model, humanoid)
	end

	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { model }
	params.IgnoreWater = true
	params.RespectCanCollide = true

	local waterParams = RaycastParams.new()
	waterParams.FilterType = Enum.RaycastFilterType.Include
	waterParams.FilterDescendantsInstances = { Workspace.Terrain }
	waterParams.IgnoreWater = false

	return {
		model = model,
		humanoid = humanoid,
		root = root,
		joints = joints,
		rig = rig,
		isLocal = isLocal,
		mem = Gait.newMemory(seedFor(model)),
		ground = { Left = 0, Right = 0 },
		params = params,
		waterParams = waterParams,
		lastYaw = nil,
		yawRate = 0,
		active = true,
	}
end

local function wantedModels()
	local wanted = {}
	for _, player in ipairs(Players:GetPlayers()) do
		local character = player.Character
		if character and character:IsDescendantOf(Workspace) then
			wanted[character] = true
		end
	end
	for _, model in ipairs(CollectionService:GetTagged(Config.NPC_TAG)) do
		if model:IsA("Model") and model:IsDescendantOf(Workspace) then
			wanted[model] = true
		end
	end
	return wanted
end

-- Adds, refreshes and drops controllers. Runs a few times a second and
-- whenever the local character spawns; cheap, and robust to streaming,
-- avatar reloads and respawns without tracking every event.
local function refresh()
	local wanted = wantedModels()
	for model, ctrl in pairs(controllers) do
		if not wanted[model] or not isValid(ctrl) then
			release(ctrl)
			controllers[model] = nil
		end
	end
	local now = os.clock()
	for model in pairs(wanted) do
		local ctrl = controllers[model]
		if ctrl then
			ctrl.isLocal = model == localPlayer.Character
			-- Body scale can change after spawn; re-measure the legs.
			ctrl.rig = Rig.measure(ctrl.humanoid, ctrl.root, ctrl.joints) or ctrl.rig
		elseif not failedAt[model] or now - failedAt[model] > 5 then
			failedAt[model] = nil
			controllers[model] = createController(model)
		end
	end
	for model in pairs(failedAt) do
		if not wanted[model] then
			failedAt[model] = nil
		end
	end
end

--============================================================
-- Per-frame sampling
--============================================================

-- Height of the HRP above where it would stand, from a ray down.
local function groundGap(ctrl)
	local root = ctrl.root
	local standHeight = root.Size.Y * 0.5 + ctrl.humanoid.HipHeight
	local result = Workspace:Raycast(root.Position, Vector3.new(0, -(standHeight + ctrl.rig.legLength * 2), 0), ctrl.params)
	if not result then
		return math.huge
	end
	return root.Position.Y - result.Position.Y - standHeight
end

local function inWater(ctrl)
	local origin = ctrl.root.Position + Vector3.new(0, 4, 0)
	local result = Workspace:Raycast(origin, Vector3.new(0, -5, 0), ctrl.waterParams)
	return result ~= nil and result.Material == Enum.Material.Water
end

local function sampleState(ctrl, velocity)
	local humanoid = ctrl.humanoid
	if humanoid.Health <= 0 then
		return "limp"
	end
	local state = humanoid:GetState()
	if humanoid.Sit or humanoid.SeatPart ~= nil or state == State.Seated then
		return "sit"
	end
	if state == State.Swimming then
		return "swim"
	end
	if state == State.Climbing then
		return "climb"
	end
	if LIMP_STATES[state] then
		return "limp"
	end
	if ctrl.isLocal then
		if state == State.Freefall or state == State.Jumping then
			return "air"
		end
		return "ground"
	end

	-- Other characters: replicated humanoid state can lag or be missing,
	-- so check the physics directly.
	if inWater(ctrl) then
		return "swim"
	end
	local legLength = ctrl.rig.legLength
	local gap = groundGap(ctrl)
	if gap > legLength * 0.35 or (gap > legLength * 0.15 and math.abs(velocity.Y) > 8) then
		return "air"
	end
	return "ground"
end

local function probeGround(ctrl, rootCFrame, dt)
	local rig = ctrl.rig
	local L = rig.legLength
	local floorY = rootCFrame.Position.Y + rig.groundY
	local blend = 1 - math.exp(-25 * dt)
	for _, side in ipairs(SIDES) do
		local target = ctrl.mem.feet[side].target
		local origin = rootCFrame:PointToWorldSpace(Vector3.new(target.X, rig.groundY + L * 0.9, target.Z))
		local hit = Workspace:Raycast(origin, Vector3.new(0, -L * 1.6, 0), ctrl.params)
		local offset = 0
		if hit then
			offset = math.clamp(hit.Position.Y - floorY, -0.45 * L, 0.6 * L)
		end
		ctrl.ground[side] = ctrl.ground[side] + (offset - ctrl.ground[side]) * blend
	end
end

local function updateController(ctrl, dt, now, camera)
	local root = ctrl.root
	local rootCFrame = root.CFrame
	local distance = 0
	if camera then
		distance = (rootCFrame.Position - camera.CFrame.Position).Magnitude
	end
	if distance > Config.ANIMATE_DISTANCE then
		if ctrl.active then
			release(ctrl)
			ctrl.active = false
		end
		return
	end
	ctrl.active = true

	local velocity = rootCFrame:VectorToObjectSpace(root.AssemblyLinearVelocity)

	local look = rootCFrame.LookVector
	local yaw = math.atan2(-look.X, -look.Z)
	if ctrl.lastYaw then
		local delta = (yaw - ctrl.lastYaw + math.pi) % (2 * math.pi) - math.pi
		local rate = delta / math.max(dt, 1e-3)
		ctrl.yawRate = ctrl.yawRate + (rate - ctrl.yawRate) * (1 - math.exp(-12 * dt))
	end
	ctrl.lastYaw = yaw

	local state = sampleState(ctrl, velocity)

	local ground = nil
	if Config.FOOT_IK and state == "ground" and ctrl.mem.feet and distance < Config.FOOT_IK_DISTANCE then
		probeGround(ctrl, rootCFrame, dt)
		ground = ctrl.ground
	else
		ctrl.ground.Left = 0
		ctrl.ground.Right = 0
	end

	local lookDirection = nil
	if ctrl.isLocal and Config.LOOK_AT_CAMERA and camera then
		lookDirection = rootCFrame:VectorToObjectSpace(camera.CFrame.LookVector)
	end

	local pose = Gait.update(ctrl.mem, ctrl.rig, {
		state = state,
		velocity = velocity,
		yawRate = ctrl.yawRate,
		time = now,
		ground = ground,
		holdingTool = ctrl.model:FindFirstChildOfClass("Tool") ~= nil,
		look = lookDirection,
	}, dt)

	for name, joint in pairs(ctrl.joints) do
		joint.Transform = pose[name] or IDENTITY
	end
end

--============================================================
-- Main loop
--============================================================

-- Transform must be written after the Animator steps and before physics:
-- PreSimulation is that slot.
local stepConnection = RunService.PreSimulation:Connect(function(deltaTime)
	local dt = math.clamp(deltaTime, 1 / 240, 0.1)
	local now = os.clock()
	local camera = Workspace.CurrentCamera
	updateLocalSpeed(dt)
	for model, ctrl in pairs(controllers) do
		local ok, err = pcall(updateController, ctrl, dt, now, camera)
		if not ok then
			warn("ChadAnimate: stopped animating " .. model:GetFullName() .. ": " .. tostring(err))
			pcall(release, ctrl)
			controllers[model] = nil
			failedAt[model] = now
		end
	end
end)

localPlayer.CharacterAdded:Connect(function()
	currentSpeed = Config.WALK_SPEED
	table.clear(heldInputs)
	refreshSprint()
	task.defer(refresh)
end)

local running = true
task.spawn(function()
	while running do
		refresh()
		task.wait(0.5)
	end
end)

script.Destroying:Connect(function()
	running = false
	stepConnection:Disconnect()
	ContextActionService:UnbindAction(SPRINT_ACTION)
	for _, ctrl in pairs(controllers) do
		pcall(release, ctrl)
	end
	table.clear(controllers)
end)
