-- Areas. Only three worlds for now, plus the hub.
-- Fungal Hollow and Cinderworks have portals but are built in Milestone E.

local ZoneConfig = {}

ZoneConfig.Hub = "EmberHollow"

ZoneConfig.Zones = {
	EmberHollow = {
		displayName = "Ember Hollow",
		subtitle = "Forge town",
		unlockLevel = 1,
	},
	SunkenGrove = {
		displayName = "Sunken Grove",
		subtitle = "Starter area",
		tier = 1,
		unlockLevel = 1,
		portalColor = Color3.fromRGB(126, 196, 120),
		portalGlow = Color3.fromRGB(186, 244, 168),
	},
	FungalHollow = {
		displayName = "Fungal Hollow",
		subtitle = "Mushroom caves",
		tier = 2,
		unlockLevel = 5,
		portalColor = Color3.fromRGB(96, 206, 190),
		portalGlow = Color3.fromRGB(196, 150, 255),
	},
	Cinderworks = {
		displayName = "Cinderworks",
		subtitle = "Lava foundry",
		tier = 3,
		unlockLevel = 10,
		portalColor = Color3.fromRGB(255, 112, 60),
		portalGlow = Color3.fromRGB(255, 168, 96),
	},
}

return ZoneConfig
