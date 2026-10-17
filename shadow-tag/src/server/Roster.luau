--!strict
-- Server-owned player state: role, stamina, battery, glowsticks, flashlight,
-- crouch pose and movement speed. Clients only send intents (sprint, crouch,
-- flashlight); everything is validated and simulated here and mirrored to
-- clients as Player attributes.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Config = require(Shared.Config)
local Net = require(Shared.Net)

export type Role = "Lobby" | "Survivor" | "Transforming" | "Shadow" | "Escaped"
export type Data = {
	player: Player,
	role: Role,
	stamina: number,
	battery: number,
	glowsticks: number,
	wantsSprint: boolean,
	wantsCrouch: boolean,
	sprinting: boolean,
	crouching: boolean,
	flashlightOn: boolean,
	lastSprintEnd: number,
	lastGlowstick: number,
	-- anti-exploit movement check
	lastGood: CFrame?,
	lastCheck: number,
	strikes: number,
	teleportGrace: number,
	rate: { [string]: { count: number, window: number } },
}
export type SpeedModifier = (data: Data, position: Vector3) -> number

local Roster = {}

local data: { [Player]: Data } = {}
local speedModifiers: { SpeedModifier } = {}
local joints: { [Model]: { [Motor6D]: CFrame } } = {}
local baseHip: { [Model]: number } = {}

-- Set by Round: positions/decorates a freshly spawned character for its role.
Roster.onCharacter = nil :: ((player: Player, character: Model, d: Data) -> ())?

function Roster.get(player: Player): Data?
	return data[player]
end

function Roster.all(): { [Player]: Data }
	return data
end

function Roster.addSpeedModifier(fn: SpeedModifier)
	table.insert(speedModifiers, fn)
end

function Roster.rootOf(player: Player): BasePart?
	local character = player.Character
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	if not character or not humanoid or humanoid.Health <= 0 then
		return nil
	end
	return character:FindFirstChild("HumanoidRootPart") :: BasePart?
end

-- Rate limit for remote handlers. Returns false when the player is spamming.
function Roster.allow(player: Player, key: string): boolean
	local d = data[player]
	if not d then
		return false
	end
	local now = os.clock()
	local bucket = d.rate[key]
	if not bucket or now - bucket.window >= 1 then
		d.rate[key] = { count = 1, window = now }
		return true
	end
	bucket.count += 1
	return bucket.count <= Config.RemoteRateLimit
end

-- Server-initiated moves must call this so the speed check does not flag them.
function Roster.teleport(player: Player, cf: CFrame)
	local character = player.Character
	local d = data[player]
	if character and d then
		d.teleportGrace = os.clock() + 1.5
		d.lastGood = cf
		character:PivotTo(cf)
	end
end

-- Flashlight -----------------------------------------------------------------

local function flashlightPart(character: Model): BasePart?
	return character:FindFirstChild("Flashlight") :: BasePart?
end

local function setFlashlight(d: Data, on: boolean)
	d.flashlightOn = on
	d.player:SetAttribute("FlashlightOn", on)
	local character = d.player.Character
	local part = character and flashlightPart(character)
	if part then
		local light = part:FindFirstChildOfClass("SpotLight")
		if light then
			light.Enabled = on
		end
		part.Material = if on then Enum.Material.Neon else Enum.Material.Metal
		local dust = part:FindFirstChild("Dust", true) :: ParticleEmitter?
		if dust then
			dust.Enabled = on
		end
	end
end

