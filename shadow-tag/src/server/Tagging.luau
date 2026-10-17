--!strict
-- Server-authoritative tagging. Every frame during a round, each Shadow
-- (player or AI) that is close enough to a survivor, with no wall between
-- them and no glowstick protecting the survivor, tags them. Clients never
-- report tags, so a tag cannot be forged from the client.

local CollectionService = game:GetService("CollectionService")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Config = require(Shared.Config)
local Net = require(Shared.Net)

local Glowsticks = require(script.Parent.Glowsticks)
local MapBuilder = require(script.Parent.MapBuilder)
local Roster = require(script.Parent.Roster)
local ShadowForm = require(script.Parent.ShadowForm)

local Tagging = {}

-- Set by Round: re-check win conditions whenever roles change.
Tagging.onChanged = nil :: (() -> ())?

local function changed()
	if Tagging.onChanged then
		Tagging.onChanged()
	end
end

function Tagging.tag(victim: Player)
	local d = Roster.get(victim)
	local character = victim.Character
	local root = Roster.rootOf(victim)
	if not d or d.role ~= "Survivor" or not character or not root then
		return
	end
	Roster.setRole(victim, "Transforming")
	Net.event("Tagged"):FireAllClients(victim.DisplayName, root.Position)
	ShadowForm.transform(character, Config.TransformTime, Config.NewShadowTagDelay, function()
		local current = Roster.get(victim)
		if current and current.role == "Transforming" then
			Roster.setRole(victim, "Shadow")
		end
		changed()
	end)
	changed()
end

function Tagging.init(refs: MapBuilder.Refs)
	local rayParams = RaycastParams.new()
	rayParams.FilterType = Enum.RaycastFilterType.Include
	rayParams.FilterDescendantsInstances = { refs.folder:FindFirstChild("Structure") :: Instance }

	RunService.Heartbeat:Connect(function()
		if Net.state():GetAttribute("Phase") ~= "Round" then
			return
		end
		local survivors = {}
		for player, d in Roster.all() do
			if d.role == "Survivor" then
				local root = Roster.rootOf(player)
				if root then
					table.insert(survivors, { player = player, root = root })
				end
			end
		end
		if #survivors == 0 then
			return
		end

		local now = os.clock()
		for _, model in CollectionService:GetTagged("ShadowCharacter") do
			local ready = model:GetAttribute("ReadyAt")
			local humanoid = model:FindFirstChildOfClass("Humanoid")
			local hunter = model:FindFirstChild("HumanoidRootPart") :: BasePart?
			if (typeof(ready) == "number" and ready > now) or not humanoid or humanoid.Health <= 0 or not hunter then
				continue
			end
			for _, s in survivors do
				local delta = s.root.Position - hunter.Position
				local flat = Vector3.new(delta.X, 0, delta.Z).Magnitude
				if flat <= Config.TagRange and math.abs(delta.Y) <= Config.TagVerticalRange then
					if not Glowsticks.isProtected(s.root.Position) and not Workspace:Raycast(hunter.Position, delta, rayParams) then
						Tagging.tag(s.player)
					end
				end
			end
		end
	end)
end

return Tagging
