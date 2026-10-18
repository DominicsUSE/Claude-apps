-- DataService: the only module that talks to DataStores.
-- Gameplay code changes the in-memory profile through this module; it saves on
-- an autosave timer, when the player leaves, and when the server shuts down.
-- Session lock: one server owns a profile at a time, so rejoining fast can't
-- roll back or duplicate progress.

local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

-- Point STORE_NAME / KEY_PREFIX at your existing store to keep old saves.
-- Old saves are cleaned on load: only the fields in TEMPLATE are kept.
local STORE_NAME = "EmberHatch_v1"
local KEY_PREFIX = "Player_"
local AUTOSAVE_SECONDS = 60
local LOCK_STALE_SECONDS = AUTOSAVE_SECONDS * 2 + 30
local LOCK_RETRIES = 5
local MAX_LEVEL = 100

local TEMPLATE = {
	version = 2,
	coins = 0,
	gems = 0,
	xp = 0,
	level = 1,
	emberShards = 0,
	crystalCores = 0,
	forgekin = {}, -- list of { id = "Stoneback" }
	activeForgekin = "",
	quests = {}, -- [questId] = { progress = n, done = bool }
	stats = {
		shardsCollected = 0,
		podsBroken = 0,
		coresFound = 0,
		hatched = 0,
		itemsForged = 0,
	},
	settings = {},
}

-- Fields gameplay code may add to with DataService.Add, and the attribute each one mirrors to.
local CURRENCIES = {
	coins = "Coins",
	gems = "Gems",
	emberShards = "EmberShards",
	crystalCores = "CrystalCores",
}

local DataService = {}

local store = nil
local profiles = {} -- [Player] = profile
local busy = {} -- [Player] = true while a save is running
local nextAutosave = {} -- [Player] = os.clock() time
local loadedCallbacks = {}
local levelCallbacks = {}

local function deepCopy(value)
	if type(value) ~= "table" then
		return value
	end
	local copy = {}
	for k, v in pairs(value) do
		copy[k] = deepCopy(v)
	end
	return copy
end

-- Builds a clean profile from whatever was stored. Unknown fields are dropped,
-- so data from removed systems disappears on the player's next save.
local function reconcile(stored)
	local profile = deepCopy(TEMPLATE)
	if type(stored) ~= "table" then
		return profile
	end
	for key, default in pairs(TEMPLATE) do
		local value = stored[key]
		if value ~= nil and type(value) == type(default) then
			profile[key] = deepCopy(value)
		end
	end
	for key, default in pairs(TEMPLATE.stats) do
		if type(profile.stats[key]) ~= "number" then
			profile.stats[key] = default
		end
	end
	for field in pairs(CURRENCIES) do
		profile[field] = math.max(0, math.floor(profile[field]))
	end
	profile.level = math.clamp(math.floor(profile.level), 1, MAX_LEVEL)
	profile.xp = math.max(0, math.floor(profile.xp))
	profile.version = TEMPLATE.version
	return profile
end

-- pcall with exponential backoff. Returns ok, result-or-error.
local function withRetry(attempts, fn)
	local delaySeconds = 1
	local lastError
	for attempt = 1, attempts do
		local ok, result = pcall(fn)
		if ok then
			return true, result
		end
		lastError = result
		warn(("[DataService] attempt %d/%d failed: %s"):format(attempt, attempts, tostring(result)))
		if attempt < attempts then
			task.wait(delaySeconds)
			delaySeconds = math.min(delaySeconds * 2, 8)
		end
	end
	return false, lastError
end

function DataService.XPForLevel(level)
	return 40 + (level - 1) * 30
end

local function syncAttributes(player, profile)
	for field, attribute in pairs(CURRENCIES) do
		player:SetAttribute(attribute, profile[field])
	end
	player:SetAttribute("Level", profile.level)
	player:SetAttribute("XP", profile.xp)
	player:SetAttribute("XPNext", DataService.XPForLevel(profile.level))
	player:SetAttribute("ActiveForgekin", profile.activeForgekin)
end

-- Returns profile, status ("ok" | "offline" | "locked" | "error").
local function loadProfile(player)
	if not store then
		return deepCopy(TEMPLATE), "offline"
	end

	local key = KEY_PREFIX .. player.UserId
	for _ = 1, LOCK_RETRIES do
		local claimed, lockedElsewhere = nil, false
		local ok, err = withRetry(3, function()
			store:UpdateAsync(key, function(stored)
				claimed, lockedElsewhere = nil, false
				local lock = type(stored) == "table" and stored._lock
				if
					type(lock) == "table"
					and lock.jobId ~= game.JobId
					and os.time() - (lock.time or 0) < LOCK_STALE_SECONDS
				then
					lockedElsewhere = true
					return nil -- another live server owns it; don't write
				end
				local profile = reconcile(stored)
				profile._lock = { jobId = game.JobId, time = os.time() }
				claimed = profile
				return profile
			end)
		end)

		if not ok then
			if RunService:IsStudio() then
				warn("[DataService] DataStore unavailable in Studio, playing without saving:", err)
				store = nil
				return deepCopy(TEMPLATE), "offline"
			end
			return nil, "error"
		end
		if claimed then
			return claimed, "ok"
		end
		if not lockedElsewhere then
			return nil, "error"
		end
		task.wait(3) -- the other server may be finishing its final save
	end
	return nil, "locked"
