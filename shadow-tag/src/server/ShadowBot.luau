--!strict
-- AI Shadow used when a server has too few players for PvP (or every Shadow
-- left mid-round). It sees survivors in line of sight, spots flashlights
-- from further away, hears sprinting and investigates breaker noise.

local PathfindingService = game:GetService("PathfindingService")
local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Config = require(Shared.Config)
local Zones = require(Shared.Zones)

local Glowsticks = require(script.Parent.Glowsticks)
local MapBuilder = require(script.Parent.MapBuilder)
local Power = require(script.Parent.Power)
local Roster = require(script.Parent.Roster)
local ShadowForm = require(script.Parent.ShadowForm)

local SIGHT_RANGE = 70
local FLASHLIGHT_RANGE = 110
local CHASE_SPEED = 16
local PATROL_SPEED = 11
local MEMORY = 4 -- seconds the bot keeps chasing a target it lost sight of
local ANIMATIONS = {
	idle = "rbxassetid://507766388",
	walk = "rbxassetid://507777826",
	run = "rbxassetid://507767714",
}

local ShadowBot = {}

local refs: MapBuilder.Refs
local folder: Folder
local rayParams = RaycastParams.new()
local noise: { position: Vector3, untilTime: number }? = nil

local function lineOfSight(from: Vector3, to: Vector3): boolean
	return Workspace:Raycast(from, to - from, rayParams) == nil
end

local function buildRig(): Model
	local ok, rig = pcall(function()
		return Players:CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), Enum.HumanoidRigType.R15)
	end)
	if ok and rig then
		return rig
	end
	-- Fallback: a minimal block body that Humanoid can still drive.
	local model = Instance.new("Model")
	local root = Instance.new("Part")
	root.Name = "HumanoidRootPart"
	root.Size = Vector3.new(2, 2, 1)
	root.Transparency = 1
	root.Parent = model
	local torso = Instance.new("Part")
	torso.Name = "UpperTorso"
	torso.Size = Vector3.new(2, 3, 1)
	torso.CFrame = root.CFrame
	torso.Parent = model
	local head = Instance.new("Part")
	head.Name = "Head"
	head.Size = Vector3.new(1.2, 1.2, 1.2)
	head.CFrame = root.CFrame * CFrame.new(0, 2.1, 0)
	head.Parent = model
	for _, part in { torso, head } do
		local weld = Instance.new("WeldConstraint")
		weld.Part0 = root
		weld.Part1 = part
		weld.Parent = part
	end
	local humanoid = Instance.new("Humanoid")
	humanoid.HipHeight = 2.5
	humanoid.Parent = model
	model.PrimaryPart = root
	return model
end

local function startAnimations(humanoid: Humanoid)
	local animator = humanoid:FindFirstChildOfClass("Animator") or Instance.new("Animator", humanoid)
	local tracks: { [string]: AnimationTrack } = {}
	for name, id in ANIMATIONS do
		local animation = Instance.new("Animation")
		animation.AnimationId = id
		local ok, track = pcall(function()
			return (animator :: Animator):LoadAnimation(animation)
		end)
		if ok and track then
			track.Looped = true
			tracks[name] = track
		end
	end
	local current: AnimationTrack? = nil
	local function play(name: string)
		local track = tracks[name]
		if track and track ~= current then
			if current then
				current:Stop(0.2)
			end
			track:Play(0.2)
			current = track
		end
	end
	play("idle")
	humanoid.Running:Connect(function(speed)
		if speed > 13 then
			play("run")
		elseif speed > 0.5 then
			play("walk")
		else
			play("idle")
		end
	end)
end

-- Picks the most noticeable survivor: visible, flashlight on, or sprinting nearby.
local function perceive(from: Vector3): (Player?, Vector3?)
	local best: Player?, bestPos: Vector3?, bestDist = nil, nil, math.huge
	for player, d in Roster.all() do
		if d.role ~= "Survivor" then
			continue
		end
		local root = Roster.rootOf(player)
		if not root then
			continue
		end
		local dist = (root.Position - from).Magnitude
		local sees = dist <= SIGHT_RANGE and lineOfSight(from, root.Position)
		local lit = d.flashlightOn and dist <= FLASHLIGHT_RANGE and lineOfSight(from, root.Position)
		local hears = d.sprinting and dist <= Config.SprintNoiseRange
		if (sees or lit or hears) and dist < bestDist then
			best, bestPos, bestDist = player, root.Position, dist
		end
	end
	return best, bestPos
