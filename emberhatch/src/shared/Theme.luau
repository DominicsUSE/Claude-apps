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

-- Keys the Forgekin Milestone 1 UILibrary and panels read, so kept panels
-- (Settings, for example) still work next to the new HUD.
for name, color in pairs({
	StoneLight = Color3.fromRGB(58, 52, 46),
	StoneHairline = Color3.fromRGB(74, 66, 58),
	BrassDeep = Color3.fromRGB(82, 60, 32),
	AmberSoft = Color3.fromRGB(216, 158, 80),
	AmberGlow = Color3.fromRGB(255, 208, 128),
	Danger = Color3.fromRGB(200, 86, 62),
	DangerBright = Color3.fromRGB(240, 118, 88),
	Frost = Color3.fromRGB(126, 200, 220),
	Gold = Color3.fromRGB(230, 195, 118),
	Shadow = Color3.fromRGB(0, 0, 0),
	Glow = Color3.fromRGB(255, 190, 120),
}) do
	Theme.Color[name] = color
end
Theme.Font.Medium = Enum.Font.Nunito
Theme.Font.Mono = Enum.Font.Code
Theme.Font.Serif = Enum.Font.Merriweather
Theme.Radius.XL = UDim.new(0, 20)
Theme.Radius.Pill = UDim.new(1, 0)
Theme.TextSize = { Tiny = 10, Small = 11, Body = 13, Label = 14, Subhead = 16, Header = 20, Title = 26, Hero = 34 }
Theme.Spacing = { XS = 4, S = 8, M = 12, L = 16, XL = 24, XXL = 32 }
Theme.Stroke = { Hairline = 1, Default = 1.5, Bold = 2 }
Theme.Anim = {
	Fast = TweenInfo.new(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
	Default = TweenInfo.new(0.25, Enum.EasingStyle.Quart, Enum.EasingDirection.Out),
	Slow = TweenInfo.new(0.4, Enum.EasingStyle.Quart, Enum.EasingDirection.Out),
	Spring = TweenInfo.new(0.55, Enum.EasingStyle.Back, Enum.EasingDirection.Out),
	Snap = TweenInfo.new(0.1, Enum.EasingStyle.Linear, Enum.EasingDirection.Out),
}

Theme.Game = {
	Title = "EMBERHATCH",
	Subtitle = "HATCH · FORGE · EXPLORE",
}

return Theme
