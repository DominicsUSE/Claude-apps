--!strict
-- Sound catalogue. Every entry uses a sound that ships inside the Roblox
-- client (rbxasset://sounds/...) re-pitched to fit, so the game has audio
-- the moment it is opened. Swap `id` for licensed Creator Store audio
-- (rbxassetid://<number>) to upgrade; see README "Audio".

local SoundService = game:GetService("SoundService")
local RunService = game:GetService("RunService")

export type SoundDef = {
	id: string,
	volume: number,
	speed: number?,
	looped: boolean?,
	range: number?, -- RollOffMaxDistance for 3D sounds
	group: "Music" | "SFX",
}

local PING = "rbxasset://sounds/electronicpingshort.wav"
local WIND = "rbxasset://sounds/action_falling.mp3"
local THUMP = "rbxasset://sounds/collide.wav"

local Sounds = {}

Sounds.Defs = {
	AmbientMusic = { id = WIND, volume = 0.35, speed = 0.18, looped = true, group = "Music" },
	TrainRumble = { id = WIND, volume = 0.45, speed = 0.32, looped = true, group = "SFX" },
	Drip = { id = "rbxasset://sounds/impact_water.mp3", volume = 0.35, speed = 1.7, range = 70, group = "SFX" },
	LightBuzz = { id = PING, volume = 0.18, speed = 0.08, looped = true, range = 26, group = "SFX" },
	Heartbeat = { id = THUMP, volume = 0.8, speed = 0.42, group = "SFX" },
	TagSting = { id = PING, volume = 1, speed = 0.55, group = "SFX" },
	Transform = { id = "rbxasset://sounds/swordslash.wav", volume = 0.8, speed = 0.45, range = 80, group = "SFX" },
	BreakerClunk = { id = THUMP, volume = 1, speed = 0.7, range = 220, group = "SFX" },
	BreakerAlarm = { id = PING, volume = 1, speed = 0.35, range = 260, group = "SFX" },
	PowerDown = { id = PING, volume = 0.9, speed = 0.22, range = 200, group = "SFX" },
	TrainHorn = { id = PING, volume = 1, speed = 0.12, range = 600, group = "SFX" },
	DoorSlide = { id = WIND, volume = 0.7, speed = 1.3, range = 90, group = "SFX" },
	GlowstickCrack = { id = "rbxasset://sounds/unsheath.wav", volume = 0.7, speed = 1.5, range = 50, group = "SFX" },
	Pickup = { id = PING, volume = 0.5, speed = 1.6, range = 30, group = "SFX" },
	Chime = { id = PING, volume = 0.6, speed = 0.9, group = "SFX" },
} :: { [string]: SoundDef }

function Sounds.group(name: string): SoundGroup
	local existing = SoundService:FindFirstChild(name)
	if existing then
		return existing :: SoundGroup
	end
	if RunService:IsServer() then
		local group = Instance.new("SoundGroup")
		group.Name = name
		group.Volume = 1
		group.Parent = SoundService
		return group
	end
	return SoundService:WaitForChild(name) :: SoundGroup
end

-- Builds a Sound from the catalogue. Parent it to a BasePart/Attachment for
-- 3D falloff, or to SoundService/PlayerGui for 2D playback.
function Sounds.make(name: string, parent: Instance?): Sound
	local def = Sounds.Defs[name]
	assert(def, "Unknown sound " .. name)
	local sound = Instance.new("Sound")
	sound.Name = name
	sound.SoundId = def.id
	sound.Volume = def.volume
	sound.PlaybackSpeed = def.speed or 1
	sound.Looped = def.looped == true
	sound.RollOffMode = Enum.RollOffMode.InverseTapered
	sound.RollOffMinDistance = 6
	sound.RollOffMaxDistance = def.range or 120
	sound.SoundGroup = Sounds.group(def.group)
	sound.Parent = parent
	return sound
end

-- One-shot helper: plays and cleans up.
function Sounds.play(name: string, parent: Instance): Sound
	local sound = Sounds.make(name, parent)
	sound.Ended:Once(function()
		sound:Destroy()
	end)
	sound:Play()
	task.delay(12, function()
		if sound.Parent then
			sound:Destroy()
		end
	end)
	return sound
end

return Sounds