end

local function brain(model: Model, humanoid: Humanoid, root: BasePart)
	local path = PathfindingService:CreatePath({
		AgentRadius = 2.5,
		AgentHeight = 5.5,
		AgentCanJump = true,
		AgentCanClimb = true,
		WaypointSpacing = 8,
	})
	local waypoints: { PathWaypoint } = {}
	local index = 1
	local pathGoal: Vector3? = nil
	local computedAt = 0
	local goal: Vector3? = nil
	local lastSeen = -math.huge
	local lastKnown: Vector3? = nil
	local stuckCheck, stuckPos = os.clock(), root.Position

	while model.Parent and humanoid.Health > 0 do
		local now = os.clock()
		local pos = root.Position
		local target, targetPos = perceive(pos)
		local chasing = false
		if target and targetPos then
			lastSeen, lastKnown, goal, chasing = now, targetPos, targetPos, true
		elseif lastKnown and now - lastSeen < MEMORY then
			goal, chasing = lastKnown, true
		elseif noise and now < noise.untilTime then
			goal = noise.position
			if (pos - noise.position).Magnitude < 10 then
				noise = nil
			end
		elseif not goal or (pos - goal).Magnitude < 8 then
			goal = refs.patrolPoints[math.random(#refs.patrolPoints)]
		end

		local speed = if chasing then CHASE_SPEED else PATROL_SPEED
		if Power.isDark(Zones.at(pos)) then
			speed *= Config.ShadowDarkBonus
		end
		if Glowsticks.isProtected(pos) then
			speed *= Config.GlowstickShadowSlow
		end
		humanoid.WalkSpeed = speed

		if goal then
			if chasing and (goal - pos).Magnitude < 30 and lineOfSight(pos, goal) then
				humanoid:MoveTo(goal)
				waypoints = {}
			else
				local needsPath = #waypoints == 0 or index > #waypoints or not pathGoal or (goal - (pathGoal :: Vector3)).Magnitude > 8 or now - computedAt > 2
				if needsPath then
					computedAt = now
					pathGoal = goal
					local ok = pcall(function()
						path:ComputeAsync(pos, goal :: Vector3)
					end)
					if ok and path.Status == Enum.PathStatus.Success then
						waypoints = path:GetWaypoints()
						index = 2
					else
						waypoints = {}
						goal = nil
					end
				end
				local waypoint = waypoints[index]
				if waypoint then
					if waypoint.Action == Enum.PathWaypointAction.Jump then
						humanoid.Jump = true
					end
					humanoid:MoveTo(waypoint.Position)
					if (Vector3.new(waypoint.Position.X, pos.Y, waypoint.Position.Z) - pos).Magnitude < 4 then
						index += 1
					end
				end
			end
		end

		if now - stuckCheck > 2 then
			if (root.Position - stuckPos).Magnitude < 1.5 and goal then
				humanoid.Jump = true
				waypoints = {}
			end
			stuckCheck, stuckPos = now, root.Position
		end
		task.wait(0.15)
	end
end

function ShadowBot.init(mapRefs: MapBuilder.Refs)
	refs = mapRefs
	folder = Instance.new("Folder")
	folder.Name = "Bots"
	folder.Parent = Workspace
	rayParams.FilterType = Enum.RaycastFilterType.Include
	rayParams.FilterDescendantsInstances = {
		refs.folder:FindFirstChild("Structure") :: Instance,
		refs.folder:FindFirstChild("Props") :: Instance,
	}
end

function ShadowBot.spawn(cf: CFrame): Model
	local model = buildRig()
	model.Name = "The Shadow"
	local humanoid = model:FindFirstChildOfClass("Humanoid") :: Humanoid
	local root = model:FindFirstChild("HumanoidRootPart") :: BasePart
	humanoid.DisplayDistanceType = Enum.HumanoidDisplayDistanceType.None
	humanoid.WalkSpeed = PATROL_SPEED
	model:PivotTo(cf)
	model.Parent = folder
	root:SetNetworkOwner(nil)
	ShadowForm.apply(model, 0)
	startAnimations(humanoid)
	task.spawn(brain, model, humanoid, root)
	return model
end

function ShadowBot.alert(position: Vector3)
	noise = { position = position, untilTime = os.clock() + 15 }
end

function ShadowBot.count(): number
	return #folder:GetChildren()
end

function ShadowBot.clear()
	noise = nil
	folder:ClearAllChildren()
end

return ShadowBot
