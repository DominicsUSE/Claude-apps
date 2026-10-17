--!strict
-- The last train: doors, boarding (server-validated ProximityPrompts) and
-- the departure run into the east tunnel.

local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Net = require(Shared.Net)
local Sounds = require(Shared.Sounds)

local MapBuilder = require(script.Parent.MapBuilder)
local Roster = require(script.Parent.Roster)

local DOOR_SLIDE = 2.4
local DEPART_DISTANCE = 400
local DEPART_TIME = 9
local LAMP_OPEN = Color3.fromRGB(70, 255, 110)
local LAMP_CLOSED = Color3.fromRGB(255, 40, 30)

local Train = {}

local train: MapBuilder.TrainRefs
local home: CFrame
local prompts: { ProximityPrompt } = {}
local seatOf: { [Player]: Seat } = {}
local departing: RBXScriptConnection?
local open = false

local function setDoors(isOpen: boolean, instant: boolean?)
	open = isOpen
	Net.state():SetAttribute("TrainOpen", isOpen)
	local info = TweenInfo.new(if instant then 0 else 1.2, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
	for _, door in train.doors do
		local shift = if isOpen then DOOR_SLIDE else 0
		local base = train.model:GetPivot() * home:Inverse()
		TweenService:Create(door.left, info, { CFrame = base * door.leftClosed * CFrame.new(-shift, 0, 0) }):Play()
		TweenService:Create(door.right, info, { CFrame = base * door.rightClosed * CFrame.new(shift, 0, 0) }):Play()
		door.lamp.Color = if isOpen then LAMP_OPEN else LAMP_CLOSED
	end
	for _, prompt in prompts do
		prompt.Enabled = isOpen
	end
	if not instant then
		Sounds.play("DoorSlide", train.doors[1].left)
	end
end

local function freeSeat(): Seat?
	for _, seat in train.seats do
		local taken = false
		for _, s in seatOf do
			if s == seat then
				taken = true
				break
			end
		end
		if not taken and not seat.Occupant then
			return seat
		end
	end
	return nil
end

-- Puts an escaped player's character into their seat (also used on respawn).
function Train.seat(player: Player)
	local seat = seatOf[player] or freeSeat()
	local character = player.Character
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	if not seat or not humanoid then
		return
	end
	seatOf[player] = seat
	Roster.teleport(player, seat.CFrame * CFrame.new(0, 2.5, 0))
	task.defer(function()
		if humanoid.Parent then
			seat:Sit(humanoid)
		end
	end)
end

local function tryBoard(player: Player, door: MapBuilder.TrainDoor)
	local d = Roster.get(player)
	local root = Roster.rootOf(player)
	if not open or not d or d.role ~= "Survivor" or not root then
		return
	end
	if Net.state():GetAttribute("Phase") ~= "Round" then
		return
	end
	if (root.Position - door.prompt.Position).Magnitude > 14 then
		return
	end
	Roster.setRole(player, "Escaped")
	local character = player.Character
	if character then
		Roster.removeFlashlight(character)
	end
	Train.seat(player)
	Net.event("Announce"):FireAllClients(player.DisplayName .. " boarded the last train!", "Escape")
end

function Train.init(refs: MapBuilder.Refs)
	train = refs.train
	home = train.model:GetPivot()
	for _, door in train.doors do
		local prompt = Instance.new("ProximityPrompt")
		prompt.Name = "BoardPrompt"
		prompt.ActionText = "Board Train"
		prompt.ObjectText = "Last Train"
		prompt.HoldDuration = 0.4
		prompt.MaxActivationDistance = 11
		prompt.RequiresLineOfSight = false
		prompt.KeyboardKeyCode = Enum.KeyCode.E
		prompt.GamepadKeyCode = Enum.KeyCode.ButtonX
		prompt.Style = Enum.ProximityPromptStyle.Custom
		prompt:SetAttribute("Kind", "Train")
		prompt.Enabled = false
		prompt.Parent = door.prompt
		prompt.Triggered:Connect(function(player)
			tryBoard(player, door)
		end)
		table.insert(prompts, prompt)
	end
	Train.reset()
end

function Train.reset()
	if departing then
		departing:Disconnect()
		departing = nil
	end
	table.clear(seatOf)
	train.model:PivotTo(home)
	setDoors(false, true)
end

function Train.open()
	if not open then
		setDoors(true)
		Sounds.play("TrainHorn", train.horn)
	end
end

-- Closes the doors, sounds the horn and pulls out into the tunnel. Seated
-- passengers are welded to anchored seats, so they ride along.
function Train.depart()
	if departing then
		return
	end
	setDoors(false)
	Sounds.play("TrainHorn", train.horn)
	local elapsed = -1.5 -- wait for the doors before rolling
	departing = RunService.Heartbeat:Connect(function(dt)
		elapsed += dt
		if elapsed <= 0 then
			return
		end
		local alpha = math.min(elapsed / DEPART_TIME, 1)
		local eased = alpha * alpha -- accelerate away
		train.model:PivotTo(home * CFrame.new(DEPART_DISTANCE * eased, 0, 0))
		if alpha >= 1 and departing then
			departing:Disconnect()
			departing = nil
		end
	end)
end

return Train
