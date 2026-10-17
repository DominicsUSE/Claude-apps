--!strict
-- Round state machine: Lobby -> Hiding -> Round -> Results, forever.

local Players = game:GetService("Players")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Config = require(Shared.Config)
local Net = require(Shared.Net)
local Zones = require(Shared.Zones)

local Breakers = require(script.Parent.Breakers)
local Glowsticks = require(script.Parent.Glowsticks)
local MapBuilder = require(script.Parent.MapBuilder)
local Power = require(script.Parent.Power)
local Roster = require(script.Parent.Roster)
local ShadowBot = require(script.Parent.ShadowBot)
local ShadowForm = require(script.Parent.ShadowForm)
local Tagging = require(script.Parent.Tagging)
local Train = require(script.Parent.Train)

local Round = {}

local refs: MapBuilder.Refs
local lastShadow: Player? = nil

local function set(key: string, value: any)
	Net.state():SetAttribute(key, value)
end

local function announce(text: string, kind: string)
	Net.event("Announce"):FireAllClients(text, kind)
end

local function phase(): string?
	return Net.state():GetAttribute("Phase") :: string?
end

local function near(list: { CFrame }): CFrame
	return list[math.random(#list)] + Vector3.new(math.random(-3, 3), 0, math.random(-3, 3))
end

local function counts(): (number, number, number)
	local survivors, shadows, escaped = 0, ShadowBot.count(), 0
	for _, d in Roster.all() do
		if d.role == "Survivor" then
			survivors += 1
		elseif d.role == "Shadow" or d.role == "Transforming" then
			shadows += 1
		elseif d.role == "Escaped" then
			escaped += 1
		end
	end
	set("Survivors", survivors)
	set("Shadows", shadows)
	set("Escaped", escaped)
	return survivors, shadows, escaped
end

local function countdown(name: string, seconds: number, onTick: ((number) -> boolean)?)
	set("Phase", name)
	for t = seconds, 0, -1 do
		set("TimeLeft", t)
		if onTick and onTick(t) then
			return
		end
		if t > 0 then
			task.wait(1)
		end
	end
end

local function onCharacter(player: Player, character: Model, d: Roster.Data)
	if d.role == "Shadow" or d.role == "Transforming" then
		Roster.setRole(player, "Shadow")
		Roster.teleport(player, near(refs.shadowSpawns))
		-- Accessories stream in after spawn; strip them only once they exist.
		task.spawn(function()
			local started = os.clock()
			while not player:HasAppearanceLoaded() and os.clock() - started < 5 do
				task.wait(0.1)
			end
			if character.Parent then
				ShadowForm.apply(character, Config.NewShadowTagDelay)
			end
		end)
	elseif d.role == "Escaped" then
		Train.seat(player)
	else
		Roster.teleport(player, if d.role == "Survivor" then near(refs.survivorSpawns) else refs.lobbySpawn)
		Roster.giveFlashlight(character)
	end
	local humanoid = character:FindFirstChildOfClass("Humanoid") :: Humanoid
	humanoid.Died:Connect(function()
		-- Dying (falling, resetting) during a round counts as being consumed.
		if d.role == "Survivor" and phase() == "Round" then
			Roster.setRole(player, "Shadow")
			counts()
		end
	end)
end

local function lobby()
	Train.reset()
	Power.resetAll()
	Glowsticks.reset()
	Breakers.reset()
	ShadowBot.clear()
	set("Result", nil)
	set("Phase", "Lobby")
	for _, player in Players:GetPlayers() do
		Roster.setRole(player, "Lobby")
		player:LoadCharacter()
	end
	counts()
	while #Players:GetPlayers() == 0 do
		task.wait(1)
	end
	countdown("Lobby", Config.LobbyTime)
end

local function hiding(): Player?
	local players = Players:GetPlayers()
	local spawns = table.clone(refs.survivorSpawns)
	for i = #spawns, 2, -1 do
		local j = math.random(i)
		spawns[i], spawns[j] = spawns[j], spawns[i]
	end
	for i, player in players do
		Roster.setRole(player, "Survivor")
		Roster.resetForRound(player)
		local character = player.Character
		if character then
			Roster.teleport(player, spawns[(i - 1) % #spawns + 1])
			Roster.giveFlashlight(character)
		else
			player:LoadCharacter()
		end
	end
	counts()
	announce("Hide! The Shadow emerges in " .. Config.HidingTime .. " seconds.", "Phase")

	local secret: Player? = nil
	if #players >= Config.MinPlayersForPvP then
		local pool = table.clone(players)
		local last = lastShadow and table.find(pool, lastShadow)
		if last then
			table.remove(pool, last)
		end
		secret = pool[math.random(#pool)]
		Net.event("Announce"):FireClient(secret, "You are THE SHADOW. Blend in - you transform when the lights die.", "Secret")
	end
	countdown("Hiding", Config.HidingTime)
	return secret
end

local function emerge(secret: Player?)
	local d = secret and Roster.get(secret)
	local character = secret and secret.Character
	if secret and d and d.role == "Survivor" and character then
		lastShadow = secret
		Roster.setRole(secret, "Transforming")
		ShadowForm.transform(character, Config.TransformTime, 0, function()
			if d.role == "Transforming" then
				Roster.setRole(secret, "Shadow")
			end
		end)
	else
		ShadowBot.spawn(near(refs.shadowSpawns))
	end
end

local function main(secret: Player?): "Survivors" | "Shadows"
	set("Phase", "Round")
	emerge(secret)
	local zone = Power.cutRandom()
	announce("The lights die" .. (if zone then " in the " .. Zones.ById[zone].name else "") .. "... the Shadow is here.", "Danger")

	local nextOutage = Config.RoundTime - Config.OutageInterval
	local winner: ("Survivors" | "Shadows")? = nil
	countdown("Round", Config.RoundTime, function(t)
		if t == Config.TrainDoorsOpenAt then
			Train.open()
			announce("The last train has arrived on the platform. Board it!", "Train")
		elseif t == Config.FinalWarningAt then
			announce("FINAL CALL: the last train departs in " .. t .. " seconds!", "Danger")
		end
		if t <= nextOutage and t > 0 then
			nextOutage -= Config.OutageInterval
			local cut = Power.cutRandom()
			if cut then
				announce("Power failure: " .. Zones.ById[cut].name, "Power")
			end
		end
		local survivors, shadows, escaped = counts()
		if survivors == 0 then
			winner = if escaped > 0 then "Survivors" else "Shadows"
			return true
		end
		if shadows == 0 then
			ShadowBot.spawn(near(refs.shadowSpawns))
		end
		return false
	end)
	local _, _, escaped = counts()
	return winner or (if escaped > 0 then "Survivors" else "Shadows")
end

local function results(winner: "Survivors" | "Shadows")
	Train.depart()
	set("Result", winner)
	local escaped, consumed = {}, 0
	for player, d in Roster.all() do
		if d.role == "Escaped" then
			table.insert(escaped, player.DisplayName)
		elseif d.role ~= "Lobby" then
			consumed += 1
		end
	end
	Net.event("RoundResult"):FireAllClients(winner, escaped, consumed)
	countdown("Results", Config.ResultsTime)
end

function Round.init(mapRefs: MapBuilder.Refs)
	refs = mapRefs
	Roster.onCharacter = onCharacter
	Tagging.onChanged = function()
		counts()
	end
	Breakers.onNoise = ShadowBot.alert
	Roster.addSpeedModifier(function(d, position)
		return if d.role == "Shadow" and Power.isDark(Zones.at(position)) then Config.ShadowDarkBonus else 1
	end)
	Roster.addSpeedModifier(Glowsticks.speedModifier)

	-- Late joiners: survivors while hiding, Shadows once the hunt is on.
	Players.PlayerAdded:Connect(function(player)
		local p = phase()
		if p == "Hiding" then
			Roster.setRole(player, "Survivor")
			Roster.resetForRound(player)
		elseif p == "Round" then
			Roster.setRole(player, "Shadow")
		end
		counts()
	end)
	Players.PlayerRemoving:Connect(function()
		task.defer(counts)
	end)
end

function Round.run()
	while true do
		lobby()
		local secret = hiding()
		results(main(secret))
	end
end

return Round
