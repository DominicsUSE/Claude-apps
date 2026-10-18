-- HubBuilder: builds Ember Hollow from parts when the server starts.
-- Skips building if workspace.EmberHollow already exists, so you can replace
-- this with a hand-built map later (keep the same tags and attributes).
--
-- Cylinders: a Roblox cylinder's round faces point along its X axis, so every
-- upright cylinder here is Size = (height, diameter, diameter) rotated 90° on Z.

local CollectionService = game:GetService("CollectionService")
local Lighting = game:GetService("Lighting")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Theme = require(ReplicatedStorage.Shared.Theme)
local HubConfig = require(ReplicatedStorage.Shared.HubConfig)
local ZoneConfig = require(ReplicatedStorage.Shared.ZoneConfig)

local C = HubConfig.Color
local L = HubConfig.Landmarks

local HubBuilder = {}

-- ── Primitives ───────────────────────────────────────────

local function newFolder(parent, name)
	local folder = Instance.new("Folder")
	folder.Name = name
	folder.Parent = parent
	return folder
end

local function newPart(parent, name, size, cframe, color, material, opts)
	opts = opts or {}
	local part = Instance.new("Part")
	part.Name = name
	part.Size = size
	part.CFrame = cframe
	part.Color = color
	part.Material = material or Enum.Material.SmoothPlastic
	part.Anchored = true
	part.CanCollide = opts.collide ~= false
	part.CanTouch = false
	part.CanQuery = part.CanCollide -- raycasts (ground snapping, camera) only see solid parts
	part.CastShadow = opts.shadow ~= false
	part.Transparency = opts.transparency or 0
	if opts.shape then
		part.Shape = opts.shape
	end
	part.TopSurface = Enum.SurfaceType.Smooth
	part.BottomSurface = Enum.SurfaceType.Smooth
	part.Parent = parent
	return part
end

-- Upright cylinder centered at position.
local function cylinder(parent, name, height, diameter, position, color, material, opts)
	opts = opts or {}
	opts.shape = Enum.PartType.Cylinder
	return newPart(
		parent,
		name,
		Vector3.new(height, diameter, diameter),
		CFrame.new(position) * CFrame.Angles(0, 0, math.rad(90)),
		color,
		material,
		opts
	)
end

-- Egg-shaped part: a block with a sphere mesh stretches to any size.
local function egg(parent, name, size, position, color, opts)
	local part = newPart(parent, name, size, CFrame.new(position), color, Enum.Material.SmoothPlastic, opts)
	local mesh = Instance.new("SpecialMesh")
	mesh.MeshType = Enum.MeshType.Sphere
	mesh.Parent = part
	return part
end

local function newLight(parent, color, brightness, range)
	local light = Instance.new("PointLight")
	light.Color = color
	light.Brightness = brightness
	light.Range = range
	light.Shadows = false
	light.Parent = parent
	return light
end

local function anchorAt(parent, name, position)
	return newPart(parent, name, Vector3.new(0.2, 0.2, 0.2), CFrame.new(position), Color3.new(), nil, {
		collide = false,
		transparency = 1,
		shadow = false,
	})
end

local function newPrompt(parent, action, object, hold, distance)
	local prompt = Instance.new("ProximityPrompt")
	prompt.ActionText = action
	prompt.ObjectText = object
	prompt.HoldDuration = hold or 0
	prompt.MaxActivationDistance = distance or 10
	prompt.RequiresLineOfSight = false
	prompt.Parent = parent
	return prompt
end

