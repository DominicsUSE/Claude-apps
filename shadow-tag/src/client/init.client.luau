--!strict
-- Client entry point.

local StarterGui = game:GetService("StarterGui")

if not game:IsLoaded() then
	game.Loaded:Wait()
end

local Audio = require(script.Audio)
local Hud = require(script.Hud)
local Input = require(script.Input)
local Prompts = require(script.Prompts)
local World = require(script.World)

Input.init()
Hud.init()
Prompts.init()
World.init(Hud.setZone)
Audio.init()

-- Resetting would let players dodge their role; the server also treats a
-- survivor death as being consumed.
task.spawn(function()
	for _ = 1, 10 do
		if pcall(StarterGui.SetCore, StarterGui, "ResetButtonCallback", false) then
			return
		end
		task.wait(1)
	end
end)
