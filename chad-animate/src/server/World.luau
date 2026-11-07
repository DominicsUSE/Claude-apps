--[[
	World (ModuleScript, child of the ChadWorld Script)

	Builds ChadWorld: a test ground with one station per animation.

	  Center   spawn plaza with benches (sit), trees and lamps
	  Track    oval running track around the plaza (walk / run)
	  North    stairs up to a platform and a ramp down (foot IK)
	  East     climb tower: truss and ladder up, jump off onto sand (fall, land)
	  South    parkour blocks and a balance beam (jump)
	  West     swimming pool with steps and a truss out (swim, climb)

	World.build() replaces any previous ChadWorld. The installer runs it in
	Studio so the map is saved with the place; the server script also runs
	it at startup if the place has no ChadWorld yet.
]]

local Workspace = game:GetService("Workspace")
local Lighting = game:GetService("Lighting")
local StarterPlayer = game:GetService("StarterPlayer")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local World = {}

World.FOLDER_NAME = "ChadWorld"

World.TRACK = {
	HALF_STRAIGHT = 70, -- straights run from x = -70 to 70
	RADIUS = 48, -- centerline radius of the bends
	WIDTH = 14,
}

World.POOL = { MIN_X = -215, MAX_X = -165, MIN_Z = -30, MAX_Z = 30, DEPTH = 12 }
World.TOWER = { X = 165, Z = 0, HEIGHT = 40 }
World.PARKOUR = { X = -50, Z = 95 }

local GROUND = 512
local COLORS = {
	grass = Color3.fromRGB(96, 140, 72),
	track = Color3.fromRGB(184, 80, 58),
	line = Color3.fromRGB(245, 243, 236),
	stone = Color3.fromRGB(196, 190, 178),
	darkStone = Color3.fromRGB(120, 116, 110),
	wood = Color3.fromRGB(140, 98, 62),
	leaf = Color3.fromRGB(70, 128, 62),
	tile = Color3.fromRGB(214, 236, 242),
	sand = Color3.fromRGB(226, 205, 150),
	accent = Color3.fromRGB(242, 178, 52),
	sign = Color3.fromRGB(34, 40, 52),
	metal = Color3.fromRGB(90, 96, 108),
}

--============================================================
-- Track geometry (shared with the NPCs)
--============================================================

-- Length of one lap at `offset` studs outside the centerline.
function World.trackLength(offset)
	local r = World.TRACK.RADIUS + (offset or 0)
	return 4 * World.TRACK.HALF_STRAIGHT + 2 * math.pi * r
end

-- Point `distance` studs along the lap (south straight heading +X first).
function World.trackPoint(distance, offset)
	local half = World.TRACK.HALF_STRAIGHT
	local r = World.TRACK.RADIUS + (offset or 0)
	local straight = half * 2
	local arc = math.pi * r
	local d = distance % (2 * straight + 2 * arc)
	if d < straight then
		return Vector3.new(-half + d, 0, r)
	end
	d = d - straight
	if d < arc then
		local a = math.pi / 2 - d / r
		return Vector3.new(half + r * math.cos(a), 0, r * math.sin(a))
	end
	d = d - arc
	if d < straight then
		return Vector3.new(half - d, 0, -r)
	end
	d = d - straight
	local a = -math.pi / 2 - d / r
	return Vector3.new(-half + r * math.cos(a), 0, r * math.sin(a))
end

--============================================================
-- Builders
--============================================================

local function part(parent, props)
	local p = Instance.new(props.ClassName or "Part")
	p.Anchored = true
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	p.Material = Enum.Material.SmoothPlastic
	for key, value in pairs(props) do
		if key ~= "ClassName" then
			p[key] = value
		end
	end
	p.Parent = parent
	return p
end

local function folder(parent, name)
	local f = Instance.new("Folder")
	f.Name = name
	f.Parent = parent
	return f
end

-- A block whose top face sits at `top`, spanning x0..x1 and z0..z1.
local function slab(parent, name, x0, x1, z0, z1, top, thickness, color, material)
	return part(parent, {
		Name = name,
		Size = Vector3.new(x1 - x0, thickness, z1 - z0),
		CFrame = CFrame.new((x0 + x1) / 2, top - thickness / 2, (z0 + z1) / 2),
		Color = color,
		Material = material or Enum.Material.SmoothPlastic,
	})
