--!strict
-- All 2D UI: timer, team counts, zone, stamina/battery bars, glowsticks,
-- announcements, result screen, settings menu and mobile buttons.

local Players = game:GetService("Players")
local SoundService = game:GetService("SoundService")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Config = require(Shared.Config)
local Net = require(Shared.Net)
local Sounds = require(Shared.Sounds)

local Input = require(script.Parent.Input)

local player = Players.LocalPlayer
local state = Net.state()

local PANEL = Color3.fromRGB(12, 12, 16)
local WHITE = Color3.fromRGB(235, 238, 245)
local GLOW = Color3.fromRGB(40, 255, 200)
local KIND_COLORS = {
	Danger = Color3.fromRGB(255, 70, 60),
	Power = Color3.fromRGB(255, 190, 40),
	Train = Color3.fromRGB(90, 255, 140),
	Escape = Color3.fromRGB(90, 255, 140),
	Secret = Color3.fromRGB(190, 120, 255),
	Phase = WHITE,
}
local ROLE_TEXT = {
	Lobby = "LOBBY  -  the next round starts soon",
	Survivor = "SURVIVOR  -  stay out of the dark, board the last train",
	Transforming = "CONSUMED...",
	Shadow = "SHADOW  -  tag every survivor before the train leaves",
	Escaped = "ESCAPED  -  you made the last train",
}

local Hud = {}

local function new(className: string, props: { [string]: any }, parent: Instance?): any
	local inst = Instance.new(className) :: any
	for key, value in props do
		inst[key] = value
	end
	inst.Parent = parent
	return inst
end

local function panel(props: { [string]: any }, parent: Instance): Frame
	props.BackgroundColor3 = PANEL
	props.BackgroundTransparency = props.BackgroundTransparency or 0.3
	props.BorderSizePixel = 0
	local frame = new("Frame", props, parent)
	new("UICorner", { CornerRadius = UDim.new(0, 10) }, frame)
	return frame
end

local function text(props: { [string]: any }, parent: Instance): TextLabel
	props.BackgroundTransparency = 1
	props.Font = props.Font or Enum.Font.GothamBold
	props.TextColor3 = props.TextColor3 or WHITE
	props.TextScaled = true
	return new("TextLabel", props, parent)
end

local function formatTime(t: number): string
	return string.format("%d:%02d", t // 60, t % 60)
end

-- Builders --------------------------------------------------------------------

local gui = new("ScreenGui", {
	Name = "ShadowTagHud",
	ResetOnSpawn = false,
	IgnoreGuiInset = true,
	ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
}, player:WaitForChild("PlayerGui"))

local top = panel({ AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.new(0.5, 0, 0, 64), Size = UDim2.fromOffset(320, 84) }, gui)
local phaseLabel = text({ Position = UDim2.new(0, 0, 0, 6), Size = UDim2.new(1, 0, 0, 16), TextColor3 = GLOW }, top)
local timerLabel = text({ Position = UDim2.new(0, 0, 0, 22), Size = UDim2.new(1, 0, 0, 36), Font = Enum.Font.GothamBlack }, top)
local countsLabel = text({ Position = UDim2.new(0, 0, 0, 60), Size = UDim2.new(1, 0, 0, 16) }, top)
local zoneLabel = text({ AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.new(0.5, 0, 0, 152), Size = UDim2.fromOffset(420, 18) }, gui)
local roleLabel = text({ AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.new(0.5, 0, 0, 174), Size = UDim2.fromOffset(520, 18), TextColor3 = GLOW }, gui)

local vitals = panel({ AnchorPoint = Vector2.new(0, 1), Position = UDim2.new(0, 16, 1, -16), Size = UDim2.fromOffset(250, 104) }, gui)
local function bar(y: number, title: string, color: Color3): (Frame, Frame)
	local row = new("Frame", { BackgroundTransparency = 1, Position = UDim2.new(0, 12, 0, y), Size = UDim2.new(1, -24, 0, 26) }, vitals)
	text({ Size = UDim2.new(1, 0, 0, 12), Text = title, TextXAlignment = Enum.TextXAlignment.Left }, row)
	local back = new(
		"Frame",
		{ Position = UDim2.new(0, 0, 0, 15), Size = UDim2.new(1, 0, 0, 9), BackgroundColor3 = Color3.fromRGB(40, 40, 48), BorderSizePixel = 0 },
		row
	)
	new("UICorner", { CornerRadius = UDim.new(1, 0) }, back)
	local fill = new("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = color, BorderSizePixel = 0 }, back)
	new("UICorner", { CornerRadius = UDim.new(1, 0) }, fill)
	return row, fill
end
local _, staminaFill = bar(10, "STAMINA", Color3.fromRGB(90, 200, 255))
local batteryRow, batteryFill = bar(40, "FLASHLIGHT  [F]", Color3.fromRGB(255, 220, 110))
local glowLabel =
	text({ Position = UDim2.new(0, 12, 0, 74), Size = UDim2.new(1, -24, 0, 18), TextColor3 = GLOW, TextXAlignment = Enum.TextXAlignment.Left }, vitals)

local announceLabel = text({
	AnchorPoint = Vector2.new(0.5, 0.5),
	Position = UDim2.fromScale(0.5, 0.32),
	Size = UDim2.new(0.8, 0, 0, 40),
	Font = Enum.Font.GothamBlack,
	TextTransparency = 1,
	TextStrokeTransparency = 1,
}, gui)

local result =
	new("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = Color3.new(0, 0, 0), BackgroundTransparency = 0.25, Visible = false, ZIndex = 5 }, gui)
local resultTitle = text(
	{ AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.42), Size = UDim2.new(0.85, 0, 0, 64), Font = Enum.Font.GothamBlack, ZIndex = 5 },
	result
)
local resultBody = text({ AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.52), Size = UDim2.new(0.8, 0, 0, 26), ZIndex = 5 }, result)
local resultTimer =
	text({ AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.6), Size = UDim2.new(0.6, 0, 0, 20), TextColor3 = GLOW, ZIndex = 5 }, result)