-- Floating name sign, sized in studs so it shrinks with distance.
local function newBillboard(parent, title, subtitle, accent, worldPosition, width)
	local anchor = anchorAt(parent, "Sign_" .. title:gsub("%W", ""), worldPosition)
	width = width or 14

	local gui = Instance.new("BillboardGui")
	gui.Name = "Sign"
	gui.Size = UDim2.new(width, 0, if subtitle then 3.6 else 2.4, 0)
	gui.AlwaysOnTop = true
	gui.LightInfluence = 0
	gui.MaxDistance = 180
	gui.Adornee = anchor
	gui.Parent = anchor

	local frame = Instance.new("Frame")
	frame.Size = UDim2.fromScale(1, 1)
	frame.BackgroundColor3 = Theme.Color.StoneBase
	frame.BackgroundTransparency = 0.1
	frame.Parent = gui
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0.18, 0)
	corner.Parent = frame
	local stroke = Instance.new("UIStroke")
	stroke.Color = accent
	stroke.Thickness = 2
	stroke.Parent = frame

	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Size = UDim2.new(0.92, 0, if subtitle then 0.56 else 0.8, 0)
	label.Position = UDim2.fromScale(0.04, if subtitle then 0.08 else 0.1)
	label.Font = Theme.Font.Title
	label.Text = title
	label.TextColor3 = Theme.Color.Parchment
	label.TextScaled = true
	label.Parent = frame

	if subtitle then
		local sub = Instance.new("TextLabel")
		sub.BackgroundTransparency = 1
		sub.Size = UDim2.new(0.9, 0, 0.28, 0)
		sub.Position = UDim2.fromScale(0.05, 0.64)
		sub.Font = Theme.Font.Body
		sub.Text = subtitle
		sub.TextColor3 = accent
		sub.TextScaled = true
		sub.Parent = frame
	end
	return anchor
end

-- Flat strip on the ground from one point to another.
local function pathStrip(parent, name, from, to, width, color, material, y)
	local delta = Vector3.new(to.X - from.X, 0, to.Z - from.Z)
	local middle = (from + to) / 2
	return newPart(
		parent,
		name,
		Vector3.new(width, 0.1, delta.Magnitude),
		CFrame.lookAt(Vector3.new(middle.X, y, middle.Z), Vector3.new(to.X, y, to.Z)),
		color,
		material,
		{ collide = false, shadow = false }
	)
end

-- ── Sections ─────────────────────────────────────────────

local function applyLighting()
	Lighting.Ambient = Color3.fromRGB(88, 66, 48)
	Lighting.OutdoorAmbient = Color3.fromRGB(112, 90, 68)
	Lighting.Brightness = 1.6
	Lighting.ClockTime = 17.4
	Lighting.EnvironmentDiffuseScale = 0.4
	Lighting.EnvironmentSpecularScale = 0.3

	local function effect(className, name, props)
		if Lighting:FindFirstChild(name) then
			return
		end
		local instance = Instance.new(className)
		instance.Name = name
		for key, value in pairs(props) do
			instance[key] = value
		end
		instance.Parent = Lighting
	end
	effect("Atmosphere", "EmberAtmosphere", {
		Density = 0.32,
		Offset = 0.1,
		Color = Color3.fromRGB(255, 198, 142),
		Decay = Color3.fromRGB(122, 80, 50),
		Glare = 0.2,
		Haze = 1.2,
	})
	effect("BloomEffect", "EmberBloom", { Intensity = 0.5, Size = 20, Threshold = 1.4 })
	effect("ColorCorrectionEffect", "EmberGrade", {
		TintColor = Color3.fromRGB(255, 244, 230),
		Saturation = 0.05,
		Contrast = 0.05,
	})
end

local function buildGround(root)
	local f = newFolder(root, "Ground")
	newPart(f, "Floor", Vector3.new(220, 2, 220), CFrame.new(0, -1, 0), C.Ground, Enum.Material.Slate)
	cylinder(f, "PlazaRing", 0.3, 62, Vector3.new(0, 0.15, 0), C.Brass, Enum.Material.Metal, { collide = false })
	cylinder(f, "Plaza", 0.4, 60, Vector3.new(0, 0.2, 0), C.StoneRaised, Enum.Material.Slate)
	cylinder(f, "ForgePad", 0.5, 30, Vector3.new(0, 0.25, 0), C.StoneDark, Enum.Material.Basalt)

	for _, wall in ipairs({
		{ Vector3.new(0, 30, 109), Vector3.new(220, 60, 2) },
		{ Vector3.new(0, 30, -109), Vector3.new(220, 60, 2) },
		{ Vector3.new(109, 30, 0), Vector3.new(2, 60, 220) },
		{ Vector3.new(-109, 30, 0), Vector3.new(2, 60, 220) },
	}) do
		newPart(f, "Boundary", wall[2], CFrame.new(wall[1]), Color3.new(), nil, { transparency = 1, shadow = false })
	end