end

local function sign(parent, position, title, subtitle)
	local model = Instance.new("Model")
	model.Name = "Sign"
	local facing = CFrame.lookAt(position, Vector3.new(0, position.Y, 0))
	local board = part(model, {
		Name = "Board",
		Size = Vector3.new(12, 5, 0.4),
		CFrame = facing * CFrame.new(0, 5, 0),
		Color = COLORS.sign,
	})
	for _, x in ipairs({ -4.5, 4.5 }) do
		part(model, {
			Name = "Post",
			Size = Vector3.new(0.5, 3, 0.5),
			CFrame = facing * CFrame.new(x, 1.25, 0),
			Color = COLORS.metal,
			Material = Enum.Material.Metal,
		})
	end

	local gui = Instance.new("SurfaceGui")
	gui.Face = Enum.NormalId.Front
	gui.SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud
	gui.PixelsPerStud = 40
	gui.LightInfluence = 0
	gui.Parent = board

	local function label(text, y, height, color, font)
		local l = Instance.new("TextLabel")
		l.BackgroundTransparency = 1
		l.Position = UDim2.fromScale(0.05, y)
		l.Size = UDim2.fromScale(0.9, height)
		l.Text = text
		l.TextScaled = true
		l.TextColor3 = color
		l.Font = font
		l.Parent = gui
	end
	label(title, 0.1, 0.42, COLORS.accent, Enum.Font.GothamBlack)
	label(subtitle, 0.56, 0.3, COLORS.line, Enum.Font.GothamMedium)

	model.Parent = parent
	return model
end

local function tree(parent, position, height)
	local model = Instance.new("Model")
	model.Name = "Tree"
	part(model, {
		Name = "Trunk",
		Shape = Enum.PartType.Cylinder,
		Size = Vector3.new(height, 1.6, 1.6),
		CFrame = CFrame.new(position + Vector3.new(0, height / 2, 0)) * CFrame.Angles(0, 0, math.pi / 2),
		Color = COLORS.wood,
		Material = Enum.Material.Wood,
	})
	local crowns = { { 0, 0, 0, 9 }, { 2.2, -1.2, 1.4, 6.5 }, { -2, -0.8, -1.6, 6 }, { 0.4, 2.2, -0.6, 5.5 } }
	for _, c in ipairs(crowns) do
		part(model, {
			Name = "Leaves",
			Shape = Enum.PartType.Ball,
			Size = Vector3.new(c[4], c[4], c[4]),
			CFrame = CFrame.new(position + Vector3.new(c[1], height + c[2], c[3])),
			Color = COLORS.leaf,
			Material = Enum.Material.Grass,
		})
	end
	model.Parent = parent
end

local function lamp(parent, position)
	local model = Instance.new("Model")
	model.Name = "Lamp"
	part(model, {
		Name = "Post",
		Shape = Enum.PartType.Cylinder,
		Size = Vector3.new(10, 0.6, 0.6),
		CFrame = CFrame.new(position + Vector3.new(0, 5, 0)) * CFrame.Angles(0, 0, math.pi / 2),
		Color = COLORS.metal,
		Material = Enum.Material.Metal,
	})
	local head = part(model, {
		Name = "Light",
		Shape = Enum.PartType.Ball,
		Size = Vector3.new(1.6, 1.6, 1.6),
		CFrame = CFrame.new(position + Vector3.new(0, 10.4, 0)),
		Color = Color3.fromRGB(255, 236, 190),
		Material = Enum.Material.Neon,
	})
	local light = Instance.new("PointLight")
	light.Range = 18
	light.Brightness = 1.2
	light.Color = Color3.fromRGB(255, 226, 170)
	light.Parent = head
	model.Parent = parent
end

