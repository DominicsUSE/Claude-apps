-- GroveBuilder: a simple Sunken Grove so the starter portal has somewhere to go.
-- Skipped if workspace.SunkenGrove already exists. A hand-built grove needs one part
-- tagged "ZoneEntry_SunkenGrove" (where players land) and a prompt tagged "Portal"
-- with the attribute Portal = "EmberHollow" to get back.

local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Theme = require(ReplicatedStorage.Shared.Theme)
local HubConfig = require(ReplicatedStorage.Shared.HubConfig)
local ZoneConfig = require(ReplicatedStorage.Shared.ZoneConfig)

local C = HubConfig.Color

local GroveBuilder = {}

local function part(parent, name, size, cframe, color, material, opts)
	opts = opts or {}
	local p = Instance.new("Part")
	p.Name = name
	p.Size = size
	p.CFrame = cframe
	p.Color = color
	p.Material = material
	p.Anchored = true
	p.CanCollide = opts.collide ~= false
	p.CanQuery = p.CanCollide
	p.CanTouch = false
	p.Transparency = opts.transparency or 0
	if opts.shape then
		p.Shape = opts.shape
	end
	p.Parent = parent
	return p
end

local function sign(parent, title, subtitle, accent, position)
	local anchor = part(
		parent,
		"Sign",
		Vector3.new(0.2, 0.2, 0.2),
		CFrame.new(position),
		Color3.new(),
		Enum.Material.SmoothPlastic,
		{
			collide = false,
			transparency = 1,
		}
	)
	local gui = Instance.new("BillboardGui")
	gui.Size = UDim2.new(14, 0, 3.6, 0)
	gui.AlwaysOnTop = true
	gui.LightInfluence = 0
	gui.MaxDistance = 180
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

	for _, line in ipairs({
		{ title, Theme.Font.Title, Theme.Color.Parchment, 0.08, 0.56 },
		{ subtitle, Theme.Font.Body, accent, 0.64, 0.28 },
	}) do
		local label = Instance.new("TextLabel")
		label.BackgroundTransparency = 1
		label.Position = UDim2.fromScale(0.05, line[4])
		label.Size = UDim2.fromScale(0.9, line[5])
		label.Text = line[1]
		label.Font = line[2]
		label.TextColor3 = line[3]
		label.TextScaled = true
		label.Parent = frame
	end
end

local function tree(parent, position, height)
	part(
		parent,
		"Trunk",
		Vector3.new(height, 1.6, 1.6),
		CFrame.new(position + Vector3.new(0, height / 2, 0)) * CFrame.Angles(0, 0, math.rad(90)),
		C.Wood,
		Enum.Material.Wood,
		{
			shape = Enum.PartType.Cylinder,
		}
	)
	part(
		parent,
		"Leaves",
		Vector3.new(8, 8, 8),
		CFrame.new(position + Vector3.new(0, height + 2.5, 0)),
		C.Leaf,
		Enum.Material.Grass,
		{
			shape = Enum.PartType.Ball,
		}
	)
end

local function rock(parent, position, size, yaw)
	part(
		parent,
		"Rock",
		size,
		CFrame.new(position + Vector3.new(0, size.Y / 2 - 0.4, 0)) * CFrame.Angles(0, yaw, 0.15),
		C.Rock,
		Enum.Material.Slate
	)
end

