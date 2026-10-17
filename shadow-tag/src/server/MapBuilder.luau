--!strict
-- Builds the abandoned subway station from code so the whole map lives in
-- source control and stays in sync with Zones.luau.
--
-- Layout (top-down, +X east, +Z north, main floor at Y = 0):
--
--            [Street Hall Y=40]
--                   |  stairs + escalator shaft
--   W-B ---- W-C ---- [Concourse] ---- svc ---- [Maintenance] ---- E-C ---- E-B
--    |                     |                          |                       |
--   W-A ----------- [ Central Platform ] ---- door ---+------------------- E-A
--                     [ track pit + last train ] ---> exit tunnel
--
-- Walls are centred on their boundary line (thickness T) and openings are
-- given as {from, to, height?}; an opening without height runs full height.

local CollectionService = game:GetService("CollectionService")
local Workspace = game:GetService("Workspace")

local T = 2

local C = {
	tile = Color3.fromRGB(188, 192, 182),
	tileDirty = Color3.fromRGB(140, 146, 134),
	cream = Color3.fromRGB(196, 186, 160),
	concrete = Color3.fromRGB(84, 84, 88),
	concreteDark = Color3.fromRGB(56, 56, 60),
	ceiling = Color3.fromRGB(44, 44, 48),
	floorWet = Color3.fromRGB(60, 62, 66),
	safety = Color3.fromRGB(222, 180, 40),
	metal = Color3.fromRGB(92, 96, 100),
	rust = Color3.fromRGB(112, 74, 50),
	wood = Color3.fromRGB(118, 88, 58),
	pipe = Color3.fromRGB(64, 74, 76),
	black = Color3.fromRGB(18, 18, 20),
	fixtureOn = Color3.fromRGB(232, 240, 255),
	fixtureOff = Color3.fromRGB(66, 68, 72),
	emergency = Color3.fromRGB(255, 40, 30),
	trainBody = Color3.fromRGB(168, 172, 178),
	trainStripe = Color3.fromRGB(176, 38, 38),
	glass = Color3.fromRGB(110, 130, 140),
	warm = Color3.fromRGB(255, 214, 160),
	moon = Color3.fromRGB(120, 150, 255),
}

export type WallStyle = { color: Color3, material: Enum.Material, stripe: Color3? }
export type TrainDoor = {
	left: BasePart,
	right: BasePart,
	leftClosed: CFrame,
	rightClosed: CFrame,
	lamp: BasePart,
	prompt: BasePart,
}
export type TrainRefs = {
	model: Model,
	doors: { TrainDoor },
	seats: { Seat },
	horn: BasePart,
}
export type Refs = {
	folder: Folder,
	fixtures: { [string]: { BasePart } },
	emergency: { [string]: { BasePart } },
	powered: { [string]: { BasePart } },
	breakers: { [string]: { box: BasePart, lamp: BasePart } },
	train: TrainRefs,
	pickups: { Vector3 },
	lobbySpawn: CFrame,
	survivorSpawns: { CFrame },
	shadowSpawns: { CFrame },
	patrolPoints: { Vector3 },
}

local MapBuilder = {}
MapBuilder.Palette = C

local rng = Random.new()
local F: { [string]: Instance } = {}
local refs: Refs

-- Primitive helpers -----------------------------------------------------------

local function make(className: string, size: Vector3, cf: CFrame, color: Color3, material: Enum.Material, parent: Instance, name: string?): BasePart
	local p = Instance.new(className) :: BasePart
	p.Name = name or className
	p.Anchored = true
	p.Size = size
	p.CFrame = cf
	p.Color = color
	p.Material = material
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	p.Parent = parent
	return p
end

local function box(parent: Instance, size: Vector3, cf: CFrame, color: Color3, material: Enum.Material?, name: string?): BasePart
	return make("Part", size, cf, color, material or Enum.Material.Concrete, parent, name)
end

