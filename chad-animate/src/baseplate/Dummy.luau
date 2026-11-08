--[[
	Dummy (inlined into dist/ChadBaseplate_Installer.lua, not installed as a script)

	Builds a plain gray R15 dummy for StarterPlayer.StarterCharacter, so
	every player spawns as the same rig instead of their own avatar.
	4.8 studs tall; HipHeight 2 puts the soles exactly on the floor.
]]

local GRAY = Color3.fromRGB(163, 162, 165)

return function()
	local model = Instance.new("Model")
	model.Name = "StarterCharacter"

	local parts = {}
	local function part(name, sx, sy, sz, collide)
		local p = Instance.new("Part")
		p.Name = name
		p.Size = Vector3.new(sx, sy, sz)
		p.Color = GRAY
		p.Material = Enum.Material.SmoothPlastic
		p.TopSurface = Enum.SurfaceType.Smooth
		p.BottomSurface = Enum.SurfaceType.Smooth
		p.CanCollide = collide
		p.Parent = model
		parts[name] = p
		return p
	end

	local root = part("HumanoidRootPart", 2, 2, 1, false)
	root.Transparency = 1
	part("LowerTorso", 2, 0.4, 1, true)
	part("UpperTorso", 2, 1.6, 1, true)
	local head = part("Head", 2, 1, 1, true)
	for _, side in ipairs({ "Left", "Right" }) do
		part(side .. "UpperArm", 1, 1, 1, false)
		part(side .. "LowerArm", 1, 0.8, 1, false)
		part(side .. "Hand", 1, 0.3, 1, false)
		part(side .. "UpperLeg", 1, 0.95, 1, false)
		part(side .. "LowerLeg", 1, 0.85, 1, false)
		part(side .. "Foot", 1, 0.3, 1, false)
	end

	-- Classic rounded dummy head with the default face.
	local mesh = Instance.new("SpecialMesh")
	mesh.MeshType = Enum.MeshType.Head
	mesh.Scale = Vector3.new(1.25, 1.25, 1.25)
	mesh.Parent = head
	local face = Instance.new("Decal")
	face.Name = "face"
	face.Texture = "rbxasset://textures/face.png"
	face.Face = Enum.NormalId.Front
	face.Parent = head

	-- Joints, placing each part at its rest position as we go.
	root.CFrame = CFrame.new(0, 3, 0)
	local function joint(name, part0, part1, c0, c1)
		local motor = Instance.new("Motor6D")
		motor.Name = name
		motor.Part0 = parts[part0]
		motor.Part1 = parts[part1]
		motor.C0 = c0
		motor.C1 = c1
		motor.Parent = parts[part1]
		parts[part1].CFrame = parts[part0].CFrame * c0 * c1:Inverse()
	end
	local P = CFrame.new
	joint("Root", "HumanoidRootPart", "LowerTorso", P(0, -1, 0), P(0, 0, 0))
	joint("Waist", "LowerTorso", "UpperTorso", P(0, 0.2, 0), P(0, -0.8, 0))
	joint("Neck", "UpperTorso", "Head", P(0, 0.8, 0), P(0, -0.5, 0))
	for _, side in ipairs({ "Left", "Right" }) do
		local x = (side == "Left") and -1 or 1
		joint(side .. "Shoulder", "UpperTorso", side .. "UpperArm", P(x, 0.6, 0), P(-x * 0.5, 0.4, 0))
		joint(side .. "Elbow", side .. "UpperArm", side .. "LowerArm", P(0, -0.45, 0), P(0, 0.35, 0))
		joint(side .. "Wrist", side .. "LowerArm", side .. "Hand", P(0, -0.4, 0), P(0, 0.1, 0))
		joint(side .. "Hip", "LowerTorso", side .. "UpperLeg", P(x * 0.5, -0.2, 0), P(0, 0.4, 0))
		joint(side .. "Knee", side .. "UpperLeg", side .. "LowerLeg", P(0, -0.45, 0), P(0, 0.4, 0))
		joint(side .. "Ankle", side .. "LowerLeg", side .. "Foot", P(0, -0.4, 0), P(0, 0, 0.2))
	end

	local humanoid = Instance.new("Humanoid")
	humanoid.RigType = Enum.HumanoidRigType.R15
	humanoid.HipHeight = 2
	humanoid.AutomaticScalingEnabled = false
	humanoid.Parent = model

	model.PrimaryPart = root
	return model
end