end

local function buildPaths(root)
	local f = newFolder(root, "Paths")
	local paths = {
		{ "Spawn", Vector3.new(0, 0, 52), Vector3.new(0, 0, 30), 10 },
		{ "Portals", Vector3.new(0, 0, -30), Vector3.new(0, 0, -74), 12 },
		{ "Nursery", Vector3.new(29, 0, 6), Vector3.new(50, 0, 18), 8 },
		{ "EggShop", Vector3.new(29, 0, -6), Vector3.new(61, 0, -16), 8 },
		{ "Quests", Vector3.new(-29, 0, -2), Vector3.new(-56, 0, -5), 8 },
		{ "Upgrades", Vector3.new(-28, 0, 9), Vector3.new(-57, 0, 26), 8 },
	}
	for _, path in ipairs(paths) do
		pathStrip(f, path[1], path[2], path[3], path[4], C.Path, Enum.Material.Cobblestone, 0.05)
		pathStrip(f, path[1] .. "Line", path[2], path[3], 1, C.Brass, Enum.Material.Metal, 0.07)
	end
end

local function buildSpawn(root)
	local f = newFolder(root, "Spawn")
	local origin = L.Spawn

	cylinder(f, "StartDisc", 0.15, 12, origin + Vector3.new(0, 0.08, 0), C.Amber, Enum.Material.Neon, {
		collide = false,
		transparency = 0.25,
		shadow = false,
	})
	newLight(anchorAt(f, "StartLight", origin + Vector3.new(0, 2, 0)), C.Amber, 1.6, 16)

	-- Amber trail from spawn to the Forge. Dots sit on whichever floor is under them.
	for i = 1, 6 do
		local position = origin:Lerp(L.Forge, i / 7)
		local radius = Vector3.new(position.X, 0, position.Z).Magnitude
		local y = if radius < 15 then 0.57 elseif radius < 30 then 0.47 else 0.18
		cylinder(f, "TrailDot" .. i, 0.1, 1.6, Vector3.new(position.X, y, position.Z), C.Amber, Enum.Material.Neon, {
			collide = false,
			shadow = false,
		})
	end

	local spawn = Instance.new("SpawnLocation")
	spawn.Name = "PlayerSpawn"
	spawn.Size = Vector3.new(12, 0.2, 12)
	spawn.CFrame = CFrame.new(origin + Vector3.new(0, 0.1, 0)) -- faces north, toward the Forge
	spawn.Anchored = true
	spawn.Transparency = 1
	spawn.Neutral = true
	spawn.Duration = 0
	spawn.Parent = f

	-- Landing spot for portals back to the hub.
	local entry = anchorAt(f, "HubEntry", origin + Vector3.new(0, 0.5, -3))
	CollectionService:AddTag(entry, "ZoneEntry_" .. ZoneConfig.Hub)

	newBillboard(f, "START HERE", "Follow the amber trail", Theme.Color.Amber, origin + Vector3.new(0, 9, 0), 12)
end

