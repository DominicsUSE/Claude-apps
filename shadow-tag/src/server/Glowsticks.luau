--!strict
-- Glowsticks: map pickups and server-simulated throws. A lit glowstick is a
-- safe circle: survivors inside cannot be tagged and Shadows inside slow down.

local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")
local Workspace = game:GetService("Workspace")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Config = require(Shared.Config)
local Net = require(Shared.Net)
local Sounds = require(Shared.Sounds)

local MapBuilder = require(script.Parent.MapBuilder)
local Roster = require(script.Parent.Roster)

local GLOW = Color3.fromRGB(40, 255, 200)

local Glowsticks = {}

type Active = { part: BasePart, expires: number }
local active: { Active } = {}
local pickups: { BasePart } = {}
local folder: Folder
local epoch = 0

local function phase(): string?
	return Net.state():GetAttribute("Phase") :: string?
end

local function setPickupVisible(part: BasePart, visible: boolean)
	part:SetAttribute("Taken", not visible)
	part.Transparency = if visible then 0 else 1
	local light = part:FindFirstChildOfClass("PointLight")
	if light then
		light.Enabled = visible
	end
end

local function makePickup(pos: Vector3): BasePart
	local part = Instance.new("Part")
	part.Name = "GlowstickPickup"
	part.Size = Vector3.new(0.45, 1.8, 0.45)
	part.CFrame = CFrame.new(pos) * CFrame.Angles(0, 0, math.rad(20))
	part.Color = GLOW
	part.Material = Enum.Material.Neon
	part.Anchored = true
	part.CanCollide = false
	part.CastShadow = false
	local light = Instance.new("PointLight")
	light.Color = GLOW
	light.Range = 8
	light.Brightness = 1.2
	light.Shadows = false
	light.Parent = part
	part.Parent = folder

	part.Touched:Connect(function(hit)
		if part:GetAttribute("Taken") then
			return
		end
		local character = hit:FindFirstAncestorOfClass("Model")
		local player = character and Players:GetPlayerFromCharacter(character)
		local d = player and Roster.get(player)
		if not player or not d or d.role ~= "Survivor" or d.glowsticks >= Config.GlowsticksMax then
			return
		end
		Roster.setGlowsticks(player, d.glowsticks + 1)
		setPickupVisible(part, false)
		Sounds.play("Pickup", part)
		local myEpoch = epoch
		task.delay(Config.GlowstickPickupRespawn, function()
			if epoch == myEpoch then
				setPickupVisible(part, true)
			end
		end)
	end)
	return part
end

local function spawnStick(origin: Vector3, direction: Vector3)
	local part = Instance.new("Part")
	part.Name = "Glowstick"
	part.Size = Vector3.new(0.3, 0.3, 1.5)
	part.Color = GLOW
	part.Material = Enum.Material.Neon
	part.CastShadow = false
	part.CustomPhysicalProperties = PhysicalProperties.new(0.6, 0.9, 0.1)
	part.CFrame = CFrame.lookAt(origin, origin + direction)
	local light = Instance.new("PointLight")
	light.Color = GLOW
	light.Range = Config.GlowstickSafeRadius + 4
	light.Brightness = 2.2
	light.Shadows = false
	light.Parent = part
	part.Parent = folder
	part:SetNetworkOwner(nil)
	part.AssemblyLinearVelocity = direction * Config.GlowstickThrowSpeed + Vector3.new(0, 10, 0)
	part.AssemblyAngularVelocity = Vector3.new(math.random(-8, 8), math.random(-8, 8), math.random(-8, 8))
	Sounds.play("GlowstickCrack", part)

	local entry = { part = part, expires = os.clock() + Config.GlowstickLifetime }
	table.insert(active, entry)
	task.delay(Config.GlowstickLifetime - 3, function()
		if part.Parent then
			TweenService:Create(light, TweenInfo.new(3), { Brightness = 0 }):Play()
			TweenService:Create(part, TweenInfo.new(3), { Color = Color3.fromRGB(20, 60, 50) }):Play()
		end
	end)
	task.delay(Config.GlowstickLifetime, function()
		local index = table.find(active, entry)
		if index then
			table.remove(active, index)
		end
		part:Destroy()
	end)
end

-- True when a lit glowstick protects this position.
function Glowsticks.isProtected(position: Vector3): boolean
	local now = os.clock()
	for _, stick in active do
		if stick.expires > now and stick.part.Parent and (stick.part.Position - position).Magnitude <= Config.GlowstickSafeRadius then
			return true
		end
	end
	return false
end

-- Roster speed modifier: Shadows wade slowly through glowstick light.
function Glowsticks.speedModifier(d: Roster.Data, position: Vector3): number
	if d.role == "Shadow" and Glowsticks.isProtected(position) then
		return Config.GlowstickShadowSlow
	end
	return 1
end

function Glowsticks.reset()
	epoch += 1
	for _, stick in active do
		stick.part:Destroy()
	end
	table.clear(active)
	for _, part in pickups do
		setPickupVisible(part, true)
	end
end

function Glowsticks.init(refs: MapBuilder.Refs)
	folder = Instance.new("Folder")
	folder.Name = "Glowsticks"
	folder.Parent = refs.folder
	for _, pos in refs.pickups do
		table.insert(pickups, makePickup(pos))
	end

	local rayParams = RaycastParams.new()
	rayParams.FilterType = Enum.RaycastFilterType.Include
	rayParams.FilterDescendantsInstances = { refs.folder:FindFirstChild("Structure") :: Instance }

	Net.event("ThrowGlowstick").OnServerEvent:Connect(function(player, direction)
		if not Roster.allow(player, "glowstick") then
			return
		end
		local d = Roster.get(player)
		local p = phase()
		if not d or d.role ~= "Survivor" or d.glowsticks <= 0 or (p ~= "Round" and p ~= "Hiding") then
			return
		end
		if os.clock() - d.lastGlowstick < Config.GlowstickCooldown then
			return
		end
		local root = Roster.rootOf(player)
		if not root then
			return
		end
		local dir = root.CFrame.LookVector
		if typeof(direction) == "Vector3" and direction == direction and direction.Magnitude > 0.1 and direction.Magnitude < 2 then
			dir = direction.Unit
		end
		dir = Vector3.new(dir.X, math.clamp(dir.Y, -0.3, 0.7), dir.Z).Unit

		d.lastGlowstick = os.clock()
		Roster.setGlowsticks(player, d.glowsticks - 1)
		local origin = root.Position + Vector3.new(0, 1.5, 0)
		local flat = Vector3.new(dir.X, 0, dir.Z)
		local offset = if flat.Magnitude > 0.01 then flat.Unit * 2 else Vector3.zero
		if not Workspace:Raycast(origin, offset, rayParams) then
			origin += offset
		end
		spawnStick(origin, dir)
	end)
end

return Glowsticks
