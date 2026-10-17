--!strict
-- Turns a character (player or AI) into a Shadow: dark translucent body,
-- glowing white eyes and a slow trail of smoke. Also plays the 2-second
-- transformation when a survivor is tagged.

local CollectionService = game:GetService("CollectionService")
local TweenService = game:GetService("TweenService")

local Shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
local Sounds = require(Shared.Sounds)

local SHADOW_COLOR = Color3.fromRGB(10, 10, 14)
local SKIP = { HumanoidRootPart = true, Flashlight = true }

local ShadowForm = {}

local function bodyParts(character: Model): { BasePart }
	local parts = {}
	for _, child in character:GetChildren() do
		if child:IsA("BasePart") and not SKIP[child.Name] then
			table.insert(parts, child)
		end
	end
	return parts
end

local function ghostPart(p: BasePart)
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	p.Massless = true
	p.CastShadow = false
end

local function addEyes(head: BasePart)
	local hs = head.Size
	for _, side in { -1, 1 } do
		local eye = Instance.new("Part")
		eye.Name = "ShadowEye"
		eye.Size = Vector3.new(hs.X * 0.18, hs.Y * 0.1, 0.05)
		eye.Color = Color3.fromRGB(235, 245, 255)
		eye.Material = Enum.Material.Neon
		ghostPart(eye)
		eye.CFrame = head.CFrame * CFrame.new(side * hs.X * 0.2, hs.Y * 0.08, -hs.Z / 2 - 0.03)
		local weld = Instance.new("WeldConstraint")
		weld.Part0 = head
		weld.Part1 = eye
		weld.Parent = eye
		eye.Parent = head
	end
	local glow = Instance.new("PointLight")
	glow.Name = "EyeGlow"
	glow.Color = Color3.fromRGB(200, 220, 255)
	glow.Range = 5
	glow.Brightness = 0.7
	glow.Shadows = false
	glow.Parent = head
end

local function addSmoke(torso: BasePart)
	local smoke = Instance.new("ParticleEmitter")
	smoke.Name = "ShadowSmoke"
	smoke.Texture = "rbxasset://textures/particles/smoke_main.dds"
	smoke.Color = ColorSequence.new(Color3.fromRGB(18, 18, 24))
	smoke.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, 1.2), NumberSequenceKeypoint.new(1, 3.2) })
	smoke.Transparency = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0.55), NumberSequenceKeypoint.new(1, 1) })
	smoke.Lifetime = NumberRange.new(1.2, 2)
	smoke.Rate = 9
	smoke.Speed = NumberRange.new(0.4, 1)
	smoke.SpreadAngle = Vector2.new(35, 35)
	smoke.Acceleration = Vector3.new(0, 1.2, 0)
	smoke.RotSpeed = NumberRange.new(-30, 30)
	smoke.LightInfluence = 0.7
	smoke.Parent = torso
end

function ShadowForm.isShadow(character: Model): boolean
	return CollectionService:HasTag(character, "ShadowCharacter")
end

-- Instantly applies the Shadow look and marks the character as a hunter.
function ShadowForm.apply(character: Model, readyIn: number?)
	if ShadowForm.isShadow(character) then
		return
	end
	for _, d in character:GetDescendants() do
		local isFace = d:IsA("Decal") and d.Parent ~= nil and d.Parent.Name == "Head"
		local isLook = d:IsA("Clothing") or d:IsA("ShirtGraphic") or d:IsA("BodyColors") or d:IsA("Accessory") or d:IsA("SurfaceAppearance")
		if isFace or isLook or d.Name == "Flashlight" then
			d:Destroy()
		end
	end
	for _, p in bodyParts(character) do
		p.Color = SHADOW_COLOR
		p.Material = Enum.Material.SmoothPlastic
		p.Transparency = 0.22
		p.Reflectance = 0
		if p:IsA("MeshPart") then
			p.TextureID = ""
		end
	end
	local head = character:FindFirstChild("Head") :: BasePart?
	if head then
		addEyes(head)
	end
	local torso = (character:FindFirstChild("UpperTorso") or character:FindFirstChild("Torso")) :: BasePart?
	if torso then
		addSmoke(torso)
	end
	character:SetAttribute("ReadyAt", os.clock() + (readyIn or 0))
	CollectionService:AddTag(character, "ShadowCharacter")
end

-- Plays the transformation, then applies the Shadow look. `onDone(ok)` gets
-- false if the character vanished mid-transformation.
function ShadowForm.transform(character: Model, duration: number, readyIn: number, onDone: (boolean) -> ())
	local root = character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if root then
		Sounds.play("Transform", root)
		local burst = Instance.new("ParticleEmitter")
		burst.Texture = "rbxasset://textures/particles/smoke_main.dds"
		burst.Color = ColorSequence.new(Color3.fromRGB(10, 10, 16))
		burst.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, 2), NumberSequenceKeypoint.new(1, 6) })
		burst.Transparency = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0.3), NumberSequenceKeypoint.new(1, 1) })
		burst.Lifetime = NumberRange.new(0.8, 1.4)
		burst.Rate = 45
		burst.Speed = NumberRange.new(2, 5)
		burst.SpreadAngle = Vector2.new(180, 180)
		burst.LightInfluence = 0.5
		burst.Parent = root
		task.delay(duration, function()
			burst.Enabled = false
			task.delay(1.5, function()
				burst:Destroy()
			end)
		end)
	end
	local info = TweenInfo.new(duration, Enum.EasingStyle.Sine, Enum.EasingDirection.In)
	for _, p in bodyParts(character) do
		TweenService:Create(p, info, { Color = SHADOW_COLOR }):Play()
	end
	task.delay(duration, function()
		if character.Parent == nil then
			onDone(false)
			return
		end
		ShadowForm.apply(character, readyIn)
		onDone(true)
	end)
end

return ShadowForm
