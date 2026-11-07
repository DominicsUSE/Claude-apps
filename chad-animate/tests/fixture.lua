-- A mock blocky R15 character built from plain tables, close enough to a
-- real rig for Rig.findJoints / Rig.measure and forward kinematics.
-- HRP is 2 studs tall, HipHeight 2, so the floor is at Y = -3 in HRP space.

local M = ...
local CFrame, Vector3 = M.CFrame, M.Vector3

local SUPER = {
	Motor6D = { "Motor6D", "JointInstance", "Instance" },
	AnimationConstraint = { "AnimationConstraint", "Constraint", "Instance" },
	Part = { "Part", "BasePart", "Instance" },
	Attachment = { "Attachment", "Instance" },
	Model = { "Model", "Instance" },
	Humanoid = { "Humanoid", "Instance" },
	Accessory = { "Accessory", "Instance" },
}

local Instance = {}
Instance.__index = Instance

local function new(class, name, parent, props)
	local o = setmetatable({ ClassName = class, Name = name, _children = {} }, Instance)
	for k, v in pairs(props or {}) do
		o[k] = v
	end
	if parent then
		o.Parent = parent
		table.insert(parent._children, o)
	end
	return o
end

function Instance:IsA(class)
	for _, c in ipairs(SUPER[self.ClassName] or { self.ClassName }) do
		if c == class then return true end
	end
	return false
end

function Instance:GetChildren()
	return self._children
end

function Instance:GetDescendants()
	local out = {}
	local function walk(o)
		for _, c in ipairs(o._children) do
			table.insert(out, c)
			walk(c)
		end
	end
	walk(self)
	return out
end

function Instance:FindFirstChild(name)
	for _, c in ipairs(self._children) do
		if c.Name == name then return c end
	end
	return nil
end

local function build(opts)
	opts = opts or {}
	local useConstraints = opts.constraints
	local char = new("Model", "Character")
	local humanoid = new("Humanoid", "Humanoid", char, { HipHeight = 2 })

	-- Decoy listed first: an accessory with its own "Neck" joint between
	-- unrelated parts. findJoints must skip it.
	local hat = new("Accessory", "Hat", char)
	local handle = new("Part", "Handle", hat, { Size = Vector3.new(1, 1, 1) })
	new("Motor6D", "Neck", handle, { Part0 = handle, Part1 = handle, C0 = CFrame.new(0, 5, 0), C1 = CFrame.new() })

	local parts = {}
	local function part(name, sx, sy, sz)
		parts[name] = new("Part", name, char, { Size = Vector3.new(sx, sy, sz) })
		return parts[name]
	end
	part("HumanoidRootPart", 2, 2, 1)
	part("LowerTorso", 2, 0.4, 1)
	part("UpperTorso", 2, 1.6, 1)
	part("Head", 2, 1, 1)
	for _, s in ipairs({ "Left", "Right" }) do
		part(s .. "UpperArm", 1, 1, 1)
		part(s .. "LowerArm", 1, 0.8, 1)
		part(s .. "Hand", 1, 0.3, 1)
		part(s .. "UpperLeg", 1, 0.95, 1)
		part(s .. "LowerLeg", 1, 0.85, 1)
		part(s .. "Foot", 1, 0.3, 1)
	end

	local joints = {}
	local function joint(name, p0, p1, c0, c1)
		local j
		if useConstraints then
			local a0 = new("Attachment", name .. "RigAttachment", parts[p0], { CFrame = c0 })
			local a1 = new("Attachment", name .. "RigAttachment", parts[p1], { CFrame = c1 })
			j = new("AnimationConstraint", name, parts[p1], { Attachment0 = a0, Attachment1 = a1 })
		else
			j = new("Motor6D", name, parts[p1], { Part0 = parts[p0], Part1 = parts[p1], C0 = c0, C1 = c1 })
		end
		j.Transform = CFrame.new()
		joints[name] = j
		return j
	end

	local P = CFrame.new
	joint("Root", "HumanoidRootPart", "LowerTorso", P(0, -1, 0), P(0, 0, 0))
	joint("Waist", "LowerTorso", "UpperTorso", P(0, 0.2, 0), P(0, -0.8, 0))
	joint("Neck", "UpperTorso", "Head", P(0, 0.8, 0), P(0, -0.5, 0))
	for _, s in ipairs({ "Left", "Right" }) do
		local x = (s == "Left") and -1 or 1
		joint(s .. "Shoulder", "UpperTorso", s .. "UpperArm", P(x * 1.0, 0.6, 0), P(-x * 0.5, 0.4, 0))
		joint(s .. "Elbow", s .. "UpperArm", s .. "LowerArm", P(0, -0.45, 0), P(0, 0.35, 0))
		joint(s .. "Wrist", s .. "LowerArm", s .. "Hand", P(0, -0.4, 0), P(0, 0.1, 0))
		joint(s .. "Hip", "LowerTorso", s .. "UpperLeg", P(x * 0.5, -0.2, 0), P(0, 0.4, 0))
		joint(s .. "Knee", s .. "UpperLeg", s .. "LowerLeg", P(0, -0.45, 0), P(0, 0.4, 0))
		joint(s .. "Ankle", s .. "LowerLeg", s .. "Foot", P(0, -0.4, 0), P(0, 0, 0.2))
	end

	return {
		character = char,
		humanoid = humanoid,
		root = parts.HumanoidRootPart,
		parts = parts,
		joints = joints,
	}
end

return build
