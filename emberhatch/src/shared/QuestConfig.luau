-- Starter quests. Each listens for one server event.
-- mode "max": progress is the highest value seen (used for levels), otherwise it adds up.

return {
	{
		id = "FirstShard",
		title = "Collect your first Ember Shard",
		hint = "Walk up to a glowing shard and press Collect.",
		event = "ShardCollected",
		target = 1,
		reward = { coins = 25, xp = 10 },
	},
	{
		id = "HatchForgekin",
		title = "Hatch a Forgekin",
		hint = "The Nursery is east of the Forge.",
		event = "ForgekinHatched",
		target = 1,
		reward = { coins = 50, gems = 5 },
	},
	{
		id = "BreakPod",
		title = "Break an Ember Crystal Pod",
		hint = "Hold Break on a large glowing crystal.",
		event = "PodBroken",
		target = 1,
		reward = { coins = 50, xp = 25 },
	},
	{
		id = "ForgeItem",
		title = "Forge your first item",
		hint = "The Forge Station opens soon.",
		event = "ItemForged",
		target = 1,
		reward = { coins = 100, xp = 50 },
	},
	{
		id = "UnlockFungal",
		title = "Unlock Fungal Hollow",
		hint = "Reach level 5.",
		event = "LevelReached",
		mode = "max",
		target = 5,
		reward = { gems = 10 },
	},
}
