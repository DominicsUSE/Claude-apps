-- God weapon: server-side auto-aim. The client only sends where it is aiming;
-- the server picks the target, checks line of sight and applies damage.

local Players = game:GetService("Players")
local CollectionService = game:GetService("CollectionService")

local tool = script.Parent
local fire = tool:WaitForChild("Fire")

local Settings = {
	Damage = math.huge, -- one-shot; lower it to balance
	Range = 500, -- studs
	ConeAngle = 15, -- degrees off the aim direction a target may be (replaces the FOV circle)
	Cooldown = 0.2, -- seconds between shots, enforced here so clients can't spam
	TeamCheck = true,
	WallCheck = true,
	LockPart = "Head",
	NPCTag = "Target", -- tag NPC models with this to make them hittable
}

local minDot = math.cos(math.rad(Settings.ConeAngle))
local lastShot = 0

local function getCandidates()
	local models = CollectionService:GetTagged(Settings.NPCTag)
	for _, player in Players:GetPlayers() do
		if player.Character then
			table.insert(models, player.Character)
		end
	end
	return models
end

-- Picks the target closest to the crosshair (highest dot product) inside the cone.
local function findTarget(shooter, origin, aim)
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { shooter.Character }

	local best, bestDot = nil, minDot
	for _, model in getCandidates() do
		local humanoid = model:FindFirstChildOfClass("Humanoid")
		local part = model:FindFirstChild(Settings.LockPart)
		if model == shooter.Character or not humanoid or not part or humanoid.Health <= 0 then
			continue
		end

		local owner = Players:GetPlayerFromCharacter(model)
		if Settings.TeamCheck and owner and owner.Team and owner.Team == shooter.Team then
			continue
		end

		local offset = part.Position - origin
		if offset.Magnitude > Settings.Range then
			continue
		end

		local dot = aim:Dot(offset.Unit)
		if dot <= bestDot then
			continue
		end

		if Settings.WallCheck then
			local hit = workspace:Raycast(origin, offset, params)
			if hit and not hit.Instance:IsDescendantOf(model) then
				continue
			end
		end

		best, bestDot = humanoid, dot
	end
	return best
end

fire.OnServerEvent:Connect(function(player, aim)
	if typeof(aim) ~= "Vector3" then
		return
	end
	aim = aim.Unit
	if aim ~= aim then
		return -- NaN from a zero or infinite vector
	end

	-- Only the player holding this tool may fire it
	local character = player.Character
	local head = character and character:FindFirstChild("Head")
	if tool.Parent ~= character or not head then
		return
	end

	local now = os.clock()
	if now - lastShot < Settings.Cooldown then
		return
	end
	lastShot = now

	local target = findTarget(player, head.Position, aim)
	if target then
		target:TakeDamage(Settings.Damage)
	end
end)