-- Axis-aligned block from bounds.
local function slab(
	parent: Instance,
	x1: number,
	x2: number,
	y1: number,
	y2: number,
	z1: number,
	z2: number,
	color: Color3,
	material: Enum.Material?,
	name: string?
): BasePart
	return box(
		parent,
		Vector3.new(math.abs(x2 - x1), math.abs(y2 - y1), math.abs(z2 - z1)),
		CFrame.new((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2),
		color,
		material,
		name
	)
end

local function decor(p: BasePart): BasePart
	p.CastShadow = false
	return p
end

local function ghost(p: BasePart): BasePart
	p.CanCollide = false
	p.CanTouch = false
	p.CastShadow = false
	return p
end

local function wall(parent: Instance, axis: "X" | "Z", line: number, a1: number, a2: number, y0: number, h: number, openings: { { number } }?, style: WallStyle)
	a1 -= T / 2
	a2 += T / 2
	local ops = table.clone(openings or {})
	table.sort(ops, function(p, q)
		return p[1] < q[1]
	end)

	local function piece(b1: number, b2: number, yA: number, yB: number, withStripe: boolean)
		if b2 - b1 < 0.05 or yB - yA < 0.05 then
			return
		end
		if axis == "X" then
			slab(parent, b1, b2, yA, yB, line - T / 2, line + T / 2, style.color, style.material, "Wall")
		else
			slab(parent, line - T / 2, line + T / 2, yA, yB, b1, b2, style.color, style.material, "Wall")
		end
		local stripe = style.stripe
		if withStripe and stripe and yB - yA > 6 then
			local s1, s2 = yA + 4, yA + 5.2
			local d = T / 2 + 0.12
			local p = if axis == "X"
				then slab(parent, b1, b2, s1, s2, line - d, line + d, stripe, Enum.Material.CeramicTiles, "Stripe")
				else slab(parent, line - d, line + d, s1, s2, b1, b2, stripe, Enum.Material.CeramicTiles, "Stripe")
			decor(p)
		end
	end

	local cursor = a1
	for _, o in ops do
		piece(cursor, o[1], y0, y0 + h, true)
		local top = o[3]
		if top and top < h then
			piece(o[1], o[2], y0 + top, y0 + h, false)
		end
		cursor = o[2]
	end
	piece(cursor, a2, y0, y0 + h, true)
end

local function room(x1: number, x2: number, z1: number, z2: number, y0: number, h: number, floorColor: Color3, floorMat: Enum.Material)
	slab(F.Structure, x1, x2, y0 - 2, y0, z1, z2, floorColor, floorMat, "Floor")
	slab(F.Structure, x1, x2, y0 + h, y0 + h + 2, z1, z2, C.ceiling, Enum.Material.Concrete, "Ceiling")
end

local function addLabel(p: BasePart, text: string, fg: Color3, face: Enum.NormalId)
	local gui = Instance.new("SurfaceGui")
	gui.Face = face
	gui.SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud
	gui.PixelsPerStud = 30
	gui.LightInfluence = 0.55 -- signs dim with the lights but stay readable
	gui.Parent = p
	local label = Instance.new("TextLabel")
	label.Size = UDim2.fromScale(1, 1)
	label.BackgroundTransparency = 1
	label.Text = text
	label.TextColor3 = fg
	label.TextScaled = true
	label.Font = Enum.Font.GothamBlack
	label.Parent = gui
end

-- A flat sign whose front faces `facing`.
local function sign(text: string, pos: Vector3, facing: Vector3, size: Vector2, bg: Color3, fg: Color3, bothSides: boolean?): BasePart
	local p = ghost(box(F.Props, Vector3.new(size.X, size.Y, 0.3), CFrame.lookAt(pos, pos + facing), bg, Enum.Material.SmoothPlastic, "Sign"))
	addLabel(p, text, fg, Enum.NormalId.Front)
	if bothSides then
		addLabel(p, text, fg, Enum.NormalId.Back)
	end
	return p
end

local function pipe(from: Vector3, to: Vector3, d: number, color: Color3?)
	local len = (to - from).Magnitude
	local p = box(
		F.Props,
		Vector3.new(len, d, d),
		CFrame.lookAt((from + to) / 2, to) * CFrame.Angles(0, math.rad(90), 0),
		color or C.pipe,
		Enum.Material.Metal,
		"Pipe"
	)
	p.Shape = Enum.PartType.Cylinder
	decor(p)
end

local function crate(x: number, y: number, z: number, s: number?)
	local size = s or rng:NextNumber(3.5, 5.5)
	local p = box(
		F.Props,
		Vector3.new(size, size, size),
		CFrame.new(x, y + size / 2, z) * CFrame.Angles(0, math.rad(rng:NextNumber(-20, 20)), 0),
		C.wood,
		Enum.Material.WoodPlanks,
		"Crate"
	)
	p.CastShadow = true
end

local function crateStack(x: number, y: number, z: number)
	crate(x, y, z, 5)
	crate(x + 5.2, y, z + rng:NextNumber(-0.5, 0.5), 4.5)
	crate(x + 2.5, y + 5, z, 4)
end

local function puddle(x: number, y: number, z: number, w: number, d: number)
	local p = ghost(
		box(
			F.Props,
			Vector3.new(w, 0.06, d),
			CFrame.new(x, y + 0.03, z) * CFrame.Angles(0, math.rad(rng:NextNumber(0, 180)), 0),
			Color3.fromRGB(24, 32, 40),
			Enum.Material.Glass,
			"Puddle"
		)
	)
	p.Transparency = 0.35
	p.Reflectance = 0.25
end

local function dripPoint(pos: Vector3)
	local p = ghost(box(F.Audio, Vector3.one, CFrame.new(pos), C.black, Enum.Material.SmoothPlastic, "DripPoint"))
	p.Transparency = 1
	CollectionService:AddTag(p, "DripPoint")
end

local function fixture(zone: string, pos: Vector3, yaw: number?)
	local p =
		ghost(box(F.Lights, Vector3.new(6, 0.4, 1.4), CFrame.new(pos) * CFrame.Angles(0, math.rad(yaw or 0), 0), C.fixtureOn, Enum.Material.Neon, "Fixture"))
	local light = Instance.new("SurfaceLight")
	light.Face = Enum.NormalId.Bottom
	light.Angle = 80
	light.Range = 28 -- reaches the floor from the 20-stud platform ceiling
	light.Brightness = 1.6
	light.Color = Color3.fromRGB(222, 230, 255)
	light.Shadows = false
	light.Parent = p
	-- Some tubes are long dead, some buzz and flicker; the rest hold steady.
	local dead = rng:NextNumber() < 0.2
	p:SetAttribute("Zone", zone)
	p:SetAttribute("Dead", dead)
	p:SetAttribute("Flicker", not dead and rng:NextNumber() < 0.35)
	CollectionService:AddTag(p, "LightFixture")
	table.insert(refs.fixtures[zone], p)
end

local function pendant(zone: string, pos: Vector3, ceilingY: number)
	fixture(zone, pos)
	ghost(box(F.Lights, Vector3.new(0.25, ceilingY - pos.Y, 0.25), CFrame.new(pos.X, (ceilingY + pos.Y) / 2, pos.Z), C.black, Enum.Material.Metal, "Rod"))
end

local function emergency(zone: string, pos: Vector3, facing: Vector3)
	local p = ghost(box(F.Lights, Vector3.new(1.4, 0.7, 0.6), CFrame.lookAt(pos, pos + facing), C.fixtureOff, Enum.Material.SmoothPlastic, "Emergency"))
	local light = Instance.new("PointLight")
	light.Color = C.emergency
	light.Range = 22
	light.Brightness = 1.2
	light.Shadows = false
	light.Enabled = false
	light.Parent = p
	p:SetAttribute("Zone", zone)
	table.insert(refs.emergency[zone], p)
end

-- Always-on red warning lamp (train, breaker room); clients pulse it.
local function warning(pos: Vector3)
	local p = ghost(box(F.Lights, Vector3.new(1, 1, 1), CFrame.new(pos), C.emergency, Enum.Material.Neon, "WarningLamp"))
	p.Shape = Enum.PartType.Ball
	local light = Instance.new("PointLight")
	light.Color = C.emergency
	light.Range = 18
	light.Brightness = 1.5
	light.Shadows = false
	light.Parent = p
	CollectionService:AddTag(p, "WarningLight")
end

-- Neon panels (vending machines, ticket screens) that die with their zone.
local function powered(zone: string, p: BasePart)
	p.Material = Enum.Material.Neon
	p:SetAttribute("Zone", zone)
	p:SetAttribute("OnColor", p.Color)
	table.insert(refs.powered[zone], p)
end

local function bench(x: number, z: number, yaw: number)
	local base = CFrame.new(x, 0, z) * CFrame.Angles(0, math.rad(yaw), 0)
	decor(box(F.Props, Vector3.new(7, 0.5, 2), base * CFrame.new(0, 1.8, 0), C.wood, Enum.Material.Wood, "BenchSeat"))
	decor(box(F.Props, Vector3.new(7, 2, 0.4), base * CFrame.new(0, 3, 0.9), C.wood, Enum.Material.Wood, "BenchBack"))
	for _, dx in { -3, 3 } do
		decor(box(F.Props, Vector3.new(0.4, 1.6, 1.8), base * CFrame.new(dx, 0.8, 0), C.metal, Enum.Material.Metal, "BenchLeg"))
	end
end

local function vending(zone: string, x: number, z: number, facing: Vector3, hue: Color3)
	local pos = Vector3.new(x, 3.6, z)
	local cf = CFrame.lookAt(pos, pos + facing)
	box(F.Props, Vector3.new(4.4, 7.2, 2.8), cf, Color3.fromRGB(40, 44, 52), Enum.Material.Metal, "Vending")
	local panel = ghost(box(F.Props, Vector3.new(3.2, 4.6, 0.2), cf * CFrame.new(0, 0.6, -1.45), hue, Enum.Material.Neon, "VendingPanel"))
	powered(zone, panel)
end

local function pickup(pos: Vector3)
	table.insert(refs.pickups, pos)
end

-- Areas -------------------------------------------------------------------------

local TILE: WallStyle = { color = C.tile, material = Enum.Material.CeramicTiles, stripe = Color3.fromRGB(28, 110, 112) }
local TILE_DIRTY: WallStyle = { color = C.tileDirty, material = Enum.Material.CeramicTiles }
local CREAM: WallStyle = { color = C.cream, material = Enum.Material.CeramicTiles, stripe = Color3.fromRGB(150, 120, 50) }
local CONCRETE: WallStyle = { color = C.concrete, material = Enum.Material.Concrete }
local HAZARD: WallStyle = { color = Color3.fromRGB(96, 98, 92), material = Enum.Material.Concrete, stripe = C.safety }

local function buildPlatform()
	local S = F.Structure
	slab(S, -120, 120, -6, 0, 0, 60, C.floorWet, Enum.Material.Slate, "PlatformFloor")
	slab(S, -120, 120, -8, -6, -28, 0, C.concreteDark, Enum.Material.Concrete, "TrackBed")
	slab(S, -120, 120, 20, 22, -28, 60, C.ceiling, Enum.Material.Concrete, "Ceiling")
	ghost(slab(F.Props, -120, 120, 0, 0.06, 0.4, 1.8, C.safety, Enum.Material.SmoothPlastic, "SafetyLine"))

	wall(S, "X", 60, -120, 120, 0, 20, { { -60, -36, 12 }, { -10, 14, 12 }, { 88, 102, 10 } }, TILE)
	wall(S, "X", -28, -120, 120, -6, 26, nil, TILE_DIRTY)
	wall(S, "Z", -120, 0, 60, 0, 20, { { 18, 38, 12 } }, TILE)
	wall(S, "Z", -120, -28, 0, -6, 26, nil, TILE_DIRTY)
	wall(S, "Z", 120, 0, 60, 0, 20, { { 18, 38, 12 } }, TILE)
	wall(S, "Z", 120, -28, 0, -6, 26, { { -26, -2, 18 } }, TILE_DIRTY)

	-- Tracks: the last train sits on the north track (z = -6).
	for _, zc in { -6, -20 } do
		local xEnd = if zc == -6 then 560 else 120
		for _, off in { -2.4, 2.4 } do
			ghost(slab(F.Props, -120, xEnd, -6, -5.4, zc + off - 0.25, zc + off + 0.25, C.metal, Enum.Material.Metal, "Rail"))
		end
		for x = -116, 116, 8 do
			ghost(slab(F.Props, x - 0.8, x + 0.8, -6, -5.75, zc - 3.6, zc + 3.6, C.wood, Enum.Material.WoodPlanks, "Sleeper"))
		end
	end

	-- Climbable trusses out of the track pit.
	for _, x in { -105, -60, -10 } do
		make("TrussPart", Vector3.new(2, 6, 2), CFrame.new(x, -3, -1), C.metal, Enum.Material.Metal, F.Props, "PitLadder")
	end

	-- Blocked west track tunnel: rubble and boards.
	for i = 1, 9 do
		local s = rng:NextNumber(3, 7)
		box(
			F.Props,
			Vector3.new(s, s * 0.7, s),
			CFrame.new(-116 + rng:NextNumber(-2, 4), -6 + s * 0.3, rng:NextNumber(-25, -3))
				* CFrame.Angles(rng:NextNumber(-0.5, 0.5), rng:NextNumber(0, 3), rng:NextNumber(-0.5, 0.5)),
			C.concreteDark,
			Enum.Material.Slate,
			"Rubble"
		)
		if i <= 4 then
			decor(
				box(
					F.Props,
					Vector3.new(0.5, 1.2, 24),
					CFrame.new(-118.6, -2 + i * 2.6, -14) * CFrame.Angles(math.rad(rng:NextNumber(-6, 6)), 0, 0),
					C.wood,
					Enum.Material.WoodPlanks,
					"Board"
				)
			)
		end
	end
	sign("TUNNEL CLOSED", Vector3.new(-118.7, 9, -14), Vector3.new(1, 0, 0), Vector2.new(14, 3), C.safety, C.black)

	-- Pillars, lights, emergency lamps.
	for _, x in { -100, -60, -20, 20, 60, 100 } do
		for _, z in { 18, 44 } do
			slab(F.Structure, x - 1.5, x + 1.5, 0, 20, z - 1.5, z + 1.5, C.tileDirty, Enum.Material.CeramicTiles, "Pillar")
		end
		fixture("Platform", Vector3.new(x, 19.6, 8))
		fixture("Platform", Vector3.new(x, 19.6, 34))
	end
	emergency("Platform", Vector3.new(-80, 14, 58.6), Vector3.new(0, 0, -1))
	emergency("Platform", Vector3.new(60, 14, 58.6), Vector3.new(0, 0, -1))
	emergency("Platform", Vector3.new(-60, 12, -26.6), Vector3.new(0, 0, 1))
	emergency("Platform", Vector3.new(40, 12, -26.6), Vector3.new(0, 0, 1))

	-- Furniture.
	for _, x in { -80, -40, 0 } do
		bench(x, 30, 0)
	end
	bench(80, 52, 180)
	vending("Platform", -110, 57, Vector3.new(0, 0, -1), Color3.fromRGB(80, 160, 255))
	vending("Platform", -25, 57, Vector3.new(0, 0, -1), Color3.fromRGB(255, 90, 90))
	vending("Platform", 60, 57, Vector3.new(0, 0, -1), Color3.fromRGB(120, 255, 160))
	crateStack(-114, 0, 50)
	crate(-112, 0, 6)
	crate(112, 0, 52)
	for _, x in { -50, 30, 105 } do
		decor(box(F.Props, Vector3.new(2, 3, 2), CFrame.new(x, 1.5, 55), C.concreteDark, Enum.Material.Metal, "Bin"))
	end
	puddle(-70, 0, 22, 9, 5)
	puddle(30, 0, 48, 7, 4)
	puddle(-40, -6, -16, 10, 6)
	puddle(90, 0, 10, 6, 4)

	-- Signs and departure board.
	sign("PLATFORM 1  -  EASTBOUND", Vector3.new(-60, 15.5, 31), Vector3.new(0, 0, 1), Vector2.new(22, 3), C.black, C.fixtureOn, true)
	sign("CONCOURSE  /  EXIT", Vector3.new(-48, 14, 58.7), Vector3.new(0, 0, -1), Vector2.new(20, 2.5), Color3.fromRGB(20, 60, 120), C.fixtureOn)
	sign("CONCOURSE", Vector3.new(2, 14, 58.7), Vector3.new(0, 0, -1), Vector2.new(20, 2.5), Color3.fromRGB(20, 60, 120), C.fixtureOn)
	sign("MAINTENANCE", Vector3.new(95, 12, 58.7), Vector3.new(0, 0, -1), Vector2.new(13, 2), C.safety, C.black)
	sign("<  WEST TUNNEL", Vector3.new(-118.7, 14, 28), Vector3.new(1, 0, 0), Vector2.new(18, 2.5), Color3.fromRGB(30, 70, 150), C.fixtureOn)
	sign("EAST TUNNEL  >", Vector3.new(118.7, 14, 28), Vector3.new(-1, 0, 0), Vector2.new(18, 2.5), Color3.fromRGB(170, 90, 20), C.fixtureOn)
	warning(Vector3.new(40, 17.5, 2))
	warning(Vector3.new(100, 17.5, 2))
	sign("LAST TRAIN", Vector3.new(70, 15, 4), Vector3.new(0, 0, 1), Vector2.new(14, 2.5), C.trainStripe, C.fixtureOn, true)

	local board = decor(box(F.Props, Vector3.new(18, 5, 0.8), CFrame.new(0, 15, 24), C.black, Enum.Material.Metal, "DepartureBoard"))
	ghost(box(F.Props, Vector3.new(0.3, 5, 0.3), CFrame.new(-7, 19.5, 24), C.metal, Enum.Material.Metal, "BoardRod"))
	ghost(box(F.Props, Vector3.new(0.3, 5, 0.3), CFrame.new(7, 19.5, 24), C.metal, Enum.Material.Metal, "BoardRod"))
	for _, face in { Enum.NormalId.Front, Enum.NormalId.Back } do
		local gui = Instance.new("SurfaceGui")
		gui.Name = "Board" .. face.Name
		gui.Face = face
		gui.SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud
		gui.PixelsPerStud = 40
		gui.LightInfluence = 0
		gui.Brightness = 1.4
		gui.Parent = board
		local function line(name: string, text: string, y: number, h: number, color: Color3)
			local label = Instance.new("TextLabel")
			label.Name = name
			label.BackgroundTransparency = 1
			label.Position = UDim2.fromScale(0.04, y)
			label.Size = UDim2.fromScale(0.92, h)
			label.Font = Enum.Font.Code
			label.TextScaled = true
			label.TextXAlignment = Enum.TextXAlignment.Left
			label.TextColor3 = color
			label.Text = text
			label.Parent = gui
		end
		line("Title", "LAST TRAIN  -  EASTBOUND", 0.06, 0.28, Color3.fromRGB(255, 190, 60))
		line("Time", "DEPARTS  --:--", 0.38, 0.3, Color3.fromRGB(255, 220, 120))
		line("Status", "NOT IN SERVICE", 0.7, 0.24, Color3.fromRGB(255, 80, 60))
	end
	CollectionService:AddTag(board, "DepartureBoard")

	pickup(Vector3.new(-90, 1.5, 52))
	pickup(Vector3.new(35, 1.5, 50))
	dripPoint(Vector3.new(-40, 18, -15))
	dripPoint(Vector3.new(50, 18, 40))
end

local function buildConcourse()
	local S = F.Structure
	room(-70, 30, 60, 140, 0, 18, C.concrete, Enum.Material.Slate)
	wall(S, "Z", -70, 60, 140, 0, 18, { { 110, 130, 14 } }, CREAM)
	wall(S, "Z", 30, 60, 140, 0, 18, { { 100, 114, 10 } }, CREAM)
	wall(S, "X", 140, -70, 30, 0, 18, { { -64, -6 } }, CREAM)
	wall(S, "X", 140, -64, -6, 18, 40, nil, CONCRETE) -- closes the shaft face above the concourse ceiling

	-- Turnstile line: a choke point with one broken gate.
	for i = 0, 16 do
		local x = -66 + i * 5.6
		box(F.Props, Vector3.new(1.4, 3.6, 3.2), CFrame.new(x, 1.8, 96), C.metal, Enum.Material.Metal, "Turnstile")
		decor(box(F.Props, Vector3.new(1.42, 0.3, 1), CFrame.new(x, 3.5, 95), Color3.fromRGB(60, 255, 120), Enum.Material.SmoothPlastic, "TurnstileLamp"))
	end
	box(F.Props, Vector3.new(4.2, 3, 0.6), CFrame.new(-21.4, 1.5, 96), C.safety, Enum.Material.SmoothPlastic, "OutOfOrderBar")
	sign("OUT OF ORDER", Vector3.new(-21.4, 4.6, 95.6), Vector3.new(0, 0, -1), Vector2.new(5, 1.2), C.safety, C.black, true)

	-- Ticket booth.
	slab(F.Props, -66, -50, 0, 10, 64, 74, C.cream, Enum.Material.CeramicTiles, "Booth")
	ghost(slab(F.Props, -64, -52, 4, 8, 74, 74.3, C.glass, Enum.Material.Glass, "BoothWindow")).Transparency = 0.3
	sign("TICKETS", Vector3.new(-58, 11, 74.4), Vector3.new(0, 0, 1), Vector2.new(10, 2), Color3.fromRGB(20, 60, 120), C.fixtureOn)

	for _, x in { -40, 0 } do
		for _, z in { 80, 120 } do
			slab(S, x - 1.5, x + 1.5, 0, 18, z - 1.5, z + 1.5, C.cream, Enum.Material.CeramicTiles, "Column")
		end
	end
	bench(-20, 120, 180)
	bench(15, 128, 180)
	vending("Concourse", 27, 75, Vector3.new(-1, 0, 0), Color3.fromRGB(255, 200, 80))
	crateStack(-66, 0, 134)
	crate(22, 0, 134)
	crate(-60, 0, 86)
	puddle(-30, 0, 108, 8, 5)

	sign(
		"STATION MAP\n<  WEST TUNNEL     MAINTENANCE  >\nv  PLATFORM     STREET EXIT  ^",
		Vector3.new(28.7, 8, 80),
		Vector3.new(-1, 0, 0),
		Vector2.new(14, 7),
		Color3.fromRGB(240, 240, 230),
		C.black
	)
	sign("STREET EXIT  ^", Vector3.new(-35, 15, 138.7), Vector3.new(0, 0, -1), Vector2.new(20, 2.5), Color3.fromRGB(20, 60, 120), C.fixtureOn)
	sign("<  WEST TUNNEL", Vector3.new(-68.7, 15.5, 120), Vector3.new(1, 0, 0), Vector2.new(14, 2), Color3.fromRGB(30, 70, 150), C.fixtureOn)
	sign("MAINTENANCE  >", Vector3.new(28.7, 12, 107), Vector3.new(-1, 0, 0), Vector2.new(12, 2), C.safety, C.black)

	for _, x in { -50, -20, 10 } do
		for _, z in { 78, 122 } do
			fixture("Concourse", Vector3.new(x, 17.6, z))
		end
	end
	emergency("Concourse", Vector3.new(-68.6, 12, 90), Vector3.new(1, 0, 0))
	emergency("Concourse", Vector3.new(28.6, 12, 125), Vector3.new(-1, 0, 0))

	pickup(Vector3.new(-55, 1.5, 125))
	pickup(Vector3.new(20, 1.5, 68))
	dripPoint(Vector3.new(-10, 16, 100))
end

local function buildStairwell()
	local S = F.Structure
	-- Shaft: escalator (west), median, stairs (east), rising 40 studs over 80.
	room(-64, -6, 140, 220, 0, 58, C.concreteDark, Enum.Material.Concrete)
	wall(S, "Z", -64, 140, 220, 0, 58, nil, CONCRETE)
	wall(S, "Z", -6, 140, 220, 0, 58, nil, CONCRETE)
	make("WedgePart", Vector3.new(18, 40, 80), CFrame.new(-55, 20, 180), C.metal, Enum.Material.DiamondPlate, S, "Escalator")
	make("WedgePart", Vector3.new(20, 40, 80), CFrame.new(-36, 20, 180), C.concrete, Enum.Material.Concrete, S, "Median")
	local stairRamp = make("WedgePart", Vector3.new(20, 40, 80), CFrame.new(-16, 20, 180), C.concrete, Enum.Material.Concrete, S, "StairRamp")
	stairRamp.Transparency = 1
	for i = 0, 19 do
		local top = 2 * i + 1
		ghost(slab(F.Props, -26, -6, top - 2, top, 140 + 4 * i, 144 + 4 * i, C.concrete, Enum.Material.Concrete, "Step"))
	end
	local slope = CFrame.Angles(math.rad(-26.565), 0, 0)
	local len = math.sqrt(80 * 80 + 40 * 40)
	for _, x in { -46.5, -25.5 } do
		box(S, Vector3.new(1, 3.5, len), CFrame.new(x, 21.75, 180) * slope, C.black, Enum.Material.Fabric, "Handrail")
	end
	for _, z in { 155, 180, 205 } do
		local rampY = (z - 140) / 2
		pendant("Stairwell", Vector3.new(-36, rampY + 14, z), 58)
	end
	emergency("Stairwell", Vector3.new(-62.6, 20, 170), Vector3.new(1, 0, 0))
	emergency("Stairwell", Vector3.new(-7.4, 34, 200), Vector3.new(-1, 0, 0))
	sign("STREET LEVEL  ^", Vector3.new(-35, 52, 219), Vector3.new(0, 0, -1), Vector2.new(18, 2.5), Color3.fromRGB(20, 60, 120), C.fixtureOn)

	-- Street hall (the lobby).
	room(-80, 10, 220, 270, 40, 18, C.concrete, Enum.Material.Slate)
	wall(S, "X", 220, -80, 10, 40, 18, { { -64, -6 } }, CREAM)
	wall(S, "Z", -80, 220, 270, 40, 18, nil, CREAM)
	wall(S, "Z", 10, 220, 270, 40, 18, nil, CREAM)
	wall(S, "X", 270, -80, 10, 40, 18, { { -50, -20, 12 } }, CREAM)

	-- Chained street gate with moonlight spilling through.
	slab(S, -50, -20, 38, 40, 270, 292, C.concrete, Enum.Material.Pavement, "Floor")
	wall(S, "Z", -50, 270, 292, 40, 22, nil, CONCRETE)
	wall(S, "Z", -20, 270, 292, 40, 22, nil, CONCRETE)
	wall(S, "X", 292, -50, -20, 40, 22, nil, CONCRETE)
	for i = 0, 5 do
		slab(F.Props, -50, -20, 40, 41 + i * 1.2, 280 + i * 2, 282 + i * 2, C.concrete, Enum.Material.Pavement, "StreetStep")
	end
	for x = -49, -21, 1.5 do
		local bar =
			decor(box(F.Props, Vector3.new(12, 0.3, 0.3), CFrame.new(x, 46, 270) * CFrame.Angles(0, 0, math.rad(90)), C.metal, Enum.Material.Metal, "GateBar"))
		bar.Shape = Enum.PartType.Cylinder
	end
	local gateBlocker = slab(F.Props, -50, -20, 40, 52, 269.5, 270.5, C.black, Enum.Material.SmoothPlastic, "GateBlocker")
	gateBlocker.Transparency = 1
	gateBlocker.CastShadow = false
	decor(box(F.Props, Vector3.new(30, 0.6, 0.6), CFrame.new(-35, 46, 269.4) * CFrame.Angles(0, 0, math.rad(8)), C.metal, Enum.Material.DiamondPlate, "Chain"))
	sign("EXIT CLOSED", Vector3.new(-35, 53.5, 269), Vector3.new(0, 0, -1), Vector2.new(14, 2.5), C.trainStripe, C.fixtureOn)
	local moon = ghost(
		box(
			F.Lights,
			Vector3.new(1, 1, 1),
			CFrame.lookAt(Vector3.new(-35, 60, 290), Vector3.new(-35, 40, 262)),
			C.black,
			Enum.Material.SmoothPlastic,
			"Moonlight"
		)
	)
	moon.Transparency = 1
	local spot = Instance.new("SpotLight")
	spot.Face = Enum.NormalId.Front
	spot.Color = C.moon
	spot.Angle = 60
	spot.Range = 40
	spot.Brightness = 2
	spot.Shadows = true
	spot.Parent = moon

	for i = 0, 2 do
		local z = 232 + i * 9
		box(F.Props, Vector3.new(3, 6, 4), CFrame.new(-77, 43, z), Color3.fromRGB(40, 44, 52), Enum.Material.Metal, "TicketMachine")
		powered(
			"Stairwell",
			ghost(box(F.Props, Vector3.new(0.2, 2, 2.4), CFrame.new(-75.4, 44, z), Color3.fromRGB(90, 200, 255), Enum.Material.Neon, "TicketScreen"))
		)
	end
	local spawn =
		make("SpawnLocation", Vector3.new(12, 1, 12), CFrame.new(-35, 40.5, 245), C.black, Enum.Material.SmoothPlastic, F.Props, "LobbySpawn") :: SpawnLocation
	spawn.Neutral = true
	spawn.Duration = 0
	spawn.Transparency = 1
	spawn.CanCollide = false
	bench(-20, 258, 180)
	bench(-50, 258, 180)
	crateStack(0, 40, 225)
	sign("WELCOME TO HOLLOW LINE STATION", Vector3.new(-35, 54, 221.2), Vector3.new(0, 0, 1), Vector2.new(30, 3), Color3.fromRGB(20, 60, 120), C.fixtureOn)
	for _, x in { -55, -15 } do
		fixture("Stairwell", Vector3.new(x, 57.6, 245))
	end
	emergency("Stairwell", Vector3.new(8.6, 52, 245), Vector3.new(-1, 0, 0))
	pickup(Vector3.new(0, 41.5, 262))
end

local function buildMaintenance()
	local S = F.Structure
	room(50, 130, 70, 140, 0, 16, C.concreteDark, Enum.Material.Concrete)
	wall(S, "X", 70, 50, 130, 0, 16, { { 88, 102, 10 } }, HAZARD)
	wall(S, "X", 140, 50, 130, 0, 16, nil, HAZARD)
	wall(S, "Z", 50, 70, 140, 0, 16, { { 100, 114, 10 } }, HAZARD)
	wall(S, "Z", 130, 70, 140, 0, 16, { { 110, 130, 12 } }, HAZARD)

	-- Service corridor to the concourse and staff door to the platform.
	room(30, 50, 100, 114, 0, 12, C.concreteDark, Enum.Material.Concrete)
	wall(S, "X", 100, 30, 50, 0, 12, nil, CONCRETE)
	wall(S, "X", 114, 30, 50, 0, 12, nil, CONCRETE)
	room(88, 102, 60, 70, 0, 12, C.concreteDark, Enum.Material.Concrete)
	wall(S, "Z", 88, 60, 70, 0, 12, nil, CONCRETE)
	wall(S, "Z", 102, 60, 70, 0, 12, nil, CONCRETE)

	-- Breaker bank on the north wall, one box per zone.
	local order = { "Platform", "Concourse", "Stairwell", "Maintenance", "WestTunnel", "EastTunnel" }
	local labels = { "PLATFORM", "CONCOURSE", "STAIRS", "MAINT.", "WEST TUN.", "EAST TUN." }
	slab(F.Props, 55, 122, 0.5, 12, 137.6, 139, C.concreteDark, Enum.Material.Metal, "BreakerBackplate")
	for i, zone in order do
		local x = 60 + (i - 1) * 11
		local boxPart = box(F.Interactables, Vector3.new(5, 6, 1.2), CFrame.new(x, 6, 137), Color3.fromRGB(70, 78, 72), Enum.Material.Metal, "Breaker_" .. zone)
		boxPart:SetAttribute("Zone", zone)
		local lamp = ghost(box(F.Interactables, Vector3.new(1, 1, 0.4), CFrame.new(x, 8.2, 136.3), C.fixtureOff, Enum.Material.Neon, "BreakerLamp"))
		decor(
			box(
				F.Interactables,
				Vector3.new(0.6, 2.4, 0.6),
				CFrame.new(x + 1.4, 5, 136.1) * CFrame.Angles(math.rad(-25), 0, 0),
				C.trainStripe,
				Enum.Material.SmoothPlastic,
				"Lever"
			)
		)
		sign(labels[i], Vector3.new(x, 10.4, 137.4), Vector3.new(0, 0, -1), Vector2.new(5, 1.2), C.black, C.safety)
		refs.breakers[zone] = { box = boxPart, lamp = lamp }
	end
	sign("EMERGENCY POWER  -  HOLD TO RESTORE", Vector3.new(88, 13.4, 138.4), Vector3.new(0, 0, -1), Vector2.new(30, 1.8), C.safety, C.black)

	-- Generator with hazard striping, shelving, pipes.
	slab(F.Props, 82, 98, 0, 6, 98, 108, Color3.fromRGB(60, 70, 60), Enum.Material.DiamondPlate, "Generator")
	for i = 0, 7 do
		decor(slab(F.Props, 82 + i * 2, 83 + i * 2, 6, 6.2, 98, 108, if i % 2 == 0 then C.safety else C.black, Enum.Material.SmoothPlastic, "Hazard"))
	end
	for _, z in { 76, 88 } do
		slab(F.Props, 52, 56, 0, 10, z - 4, z + 4, C.rust, Enum.Material.CorrodedMetal, "Shelf")
	end
	crateStack(110, 0, 96)
	crate(60, 0, 128)
	crate(124, 0, 132)
	pipe(Vector3.new(50, 14, 74), Vector3.new(130, 14, 74), 1.6, C.rust)
	pipe(Vector3.new(50, 13, 134), Vector3.new(130, 13, 134), 1.2)
	pipe(Vector3.new(30, 10.5, 101.5), Vector3.new(50, 10.5, 101.5), 0.8)
	for _, x in { 64, 112 } do
		pipe(Vector3.new(x, 0, 139), Vector3.new(x, 16, 139), 1.2, C.rust)
	end
	puddle(70, 0, 110, 9, 6)
	puddle(118, 0, 120, 5, 4)

	for _, x in { 70, 110 } do
		for _, z in { 85, 122 } do
			fixture("Maintenance", Vector3.new(x, 15.6, z))
		end
	end
	fixture("Maintenance", Vector3.new(40, 11.6, 107))
	fixture("Maintenance", Vector3.new(95, 11.6, 65), 90)
	emergency("Maintenance", Vector3.new(51.4, 11, 92), Vector3.new(1, 0, 0))
	emergency("Maintenance", Vector3.new(128.6, 11, 90), Vector3.new(-1, 0, 0))
	warning(Vector3.new(57, 12.5, 137))
	warning(Vector3.new(119, 12.5, 137))

	pickup(Vector3.new(122, 1.5, 78))
	dripPoint(Vector3.new(90, 14, 120))
	dripPoint(Vector3.new(40, 10, 107))
end

-- s = -1 builds the west tunnel, s = 1 the east tunnel. cEnd is where the
-- cross passage meets the station (concourse at -70, maintenance at 130).
local function buildTunnel(zone: string, s: number, cEnd: number, stripe: Color3)
	local S = F.Structure
	local style: WallStyle = { color = C.concrete, material = Enum.Material.Concrete, stripe = stripe }
	local function X(a: number): number
		return s * a
	end
	local function span(a: number, b: number): (number, number)
		return math.min(X(a), X(b)), math.max(X(a), X(b))
	end

	local a1, a2 = span(120, 340)
	local b1, b2 = span(320, 340)
	local c1, c2 = math.min(cEnd, X(320)), math.max(cEnd, X(320))
	room(a1, a2, 18, 38, 0, 16, C.concreteDark, Enum.Material.Slate)
	room(b1, b2, 38, 130, 0, 16, C.concreteDark, Enum.Material.Slate)
	room(c1, c2, 110, 130, 0, 16, C.concreteDark, Enum.Material.Slate)

	local n1, n2 = span(120, 320)
	wall(S, "X", 18, a1, a2, 0, 16, nil, style)
	wall(S, "X", 38, n1, n2, 0, 16, nil, style)
	wall(S, "Z", X(340), 18, 130, 0, 16, nil, style)
	wall(S, "Z", X(320), 38, 110, 0, 16, nil, style)
	wall(S, "X", 110, c1, c2, 0, 16, nil, style)
	local o1, o2 = math.min(cEnd, X(340)), math.max(cEnd, X(340))
	wall(S, "X", 130, o1, o2, 0, 16, nil, style)

	-- Pipes run the length of every leg.
	pipe(Vector3.new(X(120), 13, 19.6), Vector3.new(X(340), 13, 19.6), 1.4)
	pipe(Vector3.new(X(120), 11.4, 19.8), Vector3.new(X(340), 11.4, 19.8), 0.8, C.rust)
	pipe(Vector3.new(X(338.4), 13, 18), Vector3.new(X(338.4), 13, 130), 1.4)
	pipe(Vector3.new(cEnd, 13, 128.4), Vector3.new(X(340), 13, 128.4), 1.4)

	-- Cover, a boarded-up side passage and puddles.
	crateStack(X(185), 0, 33)
	crate(X(262), 0, 21)
	crate(X(333), 0, 64)
	crateStack(X(329), 0, 100)
	crate(X(250), 0, 114)
	crate(X(180), 0, 126)
	slab(F.Props, X(220) - 5, X(220) + 5, 0, 11, 17, 18.6, C.black, Enum.Material.SmoothPlastic, "SealedDoor")
	for i = 0, 3 do
		decor(
			box(
				F.Props,
				Vector3.new(11, 1, 0.4),
				CFrame.new(X(220), 2 + i * 2.6, 18.9) * CFrame.Angles(0, 0, math.rad(rng:NextNumber(-12, 12))),
				C.wood,
				Enum.Material.WoodPlanks,
				"Board"
			)
		)
	end
	sign("DANGER - NO ACCESS", Vector3.new(X(220), 12.6, 19.2), Vector3.new(0, 0, 1), Vector2.new(10, 1.4), C.safety, C.black)
	puddle(X(160), 0, 28, 8, 5)
	puddle(X(300), 0, 30, 6, 4)
	puddle(X(330), 0, 115, 6, 6)

	for _, a in { 150, 195, 240, 285, 330 } do
		fixture(zone, Vector3.new(X(a), 15.6, 28))
	end
	for _, z in { 65, 100 } do
		fixture(zone, Vector3.new(X(330), 15.6, z), 90)
	end
	local cFrom, cTo = math.abs(cEnd) + 30, 300
	for a = cFrom, cTo, 50 do
		fixture(zone, Vector3.new(X(a), 15.6, 120))
	end
	emergency(zone, Vector3.new(X(200), 11, 36.6), Vector3.new(0, 0, -1))
	emergency(zone, Vector3.new(X(338.6), 11, 80), Vector3.new(-s, 0, 0))
	emergency(zone, Vector3.new(X(270), 11, 128.6), Vector3.new(0, 0, -1))

	local name = if s < 0 then "WEST TUNNEL" else "EAST TUNNEL"
	sign(name, Vector3.new(X(330), 12.5, 128.6), Vector3.new(0, 0, -1), Vector2.new(14, 2), stripe, C.fixtureOn)

	pickup(Vector3.new(X(230), 1.5, 34))
	pickup(Vector3.new(X(330), 1.5, 85))
	pickup(Vector3.new(X(220), 1.5, 126))
	dripPoint(Vector3.new(X(200), 14, 28))
	dripPoint(Vector3.new(X(330), 14, 90))
	dripPoint(Vector3.new(X(240), 14, 120))
end

local function buildTrainTunnel()
	local S = F.Structure
	room(120, 560, -28, 0, -6, 18, C.concreteDark, Enum.Material.Concrete)
	wall(S, "X", -28, 120, 560, -6, 18, nil, CONCRETE)
	wall(S, "X", 0, 120, 560, -6, 18, nil, CONCRETE)
	wall(S, "Z", 560, -28, 0, -6, 18, nil, CONCRETE)
	local barrier = slab(S, 121, 123, -6, 12, -28, 0, C.black, Enum.Material.SmoothPlastic, "TrackBarrier")
	barrier.Transparency = 1
	barrier.CastShadow = false
	for i = 0, 2 do
		decor(
			box(
				F.Props,
				Vector3.new(0.3, 0.5, 24),
				CFrame.new(122.4, -3 + i * 1.6, -14) * CFrame.Angles(math.rad(i * 3 - 3), 0, 0),
				C.safety,
				Enum.Material.SmoothPlastic,
				"CautionTape"
			)
		)
	end
end

local function buildTrain()
	local model = Instance.new("Model")
	model.Name = "LastTrain"
	model.Parent = F.Root
	local doors: { TrainDoor } = {}
	local seats: { Seat } = {}

	local root = ghost(box(model, Vector3.new(1, 1, 1), CFrame.new(70, 4, -6), C.black, Enum.Material.SmoothPlastic, "Root"))
	root.Transparency = 1
	model.PrimaryPart = root

	for _, cx in { 46, 94 } do
		local function body(x1: number, x2: number, y1: number, y2: number, z1: number, z2: number, color: Color3, mat: Enum.Material, name: string): BasePart
			return slab(model, cx + x1, cx + x2, y1, y2, z1, z2, color, mat, name)
		end
		body(-22, 22, -1, 0, -11, -1, C.concreteDark, Enum.Material.DiamondPlate, "TrainFloor")
		body(-22.5, 22.5, 9.4, 10.6, -11.5, -0.5, C.metal, Enum.Material.Metal, "Roof")
		decor(body(-20, 20, -5.5, -1, -10, -2, C.black, Enum.Material.Metal, "Chassis"))
		for _, end_ in { -22.5, 22 } do
			body(end_, end_ + 0.5, 0, 9.4, -11, -1, C.trainBody, Enum.Material.Metal, "EndWall")
		end

		-- South side: panel / window / panel, full length.
		body(-22, 22, 0, 4, -11, -10, C.trainBody, Enum.Material.Metal, "Side")
		ghost(body(-22, 22, 4, 7.5, -10.9, -10.1, C.glass, Enum.Material.Glass, "Window")).Transparency = 0.45
		body(-22, 22, 7.5, 9.4, -11, -10, C.trainBody, Enum.Material.Metal, "Side")
		decor(body(-22, 22, 3.4, 4, -11.15, -10.85, C.trainStripe, Enum.Material.SmoothPlastic, "Stripe"))

		-- North (platform) side with two doors at -11 and +11.
		for _, seg in { { -22, -13.5 }, { -8.5, 8.5 }, { 13.5, 22 } } do
			body(seg[1], seg[2], 0, 4, -2, -1, C.trainBody, Enum.Material.Metal, "Side")
			ghost(body(seg[1], seg[2], 4, 7.5, -1.9, -1.1, C.glass, Enum.Material.Glass, "Window")).Transparency = 0.45
			body(seg[1], seg[2], 7.5, 9.4, -2, -1, C.trainBody, Enum.Material.Metal, "Side")
			decor(body(seg[1], seg[2], 3.4, 4, -1.15, -0.85, C.trainStripe, Enum.Material.SmoothPlastic, "Stripe"))
		end
		for _, dx in { -11, 11 } do
			body(dx - 2.5, dx + 2.5, 8, 9.4, -2, -1, C.trainBody, Enum.Material.Metal, "Lintel")
			local blocker = body(dx - 2.5, dx + 2.5, 0, 8, -2, -1, C.black, Enum.Material.SmoothPlastic, "DoorBlocker")
			blocker.Transparency = 1
			local left = body(dx - 2.5, dx, 0, 8, -0.9, -0.5, Color3.fromRGB(150, 155, 160), Enum.Material.Metal, "DoorL")
			local right = body(dx, dx + 2.5, 0, 8, -0.9, -0.5, Color3.fromRGB(150, 155, 160), Enum.Material.Metal, "DoorR")
			local lamp = ghost(body(dx - 0.6, dx + 0.6, 8.4, 8.9, -0.8, -0.4, C.emergency, Enum.Material.Neon, "DoorLamp"))
			local promptPart = ghost(body(dx - 0.5, dx + 0.5, 3.5, 4.5, 0.2, 1.2, C.black, Enum.Material.SmoothPlastic, "BoardPoint"))
			promptPart.Transparency = 1
			table.insert(doors, {
				left = left,
				right = right,
				leftClosed = left.CFrame,
				rightClosed = right.CFrame,
				lamp = lamp,
				prompt = promptPart,
			})
		end

		-- Interior: warm light and seats facing the platform.
		for _, lx in { -11, 11 } do
			local panel = ghost(body(lx - 4, lx + 4, 9.2, 9.4, -7, -5, C.warm, Enum.Material.Neon, "CabinLight"))
			local light = Instance.new("PointLight")
			light.Color = C.warm
			light.Range = 18
			light.Brightness = 2
			light.Shadows = false
			light.Parent = panel
		end
		for i = 0, 7 do
			local sx = cx - 19 + i * 5.4
			local seat = Instance.new("Seat")
			seat.Name = "Seat"
			seat.Anchored = true
			seat.Size = Vector3.new(2.4, 1, 2)
			seat.CFrame = CFrame.new(sx, 0.5, -8.6) * CFrame.Angles(0, math.pi, 0)
			seat.Color = Color3.fromRGB(60, 70, 120)
			seat.Material = Enum.Material.Fabric
			seat.TopSurface = Enum.SurfaceType.Smooth
			seat.Parent = model
			table.insert(seats, seat)
			decor(slab(model, sx - 1.2, sx + 1.2, 1, 4, -10, -9.6, Color3.fromRGB(60, 70, 120), Enum.Material.Fabric, "SeatBack"))
		end
	end

	-- Gangway between cars and the cab ends.
	slab(model, 68, 72, 0, 8.5, -9, -3, C.black, Enum.Material.Fabric, "Gangway")
	slab(model, 116, 117.6, 0, 9, -10.5, -1.5, Color3.fromRGB(40, 42, 46), Enum.Material.Metal, "CabNose")
	slab(model, 22.4, 24, 0, 9, -10.5, -1.5, Color3.fromRGB(40, 42, 46), Enum.Material.Metal, "CabTail")
	for _, z in { -9, -3 } do
		ghost(slab(model, 117.6, 117.9, 1.5, 2.5, z - 0.7, z + 0.7, C.fixtureOn, Enum.Material.Neon, "Headlight"))
		ghost(slab(model, 22.1, 22.4, 1.5, 2.5, z - 0.7, z + 0.7, C.emergency, Enum.Material.Neon, "TailLight"))
	end
	local beam = ghost(slab(model, 117.6, 118, 2, 3, -6.5, -5.5, C.black, Enum.Material.SmoothPlastic, "HeadBeam"))
	beam.Transparency = 1
	local spot = Instance.new("SpotLight")
	spot.Face = Enum.NormalId.Right
	spot.Color = C.fixtureOn
	spot.Range = 60
	spot.Angle = 50
	spot.Brightness = 3
	spot.Parent = beam
	local destination = ghost(slab(model, 117.6, 117.8, 6.5, 8.5, -9, -3, C.black, Enum.Material.SmoothPlastic, "Destination"))
	addLabel(destination, "LAST TRAIN", Color3.fromRGB(255, 190, 60), Enum.NormalId.Right)

	refs.train = { model = model, doors = doors, seats = seats, horn = root }
end

-- Public ----------------------------------------------------------------------

function MapBuilder.build(): Refs
	local old = Workspace:FindFirstChild("Map")
	if old then
		old:Destroy()
	end
	local map = Instance.new("Folder")
	map.Name = "Map"
	F.Root = map
	for _, name in { "Structure", "Props", "Lights", "Interactables", "Audio" } do
		local f = Instance.new("Folder")
		f.Name = name
		f.Parent = map
		F[name] = f
	end

	local zoneIds = { "Platform", "Concourse", "Stairwell", "Maintenance", "WestTunnel", "EastTunnel" }
	refs = {
		folder = map,
		fixtures = {},
		emergency = {},
		powered = {},
		breakers = {},
		train = nil :: any,
		pickups = {},
		lobbySpawn = CFrame.new(-35, 44, 245) * CFrame.Angles(0, math.pi, 0),
		survivorSpawns = {},
		shadowSpawns = {
			CFrame.new(-330, 4, 120),
			CFrame.new(330, 4, 120),
			CFrame.new(-300, 4, 28),
			CFrame.new(300, 4, 28),
		},
		patrolPoints = {},
	}
	for _, id in zoneIds do
		refs.fixtures[id] = {}
		refs.emergency[id] = {}
		refs.powered[id] = {}
	end

	buildPlatform()
	buildConcourse()
	buildStairwell()
	buildMaintenance()
	buildTunnel("WestTunnel", -1, -70, Color3.fromRGB(40, 90, 170))
	buildTunnel("EastTunnel", 1, 130, Color3.fromRGB(190, 100, 30))
	buildTrainTunnel()
	buildTrain()

	for _, p in
		{
			Vector3.new(-70, 4, 30),
			Vector3.new(-30, 4, 10),
			Vector3.new(10, 4, 46),
			Vector3.new(-90, 4, 40),
			Vector3.new(-50, 4, 80),
			Vector3.new(0, 4, 118),
			Vector3.new(-20, 4, 70),
			Vector3.new(15, 4, 108),
			Vector3.new(-35, 44, 240),
			Vector3.new(80, 4, 110),
		}
	do
		table.insert(refs.survivorSpawns, CFrame.new(p))
	end
	for _, p in
		{
			Vector3.new(-80, 3, 30),
			Vector3.new(0, 3, 40),
			Vector3.new(80, 3, 30),
			Vector3.new(-40, 3, 110),
			Vector3.new(10, 3, 80),
			Vector3.new(90, 3, 95),
			Vector3.new(-230, 3, 28),
			Vector3.new(-330, 3, 80),
			Vector3.new(-200, 3, 120),
			Vector3.new(230, 3, 28),
			Vector3.new(330, 3, 80),
			Vector3.new(220, 3, 120),
			Vector3.new(-35, 43, 245),
		}
	do
		table.insert(refs.patrolPoints, p)
	end

	map.Parent = Workspace
	return refs
end

return MapBuilder
