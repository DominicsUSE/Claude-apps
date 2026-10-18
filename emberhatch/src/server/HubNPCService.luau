-- HubNPCService: a few Forgekin wander around Ember Hollow so the town feels alive.
-- Decoration only: they don't collide, can't be clicked, and never leave the hub.
-- Each one walks to a random spot near its home, rests 2–4 seconds, and repeats.

local RunService = game:GetService("RunService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local HubConfig = require(ReplicatedStorage.Shared.HubConfig)
local ForgekinService = require(script.Parent.ForgekinService)

local HUB_RADIUS = 95
local FORGE_RADIUS = 18 -- stay clear of the Forge building
local PLAZA_RADIUS = 30 -- the plaza floor is raised 0.4 studs
local WANDER_RADIUS = 14
local SPEED = 6

local HOMES = {
	HubConfig.Landmarks.Spawn + Vector3.new(-14, 0, -10),
	HubConfig.Landmarks.Forge + Vector3.new(26, 0, 10),
	HubConfig.Landmarks.Nursery + Vector3.new(0, 0, 26), -- south of the nest, clear of the eggs
	HubConfig.Landmarks.PortalPlaza + Vector3.new(0, 0, 16),
}

local HubNPCService = {}

local rng = Random.new()
local npcs = {}

local function flat(v)
	return Vector3.new(v.X, 0, v.Z)
end

-- True if walking from a to b would cut through the Forge.
local function crossesForge(a, b)
	local forge = flat(HubConfig.Landmarks.Forge)
	local ab = b - a
	local t = math.clamp((forge - a):Dot(ab) / math.max(ab:Dot(ab), 1e-6), 0, 1)
	return (a + ab * t - forge).Magnitude < FORGE_RADIUS
end

local function pickTarget(npc)
	for _ = 1, 8 do
		local angle = rng:NextNumber(0, math.pi * 2)
		local candidate = npc.home + Vector3.new(math.cos(angle), 0, math.sin(angle)) * rng:NextNumber(3, WANDER_RADIUS)
		if candidate.Magnitude < HUB_RADIUS and not crossesForge(npc.position, candidate) then
			return candidate
		end
	end
	return npc.home
end

local function step(dt)
	local now = os.clock()
	for _, npc in ipairs(npcs) do
		if now >= npc.restUntil then
			local offset = npc.target - npc.position
			if offset.Magnitude < 0.5 then
				npc.restUntil = now + rng:NextNumber(2, 4)
				npc.target = pickTarget(npc)
			else
				npc.facing = offset.Unit
				npc.position += npc.facing * math.min(offset.Magnitude, SPEED * dt)
			end
		end
		local floor = if npc.position.Magnitude < PLAZA_RADIUS then 0.4 else 0
		local bob = math.sin(now * 1.5 + npc.phase) * 0.2
		local at = npc.position + Vector3.new(0, floor + 1.3 + bob, 0)
		npc.model:PivotTo(CFrame.lookAt(at, at + npc.facing))
	end
end

function HubNPCService.Init()
	local hub = workspace:FindFirstChild("EmberHollow")
	if not hub then
		return
	end
	local folder = Instance.new("Folder")
	folder.Name = "NPCs"
	folder.Parent = hub

	for i, home in ipairs(HOMES) do
		local model = ForgekinService.BuildModel("Stoneback")
		if not model.PrimaryPart then
			model:Destroy()
			continue
		end
		model.Name = "HubNPC" .. i
		model.Parent = folder
		local npc = {
			model = model,
			home = flat(home),
			position = flat(home),
			facing = Vector3.new(0, 0, 1),
			phase = rng:NextNumber(0, math.pi * 2),
			restUntil = os.clock() + rng:NextNumber(0, 3),
		}
		npc.target = pickTarget(npc)
		table.insert(npcs, npc)
	end

	RunService.Heartbeat:Connect(step)
end

return HubNPCService