function Roster.giveFlashlight(character: Model)
	local root = character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not root or flashlightPart(character) then
		return
	end
	local part = Instance.new("Part")
	part.Name = "Flashlight"
	part.Size = Vector3.new(0.35, 0.35, 1.1)
	part.Color = Color3.fromRGB(40, 40, 44)
	part.Material = Enum.Material.Metal
	part.CanCollide = false
	part.CanQuery = false
	part.CanTouch = false
	part.Massless = true
	part.CastShadow = false
	part.CFrame = root.CFrame * CFrame.new(0.75, 0.55, -0.85)
	local weld = Instance.new("WeldConstraint")
	weld.Part0 = root
	weld.Part1 = part
	weld.Parent = part

	local light = Instance.new("SpotLight")
	light.Face = Enum.NormalId.Front
	light.Range = Config.FlashlightRange
	light.Angle = Config.FlashlightAngle
	light.Brightness = Config.FlashlightBrightness
	light.Color = Color3.fromRGB(255, 244, 220)
	light.Shadows = false -- the owning client turns shadows on locally
	light.Enabled = false
	light.Parent = part

	-- Dust motes only show where the beam lights them (LightInfluence = 1).
	local volume = Instance.new("Part")
	volume.Name = "DustVolume"
	volume.Size = Vector3.new(5, 4, 14)
	volume.Transparency = 1
	volume.CanCollide = false
	volume.CanQuery = false
	volume.CanTouch = false
	volume.Massless = true
	volume.CastShadow = false
	volume.CFrame = part.CFrame * CFrame.new(0, 0, -8)
	local volumeWeld = Instance.new("WeldConstraint")
	volumeWeld.Part0 = part
	volumeWeld.Part1 = volume
	volumeWeld.Parent = volume
	local dust = Instance.new("ParticleEmitter")
	dust.Name = "Dust"
	dust.Texture = "rbxasset://textures/particles/sparkles_main.dds"
	dust.Shape = Enum.ParticleEmitterShape.Box
	dust.ShapeStyle = Enum.ParticleEmitterShapeStyle.Volume
	dust.Rate = 24
	dust.Lifetime = NumberRange.new(2, 4)
	dust.Speed = NumberRange.new(0.1, 0.3)
	dust.SpreadAngle = Vector2.new(180, 180)
	dust.Drag = 1
	dust.Size = NumberSequence.new(0.07)
	dust.Transparency = NumberSequence.new({
		NumberSequenceKeypoint.new(0, 1),
		NumberSequenceKeypoint.new(0.3, 0.35),
		NumberSequenceKeypoint.new(1, 1),
	})
	dust.LightEmission = 0.1
	dust.LightInfluence = 1
	dust.Color = ColorSequence.new(Color3.fromRGB(255, 240, 220))
	dust.Enabled = false
	dust.Parent = volume
	volume.Parent = part
	part.Parent = character

	local owner = Players:GetPlayerFromCharacter(character)
	local state = owner and data[owner]
	if state then
		setFlashlight(state, false)
	end
end

function Roster.removeFlashlight(character: Model)
	local part = flashlightPart(character)
	if part then
		part:Destroy()
	end
	local player = Players:GetPlayerFromCharacter(character)
	local d = player and data[player]
	if d then
		d.flashlightOn = false
		d.player:SetAttribute("FlashlightOn", false)
	end
end

-- Crouch pose (R15 joints are bent server-side so everyone sees it) ------------

local CROUCH_POSE = {
	Waist = CFrame.Angles(math.rad(-20), 0, 0),
	LeftHip = CFrame.Angles(math.rad(60), 0, 0),
	RightHip = CFrame.Angles(math.rad(60), 0, 0),
	LeftKnee = CFrame.Angles(math.rad(-100), 0, 0),
	RightKnee = CFrame.Angles(math.rad(-100), 0, 0),
}

local function setCrouchPose(character: Model, crouched: boolean)
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if not humanoid or humanoid.RigType ~= Enum.HumanoidRigType.R15 then
		return
	end
	local saved = joints[character]
	if not saved then
		saved = {}
		for name in CROUCH_POSE do
			local motor = character:FindFirstChild(name, true)
			if motor and motor:IsA("Motor6D") then
				saved[motor] = motor.C0
			end
		end
		joints[character] = saved
		baseHip[character] = humanoid.HipHeight
		character.Destroying:Once(function()
			joints[character] = nil
			baseHip[character] = nil
		end)
	end
	for motor, c0 in saved do
		motor.C0 = if crouched then c0 * CROUCH_POSE[motor.Name] else c0
	end
	local hip = baseHip[character]
	humanoid.HipHeight = if crouched then hip * 0.62 else hip
end

local function setCrouch(d: Data, crouched: boolean)
	if d.crouching == crouched then
		return
	end
	d.crouching = crouched
	d.player:SetAttribute("Crouching", crouched)
	local character = d.player.Character
	if character then
		setCrouchPose(character, crouched)
	end
