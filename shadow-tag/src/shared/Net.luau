--!strict
-- Remote events and the replicated GameState folder. The server creates
-- them on first access; clients wait for them to replicate.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local IS_SERVER = RunService:IsServer()

local REMOTES = {
	-- client -> server
	"SetSprint", -- (wantsSprint: boolean)
	"SetCrouch", -- (wantsCrouch: boolean)
	"ToggleFlashlight", -- ()
	"ThrowGlowstick", -- (direction: Vector3)
	-- server -> client
	"Announce", -- (text: string, kind: string)
	"Noise", -- (position: Vector3, kind: string)
	"Tagged", -- (victimName: string, position: Vector3)
	"RoundResult", -- (winner: "Survivors" | "Shadows", escaped: {string}, consumed: number)
}

local Net = {}

local function folder(name: string): Folder
	if IS_SERVER then
		local existing = ReplicatedStorage:FindFirstChild(name)
		if existing then
			return existing :: Folder
		end
		local created = Instance.new("Folder")
		created.Name = name
		created.Parent = ReplicatedStorage
		return created
	end
	return ReplicatedStorage:WaitForChild(name) :: Folder
end

function Net.event(name: string): RemoteEvent
	assert(table.find(REMOTES, name), "Unknown remote " .. name)
	local remotes = folder("Remotes")
	if IS_SERVER then
		local existing = remotes:FindFirstChild(name)
		if existing then
			return existing :: RemoteEvent
		end
		local remote = Instance.new("RemoteEvent")
		remote.Name = name
		remote.Parent = remotes
		return remote
	end
	return remotes:WaitForChild(name) :: RemoteEvent
end

-- Attributes on this folder carry round state to every client:
-- Phase, TimeLeft, Survivors, Shadows, Escaped, TrainOpen, Zone_<id>.
function Net.state(): Folder
	return folder("GameState")
end

function Net.init()
	for _, name in REMOTES do
		Net.event(name)
	end
	Net.state()
end

return Net