local function buildForge(root)
	local f = newFolder(root, "Forge")
	local o = L.Forge

	newPart(f, "Base", Vector3.new(20, 8, 14), CFrame.new(o + Vector3.new(0, 4, 0)), C.StoneDark, Enum.Material.Basalt)
	newPart(
		f,
		"Chimney",
		Vector3.new(4, 12, 4),
		CFrame.new(o + Vector3.new(0, 14, -4)),
		C.StoneDark,
		Enum.Material.Basalt
	)
	newPart(
		f,
		"Trim",
		Vector3.new(20.4, 0.6, 14.4),
		CFrame.new(o + Vector3.new(0, 8.1, 0)),
		C.Brass,
		Enum.Material.Metal
	)

	local mouth = newPart(
		f,
		"FurnaceMouth",
		Vector3.new(6, 5, 0.6),
		CFrame.new(o + Vector3.new(0, 3.5, 7.2)),
		C.EmberRed,
		Enum.Material.Neon
	)
	newLight(mouth, C.Amber, 2, 26)

	local fire = Instance.new("ParticleEmitter")
	fire.Texture = "rbxasset://textures/particles/fire_main.dds"
	fire.Lifetime = NumberRange.new(0.7, 1.2)
	fire.Speed = NumberRange.new(2, 4)
	fire.SpreadAngle = Vector2.new(18, 18)
	fire.Rate = 14
	fire.Size = NumberSequence.new({
		NumberSequenceKeypoint.new(0, 0.8),
		NumberSequenceKeypoint.new(0.6, 1.3),
		NumberSequenceKeypoint.new(1, 0),
	})
	fire.Color = ColorSequence.new(C.Amber, C.EmberRed)
	fire.LightEmission = 0.8
	fire.Parent = anchorAt(f, "FireAnchor", o + Vector3.new(0, 6.2, 7.6))

	-- Anvil: the Forge Station prompt lives here.
	local anvil = newPart(
		f,
		"Anvil",
		Vector3.new(4, 2, 2.4),
		CFrame.new(o + Vector3.new(10, 1.5, 11)),
		C.StoneBase,
		Enum.Material.Metal
	)
	newPart(
		f,
		"AnvilTop",
		Vector3.new(5.5, 1, 2),
		CFrame.new(o + Vector3.new(10, 3, 11)),
		C.StoneRaised,
		Enum.Material.Metal
	)
	local prompt = newPrompt(anvil, "Forge", "Forge Station", 0, 10)
	prompt:SetAttribute("HubObject", "ForgeStation")
	CollectionService:AddTag(prompt, "HubPrompt")

	newPart(
		f,
		"Bellows",
		Vector3.new(4, 3, 3.5),
		CFrame.new(o + Vector3.new(-10, 2, 10)),
		C.Wood,
		Enum.Material.WoodPlanks
	)
	newPart(
		f,
		"BellowsHandle",
		Vector3.new(0.8, 0.8, 3),
		CFrame.new(o + Vector3.new(-10, 3.9, 10)),
		C.WoodDark,
		Enum.Material.Wood
	)

	cylinder(f, "QuenchBarrel", 3.2, 3, o + Vector3.new(-5.5, 2.1, 11), C.WoodDark, Enum.Material.WoodPlanks)
	cylinder(
		f,
		"BarrelBand",
		0.35,
		3.2,
		o + Vector3.new(-5.5, 2.7, 11),
		C.Brass,
		Enum.Material.Metal,
		{ collide = false }
	)

	-- Gears on the chimney face. Axis points south; clients spin them.
	for _, gear in ipairs({
		{ "GearLarge", 3, Vector3.new(-0.6, 12.5, -1.75), 0.8 },
		{ "GearSmall", 2, Vector3.new(1.3, 14.6, -1.75), -1.2 },
	}) do
		local part = newPart(
			f,
			gear[1],
			Vector3.new(0.4, gear[2], gear[2]),
			CFrame.new(o + gear[3]) * CFrame.Angles(0, math.rad(90), 0),
			C.BrassBright,
			Enum.Material.Metal,
			{ shape = Enum.PartType.Cylinder }
		)
		part:SetAttribute("Spin", gear[4])
		part:SetAttribute("SpinAxis", "X")
		CollectionService:AddTag(part, "Spin")
	end

	newBillboard(
		f,
		"FORGE STATION",
		"Anvil · Furnace · Quench",
		Theme.Color.BrassBright,
		o + Vector3.new(0, 23, 0),
		16
	)
end

