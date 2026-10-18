-- Collection tuning and placement. Edit numbers here; no other file needs to change.
-- Designers can also tag their own parts/models "EmberShard" or "CrystalPod" in Studio.

local ResourceConfig = {}

ResourceConfig.Shard = {
	amount = 1,
	xp = 2,
	respawnSeconds = 8,
	promptDistance = 9,
	hoverHeight = 1.8,
}

ResourceConfig.Pod = {
	holdSeconds = 1,
	promptDistance = 11,
	shardsMin = 3,
	shardsMax = 10,
	coinsMin = 4,
	coinsMax = 12,
	xpBonus = 10, -- on top of the per-shard xp
	respawnMin = 30,
	respawnMax = 60,
	rareCoreChance = 0.6, -- rare pods only
	rareCoresMin = 1,
	rareCoresMax = 2,
}

-- Seconds a player must wait between two collections (stops prompt spam).
ResourceConfig.ShardCooldown = 0.15
ResourceConfig.PodCooldown = 0.9

-- Hub placements (world positions on the ground; shards hover above them).
-- The first shard is a few steps in front of spawn: first pickup in under 10 seconds.
ResourceConfig.HubShards = {
	Vector3.new(0, 0, 51),
	Vector3.new(-3, 0, 45),
	Vector3.new(3, 0, 39),
	Vector3.new(-3, 0, 33),
	Vector3.new(14, 0, 24),
	Vector3.new(-14, 0, 24),
	Vector3.new(26, 0, 8),
	Vector3.new(-26, 0, 8),
	Vector3.new(40, 0, 14),
	Vector3.new(-40, 0, -2),
	Vector3.new(16, 0, -38),
	Vector3.new(-16, 0, -38),
}

ResourceConfig.HubPods = {
	{ position = Vector3.new(22, 0, 50) },
	{ position = Vector3.new(-34, 0, -40) },
}

-- Sunken Grove placements, relative to HubConfig.GroveOrigin.
ResourceConfig.GroveShards = {
	Vector3.new(0, 0, 62),
	Vector3.new(-4, 0, 54),
	Vector3.new(4, 0, 46),
	Vector3.new(-8, 0, 38),
	Vector3.new(8, 0, 30),
	Vector3.new(-14, 0, 22),
	Vector3.new(14, 0, 14),
	Vector3.new(0, 0, 8),
	Vector3.new(-24, 0, 0),
	Vector3.new(24, 0, 0),
	Vector3.new(-30, 0, -20),
	Vector3.new(30, 0, -20),
	Vector3.new(-10, 0, -32),
	Vector3.new(10, 0, -32),
	Vector3.new(0, 0, -46),
	Vector3.new(-44, 0, 34),
}

ResourceConfig.GrovePods = {
	{ position = Vector3.new(14, 0, 42) },
	{ position = Vector3.new(-18, 0, 30) },
	{ position = Vector3.new(28, 0, -8) },
	{ position = Vector3.new(-30, 0, -10) },
	-- Hidden behind the boulders in the north-west corner.
	{ position = Vector3.new(-66, 0, -66), rare = true },
}

return ResourceConfig