local function bench(parent, position, faceToward)
	local model = Instance.new("Model")
	model.Name = "Bench"
	local base = CFrame.lookAt(position, Vector3.new(faceToward.X, position.Y, faceToward.Z))
	part(model, {
		ClassName = "Seat",
		Name = "Seat",
		Size = Vector3.new(5, 0.4, 1.8),
		CFrame = base * CFrame.new(0, 1.6, 0),
		Color = COLORS.wood,
		Material = Enum.Material.WoodPlanks,
	})
	part(model, {
		Name = "Back",
		Size = Vector3.new(5, 1.6, 0.3),
		CFrame = base * CFrame.new(0, 2.6, 0.85) * CFrame.Angles(-0.15, 0, 0),
		Color = COLORS.wood,
		Material = Enum.Material.WoodPlanks,
	})
	for _, x in ipairs({ -2, 2 }) do
		part(model, {
			Name = "Leg",
			Size = Vector3.new(0.4, 1.4, 1.6),
			CFrame = base * CFrame.new(x, 0.7, 0),
			Color = COLORS.metal,
			Material = Enum.Material.Metal,
		})
	end
	model.Parent = parent
end

--============================================================
-- Stations
--============================================================

local function buildGround(world)
	-- Four slabs leave a hole for the pool.
	local p = World.POOL
	local h = GROUND / 2
	local g = folder(world, "Ground")
	slab(g, "Grass", -h, p.MIN_X, -h, h, 0, 4, COLORS.grass, Enum.Material.Grass)
	slab(g, "Grass", p.MAX_X, h, -h, h, 0, 4, COLORS.grass, Enum.Material.Grass)
	slab(g, "Grass", p.MIN_X, p.MAX_X, -h, p.MIN_Z, 0, 4, COLORS.grass, Enum.Material.Grass)
	slab(g, "Grass", p.MIN_X, p.MAX_X, p.MAX_Z, h, 0, 4, COLORS.grass, Enum.Material.Grass)
end

local function buildPlaza(world)
	local plaza = folder(world, "Plaza")
	part(plaza, {
		Name = "Paving",
		Shape = Enum.PartType.Cylinder,
		Size = Vector3.new(0.2, 40, 40),
		CFrame = CFrame.new(0, 0.1, 0) * CFrame.Angles(0, 0, math.pi / 2),
		Color = COLORS.stone,
		Material = Enum.Material.Slate,
	})
	part(plaza, {
		ClassName = "SpawnLocation",
		Name = "SpawnPad",
		Size = Vector3.new(10, 0.4, 10),
		CFrame = CFrame.new(0, 0.2, 0),
		Color = COLORS.accent,
		Neutral = true,
		Duration = 0,
		AllowTeamChangeOnTouch = false,
	})

	local benches = folder(world, "Benches")
	for i = 0, 3 do
		local a = math.pi / 4 + i * math.pi / 2
		bench(benches, Vector3.new(math.cos(a) * 15, 0.2, math.sin(a) * 15), Vector3.new(0, 0, 0))
	end
	for i = 0, 3 do
		local a = i * math.pi / 2
		lamp(plaza, Vector3.new(math.cos(a) * 19, 0.2, math.sin(a) * 19))
	end

	sign(plaza, Vector3.new(0, 0.2, -12), "CHAD WORLD", "WASD to walk, hold SHIFT to run")
end

local function buildTrack(world)
	local t = World.TRACK
	local track = folder(world, "Track")
	local half, r, w = t.HALF_STRAIGHT, t.RADIUS, t.WIDTH
	local inner, outer = r - w / 2, r + w / 2
	local lines = { inner + 0.2, r, outer - 0.2 }

	for _, side in ipairs({ -1, 1 }) do
		slab(track, "Straight", -half, half, side * r - w / 2, side * r + w / 2, 0.1, 0.1, COLORS.track)
		for _, lr in ipairs(lines) do
			slab(track, "Line", -half, half, side * lr - 0.15, side * lr + 0.15, 0.12, 0.1, COLORS.line)
		end
	end

	local segments = 24
	for _, cx in ipairs({ -half, half }) do
		local start = (cx > 0) and -math.pi / 2 or math.pi / 2
		for i = 0, segments - 1 do
			local a = start + (i + 0.5) * math.pi / segments
			local spin = CFrame.Angles(0, -a, 0)
			part(track, {
				Name = "Bend",
				Size = Vector3.new(w, 0.1, outer * math.pi / segments * 1.06),
				CFrame = CFrame.new(cx + r * math.cos(a), 0.05, r * math.sin(a)) * spin,
				Color = COLORS.track,
			})
			for _, lr in ipairs(lines) do
				part(track, {
					Name = "Line",
					Size = Vector3.new(0.3, 0.1, lr * math.pi / segments * 1.04),
					CFrame = CFrame.new(cx + lr * math.cos(a), 0.07, lr * math.sin(a)) * spin,
					Color = COLORS.line,
				})
			end
		end
	end
	slab(track, "StartLine", -0.6, 0.6, inner, outer, 0.13, 0.1, COLORS.line)

	sign(track, Vector3.new(-30, 0.2, outer + 8), "TRACK", "Walk, then hold SHIFT to run")