local function buildNursery(root)
	local f = newFolder(root, "Nursery")
	local o = L.Nursery

	cylinder(f, "NestPad", 0.4, 26, o + Vector3.new(0, 0.2, 0), C.StoneRaised, Enum.Material.Slate)
	cylinder(f, "NestRing", 0.3, 27, o + Vector3.new(0, 0.15, 0), C.Brass, Enum.Material.Metal, { collide = false })

	-- Starter egg in the middle, display eggs around it.
	local pedestal = newPart(
		f,
		"StarterEggPedestal",
		Vector3.new(4, 3, 4),
		CFrame.new(o + Vector3.new(0, 1.9, 0)),
		C.Brass,
		Enum.Material.Metal
	)
	local starterEgg = egg(f, "StarterEggDisplay", Vector3.new(2.6, 3.4, 2.6), o + Vector3.new(0, 5.1, 0), C.Parchment)
	newLight(starterEgg, C.BrassBright, 1.6, 16)
	newPrompt(pedestal, "Hatch", "Starter Egg", 0.5, 12)
	CollectionService:AddTag(pedestal, "StarterEgg")

	for i = 1, 3 do
		local angle = math.rad(i * 120 + 30)
		local position = o + Vector3.new(math.cos(angle) * 8, 0, math.sin(angle) * 8)
		newPart(
			f,
			"Pedestal" .. i,
			Vector3.new(2, 2.4, 2),
			CFrame.new(position + Vector3.new(0, 1.4, 0)),
			C.StoneBase,
			Enum.Material.Slate
		)
		egg(
			f,
			"DisplayEgg" .. i,
			Vector3.new(1.6, 2.1, 1.6),
			position + Vector3.new(0, 3.6, 0),
			({ C.Amber, C.Leaf, Theme.Color.Core })[i]
		)
	end

	newBillboard(f, "FORGEKIN NURSERY", "Hatch your first Forgekin", Theme.Color.Amber, o + Vector3.new(0, 13, 0), 16)
end

local function buildEggShop(root)
	local f = newFolder(root, "EggShop")
	local o = L.EggShop

	-- Counter faces west, toward the plaza.
	local counter = newPart(
		f,
		"Counter",
		Vector3.new(5, 3, 14),
		CFrame.new(o + Vector3.new(0, 1.5, 0)),
		C.Wood,
		Enum.Material.WoodPlanks
	)
	newPart(
		f,
		"CounterTop",
		Vector3.new(6, 0.4, 15),
		CFrame.new(o + Vector3.new(0, 3.2, 0)),
		C.WoodDark,
		Enum.Material.WoodPlanks
	)
	newPart(
		f,
		"Shelves",
		Vector3.new(1, 10, 14),
		CFrame.new(o + Vector3.new(4.5, 5, 0)),
		C.StoneBase,
		Enum.Material.WoodPlanks
	)
	for i, color in ipairs({ C.Amber, C.Leaf, Theme.Color.Core }) do
		egg(
			f,
			"DisplayEgg" .. i,
			Vector3.new(1.4, 1.9, 1.4),
			o + Vector3.new(3.4, 4 + (i % 2) * 3, -5 + (i - 1) * 5),
			color
		)
	end
	local prompt = newPrompt(counter, "Browse", "Egg Shop", 0, 10)
	prompt:SetAttribute("HubObject", "EggShop")
	CollectionService:AddTag(prompt, "HubPrompt")

	newBillboard(f, "EGG SHOP", "New eggs for coins", Theme.Color.Amber, o + Vector3.new(0, 14, 0), 13)
end

local function buildQuestBoard(root)
	local f = newFolder(root, "QuestBoard")
	local o = L.QuestBoard

	for _, z in ipairs({ -3.5, 3.5 }) do
		newPart(
			f,
			"Post",
			Vector3.new(0.8, 9, 0.8),
			CFrame.new(o + Vector3.new(0, 4.5, z)),
			C.WoodDark,
			Enum.Material.Wood
		)
	end
	local board = newPart(
		f,
		"Board",
		Vector3.new(0.4, 5, 7),
		CFrame.new(o + Vector3.new(0, 5.5, 0)),
		C.Wood,
		Enum.Material.WoodPlanks
	)
	for i = 1, 3 do
		newPart(
			f,
			"Note" .. i,
			Vector3.new(0.1, 1.6, 1.3),
			CFrame.new(o + Vector3.new(0.26, 5.2 + (i % 2) * 1.1, -2 + (i - 1) * 2)),
			C.Parchment,
			Enum.Material.SmoothPlastic,
			{ collide = false }
		)
	end
	local prompt = newPrompt(board, "Read", "Quest Board", 0, 10)
	prompt:SetAttribute("HubObject", "QuestBoard")
	CollectionService:AddTag(prompt, "HubPrompt")

	newBillboard(f, "QUEST BOARD", "Goals and rewards", Theme.Color.Success, o + Vector3.new(0, 12, 0), 13)