end

-- Roles ------------------------------------------------------------------------

function Roster.setRole(player: Player, role: Role)
	local d = data[player]
	if not d then
		return
	end
	d.role = role
	player:SetAttribute("Role", role)
	local character = player.Character
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	if role == "Shadow" or role == "Transforming" then
		if character then
			Roster.removeFlashlight(character)
		end
		d.wantsCrouch = false
		setCrouch(d, false)
	end
	if humanoid then
		humanoid.JumpHeight = if role == "Transforming" then 0 else 7.2
	end
end

function Roster.resetForRound(player: Player)
	local d = data[player]
	if not d then
		return
	end
	d.stamina = Config.StaminaMax
	d.battery = Config.BatteryMax
	d.glowsticks = Config.GlowsticksStart
	player:SetAttribute("Glowsticks", d.glowsticks)
	player:SetAttribute("Stamina", d.stamina)
	player:SetAttribute("Battery", d.battery)
	setFlashlight(d, false)
end

function Roster.setGlowsticks(player: Player, count: number)
	local d = data[player]
	if d then
		d.glowsticks = math.clamp(count, 0, Config.GlowsticksMax)
		player:SetAttribute("Glowsticks", d.glowsticks)
	end
end

-- Lifecycle ----------------------------------------------------------------------

local function onCharacter(player: Player, character: Model)
	local d = data[player]
	if not d then
		return
	end
	local humanoid = character:WaitForChild("Humanoid", 10) :: Humanoid?
	local root = character:WaitForChild("HumanoidRootPart", 10) :: BasePart?
	if not humanoid or not root or character.Parent == nil then
		return
	end
	d.crouching = false
	d.wantsCrouch = false
	d.lastGood = nil
	d.sprinting = false
	player:SetAttribute("Crouching", false)
	humanoid.WalkSpeed = Config.WalkSpeed
	humanoid.UseJumpPower = false
	humanoid.JumpHeight = 7.2
	if Roster.onCharacter then
		Roster.onCharacter(player, character, d)
	end
end

local function add(player: Player)
	local d: Data = {
		player = player,
		role = "Lobby",
		stamina = Config.StaminaMax,
		battery = Config.BatteryMax,
		glowsticks = 0,
		wantsSprint = false,
		wantsCrouch = false,
		sprinting = false,
		crouching = false,
		flashlightOn = false,
		lastSprintEnd = 0,
		lastGlowstick = 0,
		lastGood = nil,
		lastCheck = os.clock(),
		strikes = 0,
		teleportGrace = 0,
		rate = {},
	}
	data[player] = d
	player:SetAttribute("Role", "Lobby")
	player:SetAttribute("Stamina", d.stamina)
	player:SetAttribute("Battery", d.battery)
	player:SetAttribute("Glowsticks", 0)
	player:SetAttribute("FlashlightOn", false)
	player:SetAttribute("Sprinting", false)
	player:SetAttribute("Crouching", false)
	player.CharacterAdded:Connect(function(character)
		onCharacter(player, character)
	end)
	if player.Character then
		task.spawn(onCharacter, player, player.Character)
	end
end

-- Simulation tick ------------------------------------------------------------------

local function horizontal(v: Vector3): Vector3
	return Vector3.new(v.X, 0, v.Z)
end

local function syncAttribute(player: Player, name: string, value: number)
	local rounded = math.floor(value + 0.5)
	if player:GetAttribute(name) ~= rounded then
		player:SetAttribute(name, rounded)
	end
end