-- Settings ----------------------------------------------------------------------

local settingsPanel = panel(
	{ AnchorPoint = Vector2.new(1, 0), Position = UDim2.new(1, -16, 0, 116), Size = UDim2.fromOffset(260, 196), Visible = false, BackgroundTransparency = 0.1 },
	gui
)
text({ Position = UDim2.new(0, 0, 0, 10), Size = UDim2.new(1, 0, 0, 20), Text = "SETTINGS", Font = Enum.Font.GothamBlack }, settingsPanel)
local gear = new("TextButton", {
	AnchorPoint = Vector2.new(1, 0),
	Position = UDim2.new(1, -16, 0, 64),
	Size = UDim2.fromOffset(44, 44),
	BackgroundColor3 = PANEL,
	BackgroundTransparency = 0.3,
	Text = "⚙",
	TextScaled = true,
	TextColor3 = WHITE,
	Font = Enum.Font.GothamBold,
}, gui)
new("UICorner", { CornerRadius = UDim.new(1, 0) }, gear)
gear.Activated:Connect(function()
	settingsPanel.Visible = not settingsPanel.Visible
end)

local function slider(y: number, title: string, initial: number, onChange: (number) -> ())
	text({ Position = UDim2.new(0, 16, 0, y), Size = UDim2.new(1, -32, 0, 14), Text = title, TextXAlignment = Enum.TextXAlignment.Left }, settingsPanel)
	local track = new("TextButton", {
		Position = UDim2.new(0, 16, 0, y + 22),
		Size = UDim2.new(1, -32, 0, 18),
		BackgroundColor3 = Color3.fromRGB(40, 40, 48),
		Text = "",
		AutoButtonColor = false,
	}, settingsPanel)
	new("UICorner", { CornerRadius = UDim.new(1, 0) }, track)
	local fill = new("Frame", { BackgroundColor3 = GLOW, BorderSizePixel = 0 }, track)
	new("UICorner", { CornerRadius = UDim.new(1, 0) }, fill)
	local function set(alpha: number)
		alpha = math.clamp(alpha, 0, 1)
		fill.Size = UDim2.fromScale(alpha, 1)
		onChange(alpha)
	end
	local dragging = false
	local function follow(x: number)
		set((x - track.AbsolutePosition.X) / track.AbsoluteSize.X)
	end
	track.InputBegan:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
			dragging = true
			follow(input.Position.X)
		end
	end)
	UserInputService.InputChanged:Connect(function(input)
		if dragging and (input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch) then
			follow(input.Position.X)
		end
	end)
	UserInputService.InputEnded:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
			dragging = false
		end
	end)
	set(initial)
end

slider(42, "MUSIC", 0.8, function(a)
	Sounds.group("Music").Volume = a
end)
slider(92, "SOUND", 1, function(a)
	Sounds.group("SFX").Volume = a
end)
slider(142, "CAMERA SENSITIVITY", 0.45, function(a)
	UserInputService.MouseDeltaSensitivity = 0.2 + a * 1.8
end)

-- Mobile buttons --------------------------------------------------------------------

local mobile = new("Frame", {
	AnchorPoint = Vector2.new(1, 1),
	Position = UDim2.new(1, -150, 1, -30),
	Size = UDim2.fromOffset(184, 184),
	BackgroundTransparency = 1,
	Visible = UserInputService.TouchEnabled,
}, gui)
local function touchButton(label: string, col: number, row: number, onDown: () -> (), onUp: (() -> ())?)
	local button = new("TextButton", {
		Position = UDim2.fromOffset(col * 96, row * 96),
		Size = UDim2.fromOffset(88, 88),
		BackgroundColor3 = PANEL,
		BackgroundTransparency = 0.25,
		Text = label,
		TextColor3 = WHITE,
		TextScaled = true,
		Font = Enum.Font.GothamBlack,
	}, mobile)
	new("UICorner", { CornerRadius = UDim.new(1, 0) }, button)
	new("UIPadding", { PaddingLeft = UDim.new(0, 14), PaddingRight = UDim.new(0, 14) }, button)
	new("UIStroke", { Color = GLOW, Transparency = 0.5, Thickness = 2 }, button)
	button.InputBegan:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.Touch or input.UserInputType == Enum.UserInputType.MouseButton1 then
			onDown()
		end
	end)
	if onUp then
		button.InputEnded:Connect(function(input)
			if input.UserInputType == Enum.UserInputType.Touch or input.UserInputType == Enum.UserInputType.MouseButton1 then
				onUp()
			end
		end)
	end