end

local function buildUpgradeShop(root)
	local f = newFolder(root, "UpgradeShop")
	local o = L.UpgradeShop

	local counter = newPart(
		f,
		"Counter",
		Vector3.new(4, 3, 12),
		CFrame.new(o + Vector3.new(0, 1.5, 0)),
		C.Wood,
		Enum.Material.WoodPlanks
	)
	for i = 1, 3 do
		local position = o + Vector3.new(-3.5, 0, -4 + (i - 1) * 4)
		newPart(
			f,
			"Pedestal" .. i,
			Vector3.new(2.2, 2.4, 2.2),
			CFrame.new(position + Vector3.new(0, 1.2, 0)),
			C.StoneRaised,
			Enum.Material.Slate
		)
		newPart(
			f,
			"Charm" .. i,
			Vector3.new(1, 1, 1),
			CFrame.new(position + Vector3.new(0, 3.1, 0)) * CFrame.Angles(0, 0.7, 0.7),
			C.BrassBright,
			Enum.Material.Neon
		)
	end
	local prompt = newPrompt(counter, "Browse", "Upgrade Shop", 0, 10)
	prompt:SetAttribute("HubObject", "UpgradeShop")
	CollectionService:AddTag(prompt, "HubPrompt")

	newBillboard(f, "UPGRADES", "Boost your adventure", Theme.Color.BrassBright, o + Vector3.new(0, 12, 0), 12)
end

local function buildPortals(root)
	local f = newFolder(root, "Portals")
	newPart(f, "PlazaFloor", Vector3.new(80, 0.3, 22), CFrame.new(0, 0.15, -86), C.GroundEdge, Enum.Material.Basalt)

	for _, def in ipairs(HubConfig.Portals) do
		local zone = ZoneConfig.Zones[def.id]
		local model = Instance.new("Model")
		model.Name = def.id
		model.Parent = f
		local base = Vector3.new(def.x, 0, def.z)
		local open = zone.unlockLevel <= 1

		local pad = newPart(
			model,
			"Pad",
			Vector3.new(10, 0.6, 6),
			CFrame.new(base + Vector3.new(0, 0.3, 0)),
			C.StoneDark,
			Enum.Material.Slate
		)
		for _, side in ipairs({ -1, 1 }) do
			newPart(
				model,
				"Pillar",
				Vector3.new(2, 12, 2),
				CFrame.new(base + Vector3.new(side * 4, 6, 0)),
				C.StoneBase,
				Enum.Material.Basalt
			)
		end
		newPart(
			model,
			"Lintel",
			Vector3.new(10.4, 1.5, 2.4),
			CFrame.new(base + Vector3.new(0, 12.6, 0)),
			C.Brass,
			Enum.Material.Metal
		)

		-- Clients restyle the surface and prompt for their own level (see client Main).
		local surface = newPart(
			model,
			"Surface",
			Vector3.new(6, 11, 0.4),
			CFrame.new(base + Vector3.new(0, 6.2, 0)),
			zone.portalColor,
			Enum.Material.Neon,
			{
				collide = false,
				transparency = if open then 0.3 else 0.8,
				shadow = false,
			}
		)
		newLight(surface, zone.portalGlow, if open then 2 else 0.4, 20)

		local prompt = newPrompt(pad, if open then "Enter" else "Locked", zone.displayName, 0.3, 10)
		prompt:SetAttribute("Portal", def.id)
		prompt:SetAttribute("UnlockLevel", zone.unlockLevel)
		CollectionService:AddTag(prompt, "Portal")

		newBillboard(
			model,
			zone.displayName:upper(),
			if open then "Open" else ("Level %d"):format(zone.unlockLevel),
			zone.portalColor,
			base + Vector3.new(0, 16, 0),
			12
		)
		model.PrimaryPart = pad
	end

	newBillboard(f, "PORTAL PLAZA", "Unlock new worlds", Theme.Color.BrassBright, Vector3.new(0, 22, -80), 15)
