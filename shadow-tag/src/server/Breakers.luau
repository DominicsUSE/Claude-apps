--!strict
-- Breaker boxes in the maintenance room. Holding one restores a dark zone
-- for a short time, but the clunk and alarm reveal the user's rough
-- position to every Shadow.

local Players = game:GetService("Players")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Config = require(Shared.Config)
local Net = require(Shared.Net)
local Sounds = require(Shared.Sounds)
local Zones = require(Shared.Zones)

local MapBuilder = require(script.Parent.MapBuilder)
local Power = require(script.Parent.Power)
local Roster = require(script.Parent.Roster)

local Breakers = {}

-- Set by Round so the AI Shadow can investigate breaker noise.
Breakers.onNoise = nil :: ((position: Vector3) -> ())?

local boxes: { [string]: BasePart } = {}
local prompts: { [string]: ProximityPrompt } = {}
local cooldownUntil: { [string]: number } = {}

local function refresh(zone: string)
	local prompt = prompts[zone]
	if prompt then
		prompt.Enabled = Net.state():GetAttribute("Phase") == "Round" and Power.state(zone) == "Off" and os.clock() >= (cooldownUntil[zone] or 0)
	end
end

local function refreshAll()
	for zone in prompts do
		refresh(zone)
	end
end

local function revealNoise(position: Vector3)
	local r = Config.BreakerNoiseRadius
	local jittered = position + Vector3.new(math.random(-r, r), 0, math.random(-r, r))
	for _, player in Players:GetPlayers() do
		local d = Roster.get(player)
		if d and (d.role == "Shadow" or d.role == "Transforming") then
			Net.event("Noise"):FireClient(player, jittered, "Breaker")
		end
	end
	if Breakers.onNoise then
		Breakers.onNoise(jittered)
	end
end

local function tryUse(player: Player, zone: string)
	local d = Roster.get(player)
	local root = Roster.rootOf(player)
	local box = boxes[zone]
	if not d or not root or d.role ~= "Survivor" then
		return
	end
	if Net.state():GetAttribute("Phase") ~= "Round" or os.clock() < (cooldownUntil[zone] or 0) then
		return
	end
	if (root.Position - box.Position).Magnitude > 12 then
		return
	end
	if not Power.restore(zone, Config.BreakerRestoreTime) then
		return
	end
	local lockout = Config.BreakerRestoreTime + Config.BreakerCooldown
	cooldownUntil[zone] = os.clock() + lockout
	task.delay(lockout, refresh, zone)
	refresh(zone)

	Sounds.play("BreakerClunk", box)
	Sounds.play("BreakerAlarm", box)
	revealNoise(box.Position)
	Net.event("Announce")
		:FireAllClients(string.format("%s restored power to %s for %ds", player.DisplayName, Zones.ById[zone].name, Config.BreakerRestoreTime), "Power")
end

function Breakers.reset()
	table.clear(cooldownUntil)
	refreshAll()
end

function Breakers.init(refs: MapBuilder.Refs)
	for zone, breaker in refs.breakers do
		boxes[zone] = breaker.box
		local prompt = Instance.new("ProximityPrompt")
		prompt.Name = "BreakerPrompt"
		prompt.ActionText = "Restore Power"
		prompt.ObjectText = Zones.ById[zone].name
		prompt.HoldDuration = Config.BreakerHoldTime
		prompt.MaxActivationDistance = 8
		prompt.RequiresLineOfSight = false
		prompt.KeyboardKeyCode = Enum.KeyCode.E
		prompt.GamepadKeyCode = Enum.KeyCode.ButtonX
		prompt.Style = Enum.ProximityPromptStyle.Custom
		prompt:SetAttribute("Kind", "Breaker")
		prompt.Enabled = false
		prompt.Parent = breaker.box
		prompt.Triggered:Connect(function(player)
			tryUse(player, zone)
		end)
		prompts[zone] = prompt
	end
	Power.Changed:Connect(function(zone: string)
		refresh(zone)
	end)
	Net.state():GetAttributeChangedSignal("Phase"):Connect(refreshAll)
end

return Breakers
