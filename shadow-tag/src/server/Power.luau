--!strict
-- Zone power: rolling blackouts, breaker restores and the global lighting
-- setup. Zone state replicates through GameState attributes (Zone_<id>) so
-- clients can darken their ambient light per zone.

local Lighting = game:GetService("Lighting")
local SoundService = game:GetService("SoundService")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Net = require(Shared.Net)
local Sounds = require(Shared.Sounds)
local Zones = require(Shared.Zones)

local MapBuilder = require(script.Parent.MapBuilder)
local C = MapBuilder.Palette

export type State = "On" | "Off" | "Restored"

local Power = {}

local refs: MapBuilder.Refs
local states: { [string]: State } = {}
local epoch = 0 -- bumps on reset so stale restore timers do nothing
local changed = Instance.new("BindableEvent")
Power.Changed = changed.Event :: RBXScriptSignal -- (zoneId, state)

local LAMP = {
	On = Color3.fromRGB(70, 255, 110),
	Off = Color3.fromRGB(255, 50, 40),
	Restored = Color3.fromRGB(255, 190, 40),
}

local function setupEnvironment()
	-- Near-black ambient: fixtures, flashlights, glowsticks and warning lamps
	-- are the only real light. Clients retune Ambient per zone.
	Lighting.Ambient = Color3.fromRGB(10, 10, 14)
	Lighting.OutdoorAmbient = Color3.fromRGB(8, 8, 12)
	Lighting.Brightness = 0.3
	Lighting.ClockTime = 0
	Lighting.GlobalShadows = true
	Lighting.EnvironmentDiffuseScale = 0.1
	Lighting.EnvironmentSpecularScale = 0.7 -- wet sheen on tile and concrete
	Lighting.ExposureCompensation = 0

	local function effect(className: string, name: string): Instance
		local existing = Lighting:FindFirstChild(name)
		if existing then
			return existing
		end
		local inst = Instance.new(className)
		inst.Name = name
		inst.Parent = Lighting
		return inst
	end

	local atmosphere = effect("Atmosphere", "StationAir") :: Atmosphere
	-- Visibility of roughly 40-70 studs. Atmosphere replaces Lighting.Fog*,
	-- which Roblox ignores while an Atmosphere exists.
	atmosphere.Density = 0.55
	atmosphere.Offset = 0.1
	atmosphere.Color = Color3.fromRGB(20, 22, 28)
	atmosphere.Decay = Color3.fromRGB(8, 8, 12)
	atmosphere.Glare = 0
	atmosphere.Haze = 2

	local bloom = effect("BloomEffect", "StationBloom") :: BloomEffect
	bloom.Intensity = 0.7
	bloom.Size = 28
	bloom.Threshold = 1.6

	local grade = effect("ColorCorrectionEffect", "StationGrade") :: ColorCorrectionEffect
	grade.Contrast = 0.12
	grade.Saturation = -0.2
	grade.TintColor = Color3.fromRGB(225, 230, 245)

	SoundService.AmbientReverb = Enum.ReverbType.SewerPipe
end

local function apply(zone: string, state: State)
	states[zone] = state
	Net.state():SetAttribute("Zone_" .. zone, state)
	local on = state ~= "Off"

	for _, p in refs.fixtures[zone] do
		local lit = on and not p:GetAttribute("Dead")
		p.Material = if lit then Enum.Material.Neon else Enum.Material.SmoothPlastic
		p.Color = if lit then C.fixtureOn else C.fixtureOff
		local light = p:FindFirstChildWhichIsA("Light")
		if light then
			light.Enabled = lit
		end
	end
	for _, p in refs.emergency[zone] do
		p.Material = if on then Enum.Material.SmoothPlastic else Enum.Material.Neon
		p.Color = if on then C.fixtureOff else C.emergency
		local light = p:FindFirstChildWhichIsA("Light")
		if light then
			light.Enabled = not on
		end
	end
	for _, p in refs.powered[zone] do
		p.Material = if on then Enum.Material.Neon else Enum.Material.SmoothPlastic
		p.Color = if on then (p:GetAttribute("OnColor") :: Color3? or C.fixtureOn) else Color3.fromRGB(20, 22, 26)
	end
	local breaker = refs.breakers[zone]
	if breaker then
		breaker.lamp.Color = LAMP[state]
	end
	changed:Fire(zone, state)
end

local function soundAt(zone: string, name: string)
	local fixture = refs.fixtures[zone][1]
	if fixture then
		Sounds.play(name, fixture)
	end
end

function Power.init(mapRefs: MapBuilder.Refs)
	refs = mapRefs
	setupEnvironment()
	Power.resetAll()
end

function Power.resetAll()
	epoch += 1
	for _, zone in Zones.List do
		apply(zone.id, "On")
	end
end

function Power.state(zone: string): State
	return states[zone] or "On"
end

function Power.isDark(zone: string?): boolean
	return zone ~= nil and states[zone] == "Off"
end

-- Cuts power to a random zone that still has it. Returns the zone or nil.
function Power.cutRandom(): string?
	local candidates = {}
	for _, zone in Zones.List do
		if states[zone.id] == "On" then
			table.insert(candidates, zone.id)
		end
	end
	if #candidates == 0 then
		return nil
	end
	local zone = candidates[math.random(#candidates)]
	apply(zone, "Off")
	soundAt(zone, "PowerDown")
	return zone
end

-- Temporarily restores a dark zone. Returns false if it was not dark.
function Power.restore(zone: string, duration: number): boolean
	if states[zone] ~= "Off" then
		return false
	end
	apply(zone, "Restored")
	local myEpoch = epoch
	task.delay(duration, function()
		if epoch == myEpoch and states[zone] == "Restored" then
			apply(zone, "Off")
			soundAt(zone, "PowerDown")
		end
	end)
	return true
end

return Power