end
touchButton("SPRINT", 0, 0, function()
	Input.setSprint(true)
end, function()
	Input.setSprint(false)
end)
touchButton("LIGHT", 1, 0, Input.flashlight)
touchButton("GLOW", 0, 1, Input.glowstick)
touchButton("CROUCH", 1, 1, Input.toggleCrouch)
UserInputService.LastInputTypeChanged:Connect(function(kind)
	if kind == Enum.UserInputType.Touch then
		mobile.Visible = true
	elseif kind == Enum.UserInputType.Keyboard or kind == Enum.UserInputType.MouseButton1 then
		mobile.Visible = false
	end
end)

-- Updates -------------------------------------------------------------------------

local secret = false
local announceToken = 0

local function announce(message: string, kind: string)
	announceToken += 1
	local token = announceToken
	announceLabel.Text = message
	announceLabel.TextColor3 = KIND_COLORS[kind] or WHITE
	announceLabel.TextTransparency = 0
	announceLabel.TextStrokeTransparency = 0.4
	Sounds.play("Chime", SoundService)
	task.delay(4, function()
		if token == announceToken then
			TweenService:Create(announceLabel, TweenInfo.new(0.8), { TextTransparency = 1, TextStrokeTransparency = 1 }):Play()
		end
	end)
end

local function refreshState()
	local phase = state:GetAttribute("Phase") or "Lobby"
	local t = state:GetAttribute("TimeLeft") or 0
	phaseLabel.Text = if phase == "Round" then "LAST TRAIN DEPARTS IN" elseif phase == "Hiding" then "HIDE!" else string.upper(phase)
	timerLabel.Text = formatTime(t)
	timerLabel.TextColor3 = if phase == "Round" and t <= Config.FinalWarningAt then KIND_COLORS.Danger else WHITE
	countsLabel.Text = string.format(
		"SURVIVORS %d     SHADOWS %d     ESCAPED %d",
		state:GetAttribute("Survivors") or 0,
		state:GetAttribute("Shadows") or 0,
		state:GetAttribute("Escaped") or 0
	)
	result.Visible = phase == "Results"
	resultTimer.Text = "Next round in " .. t .. "s"
end

local function refreshPlayer()
	local role = player:GetAttribute("Role") or "Lobby"
	if role ~= "Survivor" then
		secret = false
	end
	roleLabel.Text = if secret then "YOU ARE THE SHADOW  -  act normal, you emerge soon" else ROLE_TEXT[role] or ""
	roleLabel.TextColor3 = if secret or role == "Shadow" then KIND_COLORS.Secret else GLOW
	staminaFill.Size = UDim2.fromScale((player:GetAttribute("Stamina") or 0) / Config.StaminaMax, 1)
	local battery = (player:GetAttribute("Battery") or 0) / Config.BatteryMax
	batteryFill.Size = UDim2.fromScale(battery, 1)
	batteryFill.BackgroundColor3 = if battery * 100 < Config.BatteryFlickerBelow then KIND_COLORS.Danger else Color3.fromRGB(255, 220, 110)
	local human = role == "Survivor" or role == "Lobby"
	batteryRow.Visible = human
	glowLabel.Visible = role == "Survivor"
	glowLabel.Text = string.format("GLOWSTICKS  %d / %d   [CLICK]", player:GetAttribute("Glowsticks") or 0, Config.GlowsticksMax)
end

function Hud.setZone(label: string, color: Color3)
	zoneLabel.Text = label
	zoneLabel.TextColor3 = color
end

function Hud.init()
	state.AttributeChanged:Connect(refreshState)
	player.AttributeChanged:Connect(refreshPlayer)
	refreshState()
	refreshPlayer()

	Net.event("Announce").OnClientEvent:Connect(function(message: string, kind: string)
		if kind == "Secret" then
			secret = true
			refreshPlayer()
		end
		announce(message, kind)
	end)
	Net.event("Tagged").OnClientEvent:Connect(function(victim: string)
		announce(victim .. " was consumed by the dark", "Danger")
	end)
	Net.event("RoundResult").OnClientEvent:Connect(function(winner: string, escaped: { string }, consumed: number)
		local survivorsWon = winner == "Survivors"
		resultTitle.Text = if survivorsWon then "SURVIVORS ESCAPED" else "THE SHADOWS CONSUMED THE STATION"
		resultTitle.TextColor3 = if survivorsWon then KIND_COLORS.Train else KIND_COLORS.Danger
		resultBody.Text = if #escaped > 0
			then "On the last train: " .. table.concat(escaped, ", ") .. "   |   Consumed: " .. consumed
			else "Nobody made the last train.   Consumed: " .. consumed
	end)
end

return Hud