end

local function buildSigns(root)
	local f = newFolder(root, "Signs")

	-- Board faces +Z (back face) so players walking north from spawn can read it.
	local function groundSign(position, yaw, title, subtitle)
		newPart(
			f,
			"Post",
			Vector3.new(0.6, 5, 0.6),
			CFrame.new(position + Vector3.new(0, 2.5, 0)),
			C.WoodDark,
			Enum.Material.Wood
		)
		local board = newPart(
			f,
			"Board",
			Vector3.new(6, 2.4, 0.4),
			CFrame.new(position + Vector3.new(0, 5.2, 0)) * CFrame.Angles(0, math.rad(yaw), 0),
			C.Wood,
			Enum.Material.WoodPlanks
		)
		local gui = Instance.new("SurfaceGui")
		gui.Face = Enum.NormalId.Back
		gui.CanvasSize = Vector2.new(600, 240)
		gui.LightInfluence = 0
		gui.Parent = board

		local label = Instance.new("TextLabel")
		label.BackgroundTransparency = 1
		label.Size = UDim2.fromScale(0.9, 0.55)
		label.Position = UDim2.fromScale(0.05, 0.08)
		label.Font = Theme.Font.Title
		label.Text = title
		label.TextColor3 = C.Parchment
		label.TextScaled = true
		label.Parent = gui

		local sub = label:Clone()
		sub.Size = UDim2.fromScale(0.9, 0.28)
		sub.Position = UDim2.fromScale(0.05, 0.64)
		sub.Font = Theme.Font.Body
		sub.Text = subtitle
		sub.TextColor3 = C.Amber
		sub.Parent = gui
	end

	local s = L.Spawn
	groundSign(s + Vector3.new(-7, 0, -9), 20, "FORGE", "Straight ahead")
	groundSign(s + Vector3.new(7, 0, -9), -20, "NURSERY  ·  EGGS", "East, on your right")
	groundSign(s + Vector3.new(-13, 0, -4), 40, "QUESTS  ·  UPGRADES", "West, on your left")
	groundSign(s + Vector3.new(13, 0, -4), -40, "PORTALS", "North, past the Forge")
end

