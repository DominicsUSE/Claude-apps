-- World layout. +X is east, -Z is north. Spawn faces north toward the Forge.

local HubConfig = {}

HubConfig.Landmarks = {
	Spawn = Vector3.new(0, 0, 60), -- south
	Forge = Vector3.new(0, 0, 0), -- center
	Nursery = Vector3.new(62, 0, 22), -- east
	EggShop = Vector3.new(66, 0, -18), -- east
	QuestBoard = Vector3.new(-60, 0, -6), -- west
	UpgradeShop = Vector3.new(-62, 0, 28), -- west
	PortalPlaza = Vector3.new(0, 0, -82), -- north
}

-- Portal gates across the north plaza, west to east by unlock order.
HubConfig.Portals = {
	{ id = "SunkenGrove", x = -24, z = -86 },
	{ id = "FungalHollow", x = 0, z = -90 },
	{ id = "Cinderworks", x = 24, z = -86 },
}

-- The Sunken Grove sits away from the hub; portals connect the two.
HubConfig.GroveOrigin = Vector3.new(0, 0, 400)

HubConfig.Color = {
	Ground = Color3.fromRGB(46, 40, 34),
	GroundEdge = Color3.fromRGB(30, 27, 24),
	StoneDark = Color3.fromRGB(26, 26, 30),
	StoneBase = Color3.fromRGB(40, 40, 46),
	StoneRaised = Color3.fromRGB(70, 64, 58),
	Path = Color3.fromRGB(92, 80, 66),
	Brass = Color3.fromRGB(196, 150, 72),
	BrassBright = Color3.fromRGB(238, 190, 106),
	Amber = Color3.fromRGB(255, 176, 66),
	EmberRed = Color3.fromRGB(255, 92, 56),
	Parchment = Color3.fromRGB(238, 228, 208),
	Wood = Color3.fromRGB(110, 76, 48),
	WoodDark = Color3.fromRGB(68, 46, 30),
	Leaf = Color3.fromRGB(92, 150, 84),
	Grass = Color3.fromRGB(104, 168, 86),
	Moss = Color3.fromRGB(78, 128, 70),
	Rock = Color3.fromRGB(120, 118, 112),
}

return HubConfig