end

-- Writes the profile. release = true also clears the session lock.
local function saveProfile(player, release)
	while busy[player] do
		task.wait(0.1)
	end
	local profile = profiles[player]
	if not profile or not store then
		return
	end
	busy[player] = true

	local payload = deepCopy(profile)
	payload._lock = if release then nil else { jobId = game.JobId, time = os.time() }

	withRetry(3, function()
		store:UpdateAsync(KEY_PREFIX .. player.UserId, function(stored)
			local lock = type(stored) == "table" and stored._lock
			if type(lock) == "table" and lock.jobId ~= game.JobId then
				return nil -- another server took over this profile; never overwrite it
			end
			return payload
		end)
	end)

	busy[player] = nil
end

local function onPlayerAdded(player)
	local profile, status = loadProfile(player)

	if not profile then
		if status == "locked" then
			player:Kick("Your progress is still saving from another server. Please rejoin in a minute.")
		else
			player:Kick("We couldn't load your progress. Please rejoin.")
		end
		return
	end

	if not player:IsDescendantOf(Players) then
		-- Left while loading: hand the lock straight back.
		profiles[player] = profile
		saveProfile(player, true)
		profiles[player] = nil
		return
	end

	profiles[player] = profile
	nextAutosave[player] = os.clock() + AUTOSAVE_SECONDS * (0.5 + (player.UserId % 10) / 20)
	syncAttributes(player, profile)
	player:SetAttribute("SaveMode", status)
	player:SetAttribute("DataLoaded", true)

	for _, callback in ipairs(loadedCallbacks) do
		task.spawn(callback, player, profile)
	end
end

local function onPlayerRemoving(player)
	if profiles[player] then
		saveProfile(player, true)
	end
	profiles[player] = nil
	nextAutosave[player] = nil
end

-- ── Public API ───────────────────────────────────────────

function DataService.Get(player)
	return profiles[player]
end

function DataService.OnLoaded(callback)
	table.insert(loadedCallbacks, callback)
end

function DataService.OnLevelUp(callback)
	table.insert(levelCallbacks, callback)
end

-- Adds to coins, gems, emberShards or crystalCores. Returns the new total.
function DataService.Add(player, field, amount)
	local profile = profiles[player]
	local attribute = CURRENCIES[field]
	if not profile or not attribute or type(amount) ~= "number" or amount ~= amount or amount <= 0 then
		return nil
	end
	profile[field] += math.floor(amount)
	player:SetAttribute(attribute, profile[field])
	return profile[field]
end

function DataService.AddXP(player, amount)
	local profile = profiles[player]
	if not profile or type(amount) ~= "number" or amount <= 0 then
		return
	end

	profile.xp += math.floor(amount)
	local leveled = false
	while profile.level < MAX_LEVEL and profile.xp >= DataService.XPForLevel(profile.level) do
		profile.xp -= DataService.XPForLevel(profile.level)
		profile.level += 1
		leveled = true
	end
	if profile.level >= MAX_LEVEL then
		profile.xp = 0
	end

	player:SetAttribute("Level", profile.level)
	player:SetAttribute("XP", profile.xp)
	player:SetAttribute("XPNext", DataService.XPForLevel(profile.level))

	if leveled then
		for _, callback in ipairs(levelCallbacks) do
			task.spawn(callback, player, profile.level)
		end
	end
end

function DataService.SetActiveForgekin(player, id)
	local profile = profiles[player]
	if profile then
		profile.activeForgekin = id
		player:SetAttribute("ActiveForgekin", id)
	end
end

function DataService.Init()
	local ok, result = pcall(function()
		return DataStoreService:GetDataStore(STORE_NAME)
	end)
	if ok and RunService:IsStudio() then
		-- Fail fast in Studio when API access is off, instead of retrying on every join.
		ok, result = pcall(function()
			result:GetAsync("_studio_probe")
			return result
		end)
	end
	if ok then
		store = result
	else
		warn("[DataService] Saving is off (publish the place and enable Studio API access):", result)
	end
end

-- Call after every other service has registered its callbacks.
function DataService.Start()
	Players.PlayerAdded:Connect(onPlayerAdded)
	Players.PlayerRemoving:Connect(onPlayerRemoving)
	for _, player in ipairs(Players:GetPlayers()) do
		task.spawn(onPlayerAdded, player)
	end

	task.spawn(function()
		while true do
			task.wait(5)
			local now = os.clock()
			for player in pairs(profiles) do
				if now >= (nextAutosave[player] or 0) then
					nextAutosave[player] = now + AUTOSAVE_SECONDS
					task.spawn(saveProfile, player, false)
				end
			end
		end
	end)

	game:BindToClose(function()
		local pending = 0
		for player in pairs(profiles) do
			pending += 1
			task.spawn(function()
				saveProfile(player, true)
				pending -= 1
			end)
		end
		local deadline = os.clock() + (if RunService:IsStudio() then 5 else 25)
		while pending > 0 and os.clock() < deadline do
			task.wait(0.1)
		end
	end)
end

return DataService