local function buildDecor(root)
	local f = newFolder(root, "Decor")

	for i, position in ipairs({
		Vector3.new(-10, 0, 46),
		Vector3.new(10, 0, 46),
		Vector3.new(-40, 0, -50),
		Vector3.new(40, 0, -50),
	}) do
		newPart(
			f,
			"LanternPole" .. i,
			Vector3.new(0.6, 10, 0.6),
			CFrame.new(position + Vector3.new(0, 5, 0)),
			C.WoodDark,
			Enum.Material.Wood
		)
		newPart(
			f,
			"LanternCap" .. i,
			Vector3.new(1.8, 0.3, 1.8),
			CFrame.new(position + Vector3.new(0, 11.6, 0)),
			C.Brass,
			Enum.Material.Metal
		)
		local glow = newPart(
			f,
			"LanternGlow" .. i,
			Vector3.new(1.2, 1.4, 1.2),
			CFrame.new(position + Vector3.new(0, 10.8, 0)),
			C.Amber,
			Enum.Material.Neon,
			{ shadow = false }
		)
		newLight(glow, C.Amber, 1.4, 18)
	end

	for i, position in ipairs({
		Vector3.new(-15, 0, 13),
		Vector3.new(-13, 0, 15.5),
		Vector3.new(16, 0, 13),
		Vector3.new(14, 0, 15.5),
	}) do
		newPart(
			f,
			"Crate" .. i,
			Vector3.new(2.4, 2.4, 2.4),
			CFrame.new(position + Vector3.new(0, 1.6, 0)) * CFrame.Angles(0, math.rad(i * 17), 0),
			C.Wood,
			Enum.Material.WoodPlanks
		)
	end

	for i, position in ipairs({
		Vector3.new(-17, 0, -6),
		Vector3.new(17, 0, -6),
		Vector3.new(-20, 0, 40),
		Vector3.new(20, 0, 40),
	}) do
		local floor = if Vector3.new(position.X, 0, position.Z).Magnitude < 30 then 0.4 else 0
		cylinder(
			f,
			"Barrel" .. i,
			3,
			2.4,
			position + Vector3.new(0, floor + 1.5, 0),
			C.WoodDark,
			Enum.Material.WoodPlanks
		)
	end

	for i, position in ipairs({ Vector3.new(-9, 0, 34), Vector3.new(9, 0, 34) }) do
		newPart(
			f,
			"BenchSeat" .. i,
			Vector3.new(4.5, 0.4, 1.4),
			CFrame.new(position + Vector3.new(0, 1.2, 0)),
			C.Wood,
			Enum.Material.WoodPlanks
		)
		for _, side in ipairs({ -1.8, 1.8 }) do
			newPart(
				f,
				"BenchLeg",
				Vector3.new(0.3, 1, 1.1),
				CFrame.new(position + Vector3.new(side, 0.5, 0)),
				C.WoodDark,
				Enum.Material.Wood
			)
		end
	end

	for i, position in ipairs({
		Vector3.new(-34, 0, 20),
		Vector3.new(34, 0, 32),
		Vector3.new(-42, 0, -22),
		Vector3.new(44, 0, -30),
	}) do
		cylinder(f, "Pot" .. i, 1.6, 1.8, position + Vector3.new(0, 0.8, 0), C.WoodDark, Enum.Material.Slate)
		newPart(
			f,
			"Plant" .. i,
			Vector3.new(2.2, 2.2, 2.2),
			CFrame.new(position + Vector3.new(0, 2.5, 0)),
			C.Leaf,
			Enum.Material.Grass,
			{ shape = Enum.PartType.Ball }
		)
	end
end

local function buildAmbient(root)
	local f = newFolder(root, "Ambient")

	local dust = Instance.new("ParticleEmitter")
	dust.Texture = "rbxasset://textures/particles/sparkles_main.dds"
	dust.Lifetime = NumberRange.new(4, 7)
	dust.Speed = NumberRange.new(0.3, 1)
	dust.Rate = 5
	dust.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0.35), NumberSequenceKeypoint.new(1, 0) })
	dust.Color = ColorSequence.new(C.Amber)
	dust.SpreadAngle = Vector2.new(180, 180)
	dust.LightEmission = 0.3
	local dustAnchor = anchorAt(f, "Dust", Vector3.new(0, 5, 20))
	dust.Parent = dustAnchor
	newLight(dustAnchor, C.Amber, 1, 50)

	local embers = Instance.new("ParticleEmitter")
	embers.Texture = "rbxasset://textures/particles/sparkles_main.dds"
	embers.Lifetime = NumberRange.new(1.5, 3)
	embers.Speed = NumberRange.new(2, 4)
	embers.Rate = 4
	embers.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0.4), NumberSequenceKeypoint.new(1, 0) })
	embers.Color = ColorSequence.new(C.Amber, C.EmberRed)
	embers.SpreadAngle = Vector2.new(50, 50)
	embers.LightEmission = 0.7
	embers.Parent = anchorAt(f, "Embers", Vector3.new(0, 20, -4))
end

function HubBuilder.Build()
	applyLighting()
	if workspace:FindFirstChild("EmberHollow") then
		return
	end
	local root = Instance.new("Folder")
	root.Name = "EmberHollow"

	buildGround(root)
	buildPaths(root)
	buildSpawn(root)
	buildForge(root)
	buildNursery(root)
	buildEggShop(root)
	buildQuestBoard(root)
	buildUpgradeShop(root)
	buildPortals(root)
	buildSigns(root)
	buildDecor(root)
	buildAmbient(root)

	root.Parent = workspace
end

return HubBuilder