local function tick(dt: number)
	local now = os.clock()
	for player, d in data do
		local character = player.Character
		local humanoid = character and character:FindFirstChildOfClass("Humanoid")
		local root = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
		if not character or not humanoid or not root or humanoid.Health <= 0 then
			continue
		end

		local moving = horizontal(root.AssemblyLinearVelocity).Magnitude > 1.5
		local canAct = d.role ~= "Transforming" and d.role ~= "Escaped"

		-- Crouch follows intent unless sprinting.
		setCrouch(d, d.wantsCrouch and canAct and not d.sprinting)

		-- Stamina
		local canSprint = d.wantsSprint and moving and canAct and not d.crouching
		if d.sprinting and (not canSprint or d.stamina <= 0) then
			d.sprinting = false
			d.lastSprintEnd = now
		elseif not d.sprinting and canSprint and d.stamina >= Config.StaminaMinToSprint then
			d.sprinting = true
		end
		if d.sprinting then
			d.stamina = math.max(0, d.stamina - Config.StaminaDrain * dt)
		elseif now - d.lastSprintEnd >= Config.StaminaRegenDelay then
			local regen = if moving then Config.StaminaRegenWalking else Config.StaminaRegenIdle
			d.stamina = math.min(Config.StaminaMax, d.stamina + regen * dt)
		end
		if player:GetAttribute("Sprinting") ~= d.sprinting then
			player:SetAttribute("Sprinting", d.sprinting)
		end

		-- Battery
		if d.flashlightOn then
			d.battery = math.max(0, d.battery - Config.BatteryDrain * dt)
			if d.battery <= 0 then
				setFlashlight(d, false)
			end
		else
			d.battery = math.min(Config.BatteryMax, d.battery + Config.BatteryRecharge * dt)
		end
		syncAttribute(player, "Stamina", d.stamina)
		syncAttribute(player, "Battery", d.battery)

		-- Speed
		local speed = if d.role == "Lobby" then Config.LobbyWalkSpeed else Config.WalkSpeed
		if d.role == "Transforming" then
			speed = 0
		elseif d.sprinting then
			speed = Config.SprintSpeed
		elseif d.crouching then
			speed = Config.CrouchSpeed
		end
		for _, modifier in speedModifiers do
			speed *= modifier(d, root.Position)
		end
		if math.abs(humanoid.WalkSpeed - speed) > 0.05 then
			humanoid.WalkSpeed = speed
		end

		-- Movement sanity check: rubber-band clients that move far faster than
		-- their server-assigned speed allows.
		if now - d.lastCheck >= Config.SpeedCheckInterval then
			local window = now - d.lastCheck
			d.lastCheck = now
			local seated = humanoid.SeatPart ~= nil
			if now < d.teleportGrace or seated or d.role == "Escaped" or not d.lastGood then
				d.lastGood = root.CFrame
				d.strikes = 0
			else
				local maxSpeed = Config.SprintSpeed * Config.ShadowDarkBonus
				local allowed = maxSpeed * window * Config.SpeedTolerance + Config.SpeedSlack
				local moved = horizontal(root.Position - d.lastGood.Position).Magnitude
				if moved > allowed then
					d.strikes += 1
					if d.strikes >= 2 then
						d.strikes = 0
						Roster.teleport(player, d.lastGood)
					end
				else
					d.strikes = 0
					d.lastGood = root.CFrame
				end
			end
		end
	end
end

-- Init ----------------------------------------------------------------------------

function Roster.init()
	Net.event("SetSprint").OnServerEvent:Connect(function(player, wants)
		local d = data[player]
		if d and typeof(wants) == "boolean" and Roster.allow(player, "sprint") then
			d.wantsSprint = wants
		end
	end)
	Net.event("SetCrouch").OnServerEvent:Connect(function(player, wants)
		local d = data[player]
		if d and typeof(wants) == "boolean" and Roster.allow(player, "crouch") then
			d.wantsCrouch = wants
		end
	end)
	Net.event("ToggleFlashlight").OnServerEvent:Connect(function(player)
		local d = data[player]
		if not d or not Roster.allow(player, "flashlight") then
			return
		end
		if d.role ~= "Survivor" and d.role ~= "Lobby" then
			return
		end
		local character = player.Character
		if not character or not flashlightPart(character) then
			return
		end
		if d.flashlightOn then
			setFlashlight(d, false)
		elseif d.battery >= Config.BatteryMinToTurnOn then
			setFlashlight(d, true)
		end
	end)

	Players.PlayerAdded:Connect(add)
	for _, player in Players:GetPlayers() do
		add(player)
	end
	Players.PlayerRemoving:Connect(function(player)
		data[player] = nil
	end)

	local acc = 0
	RunService.Heartbeat:Connect(function(dt)
		acc += dt
		if acc >= 0.1 then
			tick(acc)
			acc = 0
		end
	end)
end

return Roster
