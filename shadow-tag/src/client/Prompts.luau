--!strict
-- Large, touch-friendly UI for the custom-style ProximityPrompts (breakers,
-- train doors). Hidden from Shadows, who cannot use either.

local Players = game:GetService("Players")
local ProximityPromptService = game:GetService("ProximityPromptService")
local TweenService = game:GetService("TweenService")

local player = Players.LocalPlayer
local GLOW = Color3.fromRGB(40, 255, 200)

local Prompts = {}

local function build(prompt: ProximityPrompt, inputType: Enum.ProximityPromptInputType)
	local adornee = prompt.Parent
	if not adornee or not (adornee:IsA("BasePart") or adornee:IsA("Attachment")) then
		return
	end
	local touch = inputType == Enum.ProximityPromptInputType.Touch
	local board = Instance.new("BillboardGui")
	board.Name = "Prompt"
	board.Adornee = adornee
	board.AlwaysOnTop = true
	board.Size = if touch then UDim2.fromOffset(280, 96) else UDim2.fromOffset(240, 72)
	board.StudsOffset = Vector3.new(0, 3, 0)
	board.Active = true
	board.Parent = player:WaitForChild("PlayerGui")

	local button = Instance.new("TextButton")
	button.Size = UDim2.fromScale(1, 1)
	button.BackgroundColor3 = Color3.fromRGB(12, 12, 16)
	button.BackgroundTransparency = 0.15
	button.AutoButtonColor = false
	button.Text = ""
	button.Parent = board
	Instance.new("UICorner").Parent = button
	local stroke = Instance.new("UIStroke")
	stroke.Color = GLOW
	stroke.Thickness = 2
	stroke.Parent = button

	local fill = Instance.new("Frame")
	fill.BackgroundColor3 = GLOW
	fill.BackgroundTransparency = 0.6
	fill.BorderSizePixel = 0
	fill.Size = UDim2.fromScale(0, 1)
	fill.Parent = button
	Instance.new("UICorner").Parent = fill

	local key = if touch then "TAP" else prompt.KeyboardKeyCode.Name
	if inputType == Enum.ProximityPromptInputType.Gamepad then
		key = prompt.GamepadKeyCode.Name:gsub("Button", "")
	end
	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Position = UDim2.fromScale(0.05, 0.08)
	label.Size = UDim2.fromScale(0.9, 0.55)
	label.Font = Enum.Font.GothamBlack
	label.TextScaled = true
	label.TextColor3 = Color3.new(1, 1, 1)
	label.Text = string.format("[%s] %s", key, prompt.ActionText)
	label.Parent = button
	local sub = label:Clone()
	sub.Position = UDim2.fromScale(0.05, 0.62)
	sub.Size = UDim2.fromScale(0.9, 0.3)
	sub.Font = Enum.Font.GothamBold
	sub.TextColor3 = GLOW
	sub.Text = prompt.ObjectText .. (if prompt.HoldDuration > 0 then "  (hold)" else "")
	sub.Parent = button

	button.InputBegan:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.Touch or input.UserInputType == Enum.UserInputType.MouseButton1 then
			prompt:InputHoldBegin()
		end
	end)
	button.InputEnded:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.Touch or input.UserInputType == Enum.UserInputType.MouseButton1 then
			prompt:InputHoldEnd()
		end
	end)

	local tween: Tween? = nil
	local connections = {
		prompt.PromptButtonHoldBegan:Connect(function()
			tween = TweenService:Create(fill, TweenInfo.new(prompt.HoldDuration), { Size = UDim2.fromScale(1, 1) });
			(tween :: Tween):Play()
		end),
		prompt.PromptButtonHoldEnded:Connect(function()
			if tween then
				tween:Cancel()
			end
			fill.Size = UDim2.fromScale(0, 1)
		end),
	}
	prompt.PromptHidden:Once(function()
		for _, c in connections do
			c:Disconnect()
		end
		board:Destroy()
	end)
end

function Prompts.init()
	ProximityPromptService.PromptShown:Connect(function(prompt, inputType)
		if prompt.Style ~= Enum.ProximityPromptStyle.Custom then
			return
		end
		local role = player:GetAttribute("Role")
		if role ~= "Survivor" then
			return
		end
		build(prompt, inputType)
	end)
end

return Prompts
