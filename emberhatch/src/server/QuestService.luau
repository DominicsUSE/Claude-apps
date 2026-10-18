-- QuestService: starter quests. Other services report events with
-- QuestService.Progress(player, eventName, amount); the server alone decides
-- when a quest is done and pays the reward.
-- Quest state reaches the client as a JSON attribute, so it never misses an update.

local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local QuestConfig = require(ReplicatedStorage.Shared.QuestConfig)
local DataService = require(script.Parent.DataService)

local QuestService = {}

local notify -- RemoteEvent

local function rewardText(reward)
	local parts = {}
	if reward.coins then
		table.insert(parts, ("+%d Coins"):format(reward.coins))
	end
	if reward.gems then
		table.insert(parts, ("+%d Gems"):format(reward.gems))
	end
	if reward.xp then
		table.insert(parts, ("+%d XP"):format(reward.xp))
	end
	return table.concat(parts, "  ")
end

function QuestService.Sync(player)
	local profile = DataService.Get(player)
	if not profile then
		return
	end
	local list = {}
	for _, quest in ipairs(QuestConfig) do
		local state = profile.quests[quest.id]
		table.insert(list, {
			id = quest.id,
			title = quest.title,
			hint = quest.hint,
			progress = state and state.progress or 0,
			target = quest.target,
			done = state ~= nil and state.done == true,
		})
	end
	player:SetAttribute("QuestState", HttpService:JSONEncode(list))
end

local function complete(player, quest)
	local reward = quest.reward
	if reward.coins then
		DataService.Add(player, "coins", reward.coins)
	end
	if reward.gems then
		DataService.Add(player, "gems", reward.gems)
	end
	notify:FireClient(player, "Quest complete: " .. quest.title, "success", rewardText(reward))
	if reward.xp then
		DataService.AddXP(player, reward.xp) -- may level up, which reports LevelReached
	end
end

function QuestService.Progress(player, event, amount)
	local profile = DataService.Get(player)
	if not profile then
		return
	end
	amount = amount or 1

	local changed = false
	for _, quest in ipairs(QuestConfig) do
		if quest.event == event then
			local state = profile.quests[quest.id] or { progress = 0, done = false }
			if not state.done then
				if quest.mode == "max" then
					state.progress = math.max(state.progress, amount)
				else
					state.progress += amount
				end
				state.progress = math.min(state.progress, quest.target)
				state.done = state.progress >= quest.target
				profile.quests[quest.id] = state
				changed = true
				if state.done then
					complete(player, quest)
				end
			end
		end
	end

	if changed then
		QuestService.Sync(player)
	end
end

function QuestService.Init()
	notify = ReplicatedStorage.Remotes.Notify

	DataService.OnLoaded(function(player, profile)
		-- Players from older saves may already own Forgekin or have the level.
		if #profile.forgekin > 0 then
			QuestService.Progress(player, "ForgekinHatched", #profile.forgekin)
		end
		QuestService.Progress(player, "LevelReached", profile.level)
		QuestService.Sync(player)
	end)

	DataService.OnLevelUp(function(player, level)
		notify:FireClient(player, ("Level %d!"):format(level), "success")
		QuestService.Progress(player, "LevelReached", level)
	end)
end

return QuestService