end

local function buildStairs(world)
	local z0, z1 = -103, -87
	local s = folder(world, "StairsAndRamp")
	for i = 1, 14 do
		local x0 = -36 + (i - 1) * 2
		slab(s, "Step", x0, x0 + 2, z0, z1, i, i, COLORS.stone, Enum.Material.Concrete)
	end
	slab(s, "Platform", -8, 8, z0, z1, 14, 14, COLORS.darkStone, Enum.Material.Concrete)

	-- Ramp: a slab tilted down from the platform edge to the ground.
	local run, rise = 42, 14
	local angle = math.atan2(rise, run)
	part(s, {
		Name = "Ramp",
		Size = Vector3.new(math.sqrt(run * run + rise * rise), 1, z1 - z0),
		CFrame = CFrame.new(8 + run / 2, rise / 2, (z0 + z1) / 2) * CFrame.Angles(0, 0, -angle) * CFrame.new(0, -0.5, 0),
		Color = COLORS.stone,
		Material = Enum.Material.Concrete,
	})

	sign(s, Vector3.new(-48, 0.2, -80), "STAIRS & RAMP", "Feet plant on every step")
end

local function buildTower(world)
	local t = World.TOWER
	local tower = folder(world, "ClimbTower")
	local h = t.HEIGHT
	local x0 = t.X - 6

	slab(tower, "Top", x0, x0 + 12, t.Z - 6, t.Z + 6, h, 1, COLORS.darkStone, Enum.Material.DiamondPlate)
	for _, c in ipairs({ { 1, 1 }, { 11, 1 }, { 1, 11 }, { 11, 11 } }) do
		slab(tower, "Pillar", x0 + c[1] - 0.5, x0 + c[1] + 0.5, t.Z - 6 + c[2] - 0.5, t.Z - 6 + c[2] + 0.5,
			h - 1, h - 1, COLORS.metal, Enum.Material.Metal)
	end

	-- Climbable truss and a rung ladder on the face toward the spawn.
	part(tower, {
		ClassName = "TrussPart",
		Name = "Truss",
		Size = Vector3.new(2, h, 2),
		CFrame = CFrame.new(x0 - 1, h / 2, t.Z - 3),
		Color = COLORS.accent,
	})
	for _, dz in ipairs({ 1.6, 4.4 }) do
		slab(tower, "Rail", x0 - 0.6, x0, t.Z + dz - 0.2, t.Z + dz + 0.2, h + 3, h + 3, COLORS.metal, Enum.Material.Metal)
	end
	for y = 1, h, 1.2 do
		slab(tower, "Rung", x0 - 0.5, x0 - 0.1, t.Z + 1.6, t.Z + 4.4, y + 0.2, 0.25, COLORS.metal, Enum.Material.Metal)
	end

	-- Jump off the east edge onto the sand.
	slab(tower, "LandingSand", x0 + 14, x0 + 40, t.Z - 14, t.Z + 14, 0.15, 0.15, COLORS.sand, Enum.Material.Sand)

	sign(tower, Vector3.new(x0 - 14, 0.2, t.Z + 14), "CLIMB TOWER", "Climb up, jump off, land")
end