function GroveBuilder.Build()
	if workspace:FindFirstChild("SunkenGrove") then
		if #CollectionService:GetTagged("ZoneEntry_SunkenGrove") == 0 then
			warn(
				"[GroveBuilder] workspace.SunkenGrove has no part tagged ZoneEntry_SunkenGrove; its portal won't work."
			)
		end
		return
	end

	local o = HubConfig.GroveOrigin
	local zone = ZoneConfig.Zones.SunkenGrove
	local root = Instance.new("Folder")
	root.Name = "SunkenGrove"

	part(root, "Ground", Vector3.new(180, 2, 180), CFrame.new(o + Vector3.new(0, -1, 0)), C.Grass, Enum.Material.Grass)
	for _, patch in ipairs({
		Vector3.new(-20, 0, 20),
		Vector3.new(30, 0, -30),
		Vector3.new(-40, 0, -40),
		Vector3.new(36, 0, 40),
	}) do
		part(
			root,
			"Moss",
			Vector3.new(0.2, 18, 18),
			CFrame.new(o + patch + Vector3.new(0, 0.05, 0)) * CFrame.Angles(0, 0, math.rad(90)),
			C.Moss,
			Enum.Material.Grass,
			{
				shape = Enum.PartType.Cylinder,
				collide = false,
			}
		)
	end

	-- Low stone rim plus invisible walls so nobody walks off the edge.
	for _, wall in ipairs({
		{ Vector3.new(0, 0, 89), Vector3.new(180, 1, 2) },
		{ Vector3.new(0, 0, -89), Vector3.new(180, 1, 2) },
		{ Vector3.new(89, 0, 0), Vector3.new(2, 1, 180) },
		{ Vector3.new(-89, 0, 0), Vector3.new(2, 1, 180) },
	}) do
		part(
			root,
			"Rim",
			wall[2] + Vector3.new(0, 2, 0),
			CFrame.new(o + wall[1] + Vector3.new(0, 1.5, 0)),
			C.Rock,
			Enum.Material.Slate
		)
		part(
			root,
			"Boundary",
			wall[2] + Vector3.new(0, 60, 0),
			CFrame.new(o + wall[1] + Vector3.new(0, 30, 0)),
			Color3.new(),
			Enum.Material.SmoothPlastic,
			{
				transparency = 1,
			}
		)
	end

	for i, position in ipairs({
		Vector3.new(-50, 0, 60),
		Vector3.new(52, 0, 54),
		Vector3.new(-62, 0, 10),
		Vector3.new(64, 0, 4),
		Vector3.new(-40, 0, -52),
		Vector3.new(46, 0, -58),
		Vector3.new(-14, 0, -70),
		Vector3.new(20, 0, -72),
	}) do
		tree(root, o + position, 9 + (i % 3) * 2)
	end

	for i, position in ipairs({
		Vector3.new(-22, 0, 48),
		Vector3.new(30, 0, 22),
		Vector3.new(-36, 0, -24),
		Vector3.new(12, 0, -54),
	}) do
		rock(root, o + position, Vector3.new(5, 3, 4), i)
	end
	-- Boulders that hide the rare pod in the north-west corner.
	rock(root, o + Vector3.new(-56, 0, -60), Vector3.new(8, 7, 6), 0.4)
	rock(root, o + Vector3.new(-62, 0, -54), Vector3.new(7, 6, 7), 1.2)
	rock(root, o + Vector3.new(-54, 0, -70), Vector3.new(6, 6, 8), 2)

	-- Arrival spot (faces north, into the grove) and the gate home behind it.
	local entry = part(
		root,
		"GroveEntry",
		Vector3.new(1, 1, 1),
		CFrame.new(o + Vector3.new(0, 0.5, 72)),
		Color3.new(),
		Enum.Material.SmoothPlastic,
		{
			collide = false,
			transparency = 1,
		}
	)
	CollectionService:AddTag(entry, "ZoneEntry_SunkenGrove")

	local gate = o + Vector3.new(0, 0, 82)
	local pad = part(
		root,
		"ReturnPad",
		Vector3.new(10, 0.6, 6),
		CFrame.new(gate + Vector3.new(0, 0.3, 0)),
		C.StoneDark,
		Enum.Material.Slate
	)
	for _, side in ipairs({ -1, 1 }) do
		part(
			root,
			"Pillar",
			Vector3.new(2, 12, 2),
			CFrame.new(gate + Vector3.new(side * 4, 6, 0)),
			C.StoneBase,
			Enum.Material.Basalt
		)
	end
	part(
		root,
		"Lintel",
		Vector3.new(10.4, 1.5, 2.4),
		CFrame.new(gate + Vector3.new(0, 12.6, 0)),
		C.Brass,
		Enum.Material.Metal
	)
	part(
		root,
		"Surface",
		Vector3.new(6, 11, 0.4),
		CFrame.new(gate + Vector3.new(0, 6.2, 0)),
		C.Amber,
		Enum.Material.Neon,
		{
			collide = false,
			transparency = 0.35,
		}
	)
	local prompt = Instance.new("ProximityPrompt")
	prompt.ActionText = "Return"
	prompt.ObjectText = ZoneConfig.Zones[ZoneConfig.Hub].displayName
	prompt.HoldDuration = 0.3
	prompt.RequiresLineOfSight = false
	prompt:SetAttribute("Portal", ZoneConfig.Hub)
	prompt.Parent = pad
	CollectionService:AddTag(prompt, "Portal")

	sign(
		root,
		zone.displayName:upper(),
		"Collect shards · break crystal pods",
		zone.portalColor,
		o + Vector3.new(0, 12, 60)
	)
	sign(root, "EMBER HOLLOW", "Back to town", Theme.Color.Amber, gate + Vector3.new(0, 16, 0))

	root.Parent = workspace
end

return GroveBuilder
