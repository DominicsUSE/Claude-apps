-- Sends where the player is aiming; the server decides what gets hit.

local UserInputService = game:GetService("UserInputService")

local tool = script.Parent
local fire = tool:WaitForChild("Fire")

tool.Activated:Connect(function()
	local mouse = UserInputService:GetMouseLocation()
	local ray = workspace.CurrentCamera:ViewportPointToRay(mouse.X, mouse.Y)
	fire:FireServer(ray.Direction)
end)