local function buildParkour(world)
	local p = World.PARKOUR
	local course = folder(world, "Parkour")
	for i = 0, 5 do
		local x = p.X + i * 10
		local top = 2 + i * 2
		slab(course, "Block", x - 3, x + 3, p.Z - 3, p.Z + 3, top, top, COLORS.stone, Enum.Material.Concrete)
	end
	local beamStart = p.X + 53
	slab(course, "Beam", beamStart, beamStart + 30, p.Z - 0.6, p.Z + 0.6, 12, 0.8, COLORS.wood, Enum.Material.Wood)
	slab(course, "Finish", beamStart + 30, beamStart + 38, p.Z - 4, p.Z + 4, 12, 12, COLORS.darkStone, Enum.Material.Concrete)
	slab(course, "LandingSand", beamStart + 40, beamStart + 56, p.Z - 8, p.Z + 8, 0.15, 0.15, COLORS.sand, Enum.Material.Sand)

	sign(course, Vector3.new(p.X - 14, 0.2, p.Z - 12), "PARKOUR", "Jump, fall and land")
end

local function buildPool(world)
	local p = World.POOL
	local pool = folder(world, "Pool")
	local d = p.DEPTH

	slab(pool, "Floor", p.MIN_X, p.MAX_X, p.MIN_Z, p.MAX_Z, -d, 2, COLORS.tile)
	slab(pool, "Wall", p.MIN_X - 2, p.MIN_X, p.MIN_Z - 2, p.MAX_Z + 2, 0, d + 1, COLORS.tile)
	slab(pool, "Wall", p.MAX_X, p.MAX_X + 2, p.MIN_Z - 2, p.MAX_Z + 2, 0, d + 1, COLORS.tile)
	slab(pool, "Wall", p.MIN_X, p.MAX_X, p.MIN_Z - 2, p.MIN_Z, 0, d + 1, COLORS.tile)
	slab(pool, "Wall", p.MIN_X, p.MAX_X, p.MAX_Z, p.MAX_Z + 2, 0, d + 1, COLORS.tile)
	for _, edge in ipairs({
		{ p.MIN_X - 3, p.MAX_X + 3, p.MIN_Z - 3, p.MIN_Z },
		{ p.MIN_X - 3, p.MAX_X + 3, p.MAX_Z, p.MAX_Z + 3 },
		{ p.MIN_X - 3, p.MIN_X, p.MIN_Z, p.MAX_Z },
		{ p.MAX_X, p.MAX_X + 3, p.MIN_Z, p.MAX_Z },
	}) do
		slab(pool, "Coping", edge[1], edge[2], edge[3], edge[4], 0.15, 0.15, COLORS.line)
	end

	-- Steps down from the east edge, a truss up the west wall.
	for i = 1, d - 1 do
		local x1 = p.MAX_X - (i - 1) * 2
		slab(pool, "Step", x1 - 2, x1, -5, 5, -i, d - i, COLORS.tile)
	end
	part(pool, {
		ClassName = "TrussPart",
		Name = "Truss",
		Size = Vector3.new(2, d, 2),
		CFrame = CFrame.new(p.MIN_X + 1, -d / 2, 0),
		Color = COLORS.accent,
	})

	-- Terrain water, from the floor to one stud below the edge.
	local terrain = Workspace.Terrain
	local center = CFrame.new((p.MIN_X + p.MAX_X) / 2, -d / 2, (p.MIN_Z + p.MAX_Z) / 2)
	terrain:FillBlock(center, Vector3.new(p.MAX_X - p.MIN_X + 8, d + 8, p.MAX_Z - p.MIN_Z + 8), Enum.Material.Air)
	terrain:FillBlock(center * CFrame.new(0, -0.5, 0), Vector3.new(p.MAX_X - p.MIN_X, d - 1, p.MAX_Z - p.MIN_Z), Enum.Material.Water)

	sign(pool, Vector3.new(p.MAX_X + 14, 0.2, p.MAX_Z + 6), "POOL", "Swim, then climb the truss out")
end

