-- Theme: one palette for UI and world. Dark stone, brass, amber, parchment.

local Theme = {}

Theme.Color = {
	-- Stone panels
	StoneDeep = Color3.fromRGB(16, 15, 14),
	StoneBase = Color3.fromRGB(30, 28, 26),
	StoneRaised = Color3.fromRGB(46, 42, 38),

	-- Brass borders and amber highlights
	Brass = Color3.fromRGB(196, 150, 72),
	BrassBright = Color3.fromRGB(238, 190, 106),
	BrassDim = Color3.fromRGB(120, 92, 50),
	Amber = Color3.fromRGB(255, 176, 66),
	Ember = Color3.fromRGB(255, 112, 52),

	-- Text
	Parchment = Color3.fromRGB(238, 228, 208),
	ParchmentDim = Color3.fromRGB(186, 174, 152),
	ParchmentMute = Color3.fromRGB(128, 120, 106),

	-- Currencies and resources
	Coin = Color3.fromRGB(240, 196, 92),
	Gem = Color3.fromRGB(222, 84, 108),
	Shard = Color3.fromRGB(255, 150, 48),
	Core = Color3.fromRGB(178, 120, 255),

	-- Feedback
	Success = Color3.fromRGB(150, 204, 116),
	Error = Color3.fromRGB(226, 96, 80),
}

Theme.Font = {
	Display = Enum.Font.GrenzeGotisch, -- big brand text only
	Title = Enum.Font.Merriweather,
	Body = Enum.Font.Nunito,
	Number = Enum.Font.Oswald,
}

Theme.Radius = {
	Small = UDim.new(0, 6),
	Medium = UDim.new(0, 10),
	Large = UDim.new(0, 14),
}

Theme.Game = {
	Title = "EMBERHATCH",
	Subtitle = "HATCH · FORGE · EXPLORE",
}

return Theme
