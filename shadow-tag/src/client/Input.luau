--!strict
-- Keyboard / gamepad bindings. Mobile buttons in Hud call the same actions.
-- The client only sends intents; the server decides what actually happens.

local Players = game:GetService("Players")
local UserInputService = game:GetService("UserInputService")
local Workspace = game:GetService("Workspace")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Net = require(Shared.Net)

local Input = {}

local sprinting = false
local crouched = false

function Input.setSprint(on: boolean)
	if sprinting ~= on then
		sprinting = on
		Net.event("SetSprint"):FireServer(on)
	end
end

function Input.toggleCrouch()
	crouched = not crouched
	Net.event("SetCrouch"):FireServer(crouched)
end

function Input.flashlight()
	Net.event("ToggleFlashlight"):FireServer()
end

function Input.glowstick()
	local camera = Workspace.CurrentCamera
	Net.event("ThrowGlowstick"):FireServer(camera and camera.CFrame.LookVector or Vector3.zero)
end

local SPRINT = { [Enum.KeyCode.LeftShift] = true, [Enum.KeyCode.ButtonL3] = true }
local CROUCH = { [Enum.KeyCode.C] = true, [Enum.KeyCode.LeftControl] = true, [Enum.KeyCode.ButtonB] = true }
local LIGHT = { [Enum.KeyCode.F] = true, [Enum.KeyCode.ButtonY] = true }
local THROW = { [Enum.KeyCode.G] = true, [Enum.KeyCode.ButtonR2] = true }

function Input.init()
	UserInputService.InputBegan:Connect(function(input, processed)
		if processed then
			return
		end
		local key = input.KeyCode
		if SPRINT[key] then
			Input.setSprint(true)
		elseif CROUCH[key] then
			Input.toggleCrouch()
		elseif LIGHT[key] then
			Input.flashlight()
		elseif THROW[key] or input.UserInputType == Enum.UserInputType.MouseButton1 then
			Input.glowstick()
		end
	end)
	UserInputService.InputEnded:Connect(function(input)
		if SPRINT[input.KeyCode] then
			Input.setSprint(false)
		end
	end)
	-- The server resets crouch on every spawn.
	Players.LocalPlayer.CharacterAdded:Connect(function()
		crouched = false
		sprinting = false
	end)
end

return Input