local function buildScenery(world)
	local scenery = folder(world, "Scenery")
	-- Infield ring.
	for i = 0, 7 do
		local a = i * math.pi / 4 + math.pi / 8
		tree(scenery, Vector3.new(math.cos(a) * 30, 0, math.sin(a) * 26), 9 + (i % 3))
	end
	-- Outer trees on a fixed pseudo-random scatter, kept clear of stations.
	local clear = {
		{ -50, 60, -120, -70 }, -- stairs and ramp
		{ 140, 215, -30, 30 }, -- tower and sand
		{ -70, 70, 80, 115 }, -- parkour
		{ -230, -150, -45, 45 }, -- pool
		{ -130, 130, -65, 65 }, -- track
	}
	local seed = 7
	local placed = 0
	while placed < 26 do
		seed = (seed * 16807) % 2147483647
		local x = (seed % 440) - 220
		seed = (seed * 16807) % 2147483647
		local z = (seed % 440) - 220
		local ok = true
		for _, c in ipairs(clear) do
			if x > c[1] - 6 and x < c[2] + 6 and z > c[3] - 6 and z < c[4] + 6 then
				ok = false
			end
		end
		if ok then
			placed = placed + 1
			tree(scenery, Vector3.new(x, 0, z), 9 + (seed % 5))
		end
	end
end

local function setupLighting()
	for _, object in ipairs(Lighting:GetChildren()) do
		if object:IsA("Sky") or object:IsA("Atmosphere") or object:IsA("PostEffect") then
			object:Destroy()
		end
	end
	Lighting.ClockTime = 14.5
	Lighting.Brightness = 2.6
	Lighting.GlobalShadows = true
	Lighting.ShadowSoftness = 0.25
	Lighting.EnvironmentDiffuseScale = 1
	Lighting.EnvironmentSpecularScale = 1
	Lighting.Ambient = Color3.fromRGB(70, 74, 82)
	Lighting.OutdoorAmbient = Color3.fromRGB(128, 132, 140)

	Instance.new("Sky").Parent = Lighting

	local atmosphere = Instance.new("Atmosphere")
	atmosphere.Density = 0.28
	atmosphere.Offset = 0.1
	atmosphere.Color = Color3.fromRGB(199, 214, 230)
	atmosphere.Decay = Color3.fromRGB(106, 120, 140)
	atmosphere.Glare = 0.2
	atmosphere.Haze = 1.2
	atmosphere.Parent = Lighting

	local bloom = Instance.new("BloomEffect")
	bloom.Intensity = 0.5
	bloom.Size = 24
	bloom.Threshold = 1.4
	bloom.Parent = Lighting

	local rays = Instance.new("SunRaysEffect")
	rays.Intensity = 0.05
	rays.Spread = 0.6
	rays.Parent = Lighting

	local grade = Instance.new("ColorCorrectionEffect")
	grade.Saturation = 0.08
	grade.Contrast = 0.05
	grade.Parent = Lighting

	local terrain = Workspace.Terrain
	local clouds = terrain:FindFirstChildOfClass("Clouds") or Instance.new("Clouds")
	clouds.Cover = 0.55
	clouds.Density = 0.7
	clouds.Parent = terrain
	terrain.WaterColor = Color3.fromRGB(40, 150, 190)
	terrain.WaterTransparency = 0.6
	terrain.WaterWaveSize = 0.08
end

--============================================================
-- Entry point
--============================================================

function World.build()
	local old = Workspace:FindFirstChild(World.FOLDER_NAME)
	if old then
		old:Destroy()
	end
	-- A fresh Baseplate place has its own floor and spawn at the root.
	for _, object in ipairs(Workspace:GetChildren()) do
		if object.Name == "Baseplate" or object:IsA("SpawnLocation") then
			object:Destroy()
		end
	end

	local world = Instance.new("Folder")
	world.Name = World.FOLDER_NAME

	buildGround(world)
	buildPlaza(world)
	buildTrack(world)
	buildStairs(world)
	buildTower(world)
	buildParkour(world)
	buildPool(world)
	buildScenery(world)
	setupLighting()

	world.Parent = Workspace

	local config = ReplicatedStorage:FindFirstChild("ChadConfig")
	if config then
		StarterPlayer.CharacterWalkSpeed = require(config).WALK_SPEED
	end
	return world
end

return World
