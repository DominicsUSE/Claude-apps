--!strict
-- Server entry point: builds the station and starts the round loop.

local Players = game:GetService("Players")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Net = require(Shared.Net)
local Sounds = require(Shared.Sounds)

local Breakers = require(script.Breakers)
local Glowsticks = require(script.Glowsticks)
local MapBuilder = require(script.MapBuilder)
local Power = require(script.Power)
local Roster = require(script.Roster)
local Round = require(script.Round)
local ShadowBot = require(script.ShadowBot)
local Tagging = require(script.Tagging)
local Train = require(script.Train)

Players.RespawnTime = 3
Net.init()
Sounds.group("Music")
Sounds.group("SFX")

local refs = MapBuilder.build()
Power.init(refs)
Roster.init()
Glowsticks.init(refs)
Train.init(refs)
Breakers.init(refs)
Tagging.init(refs)
ShadowBot.init(refs)
Round.init(refs)
task.spawn(Round.run)
