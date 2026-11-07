--[[
	Rig (ModuleScript, child of the ChadAnimate LocalScript)

	Finds a character's R15 joints and measures its legs, so the IK in
	Gait fits whatever body the player is wearing (blocky, Rthro, scaled).

	Supports Motor6D and AnimationConstraint joints. Joints are matched by
	name AND by the two body parts they connect, so a same-named joint
	inside an accessory is never picked by mistake.
]]

local Rig = {}

-- jointName -> { part0Name, part1Name, acceptedNames... }
local SPECS = {
	Root = { "HumanoidRootPart", "LowerTorso", "Root", "RootJoint" },
	Waist = { "LowerTorso", "UpperTorso", "Waist" },
	Neck = { "UpperTorso", "Head", "Neck" },
	LeftShoulder = { "UpperTorso", "LeftUpperArm", "LeftShoulder" },
	RightShoulder = { "UpperTorso", "RightUpperArm", "RightShoulder" },
	LeftElbow = { "LeftUpperArm", "LeftLowerArm", "LeftElbow" },
	RightElbow = { "RightUpperArm", "RightLowerArm", "RightElbow" },
	LeftWrist = { "LeftLowerArm", "LeftHand", "LeftWrist" },
	RightWrist = { "RightLowerArm", "RightHand", "RightWrist" },
	LeftHip = { "LowerTorso", "LeftUpperLeg", "LeftHip" },
	RightHip = { "LowerTorso", "RightUpperLeg", "RightHip" },
	LeftKnee = { "LeftUpperLeg", "LeftLowerLeg", "LeftKnee" },
	RightKnee = { "RightUpperLeg", "RightLowerLeg", "RightKnee" },
	LeftAnkle = { "LeftLowerLeg", "LeftFoot", "LeftAnkle" },
	RightAnkle = { "RightLowerLeg", "RightFoot", "RightAnkle" },
}

local REQUIRED = {
	"Root", "Waist", "LeftHip", "RightHip", "LeftKnee", "RightKnee", "LeftAnkle", "RightAnkle",
}

local function isJoint(object)
	return object:IsA("Motor6D") or object:IsA("AnimationConstraint")
end

-- The two parts a joint connects. AnimationConstraint connects the parents
-- of its attachments.
local function jointParts(joint)
	if joint:IsA("Motor6D") then
		return joint.Part0, joint.Part1
	end
	local a0, a1 = joint.Attachment0, joint.Attachment1
	return a0 and a0.Parent, a1 and a1.Parent
end
Rig.jointParts = jointParts

-- The joint's pivot in Part0 space and in Part1 space.
local function jointFrames(joint)
	if joint:IsA("Motor6D") then
		return joint.C0, joint.C1
	end
	local a0, a1 = joint.Attachment0, joint.Attachment1
	if a0 and a1 then
		return a0.CFrame, a1.CFrame
	end
	return nil, nil
end

-- Returns { [jointName] = joint } (missing optional joints are absent),
-- or nil plus a reason if a required joint is missing.
function Rig.findJoints(character)
	local byName = {}
	for _, object in ipairs(character:GetDescendants()) do
		if isJoint(object) then
			local list = byName[object.Name]
			if not list then
				list = {}
				byName[object.Name] = list
			end
			table.insert(list, object)
		end
	end

	local joints = {}
	for jointName, spec in pairs(SPECS) do
		for i = 3, #spec do
			for _, joint in ipairs(byName[spec[i]] or {}) do
				local part0, part1 = jointParts(joint)
				if joints[jointName] == nil and part0 and part1
					and part0.Name == spec[1] and part1.Name == spec[2] then
					joints[jointName] = joint
				end
			end
		end
	end

	for _, jointName in ipairs(REQUIRED) do
		if not joints[jointName] then
			return nil, "missing R15 joint " .. jointName
		end
	end
	return joints
end

--[[
	Measures the rest pose in HumanoidRootPart space:
	  legLength     hip pivot height above the floor (gait scale)
	  groundY       floor height (Y) under the HRP
	  ankleHeight   ankle pivot height above the sole
	  toeLength, heelLength   ankle to toe tip / heel, along the foot
	  rootC0, rootC1Inv       Root joint frames
	  legs[side]    hipC0, hipToKnee, kneeToAnkle, upper, lower,
	                restHip, restAnkle, ankleRestRot
	Returns nil plus a reason if the rig can't be measured.
]]
function Rig.measure(humanoid, rootPart, joints)
	local rootC0, rootC1 = jointFrames(joints.Root)
	if not rootC0 then
		return nil, "Root joint has no frames"
	end

	local lowerTorso = rootC0 * rootC1:Inverse()
	local floorY = -(rootPart.Size.Y * 0.5 + humanoid.HipHeight)

	local rig = {
		rootC0 = rootC0,
		rootC1Inv = rootC1:Inverse(),
		legs = {},
	}

	local hipHeights, ankleHeights, soles, toes, heels = 0, 0, 0, 0, 0
	for _, side in ipairs({ "Left", "Right" }) do
		local hip, knee, ankle = joints[side .. "Hip"], joints[side .. "Knee"], joints[side .. "Ankle"]
		local hipC0, hipC1 = jointFrames(hip)
		local kneeC0, kneeC1 = jointFrames(knee)
		local ankleC0, ankleC1 = jointFrames(ankle)
		if not (hipC0 and kneeC0 and ankleC0) then
			return nil, side .. " leg joints have no frames"
		end

		local hipToKnee = hipC1:Inverse() * kneeC0
		local kneeToAnkle = kneeC1:Inverse() * ankleC0
		local hipFrame = lowerTorso * hipC0
		local ankleFrame = hipFrame * hipToKnee * kneeToAnkle
		local upper = hipToKnee.Position.Magnitude
		local lower = kneeToAnkle.Position.Magnitude
		if upper < 0.05 or lower < 0.05 then
			return nil, side .. " leg is too short to animate"
		end

		-- Sole and toe/heel from the foot part's box, in HRP space.
		local _, foot = jointParts(ankle)
		local footSize = (foot and foot:IsA("BasePart")) and foot.Size or Vector3.new(1, 0.3, 1)
		local footCenter = (ankleFrame * ankleC1:Inverse()).Position
		local ankleAt = ankleFrame.Position

		rig.legs[side] = {
			hipC0 = hipC0,
			hipToKnee = hipToKnee,
			kneeToAnkle = kneeToAnkle,
			upper = upper,
			lower = lower,
			restHip = hipFrame.Position,
			restAnkle = ankleAt,
			ankleRestRot = ankleFrame.Rotation,
		}

		local sole = footCenter.Y - footSize.Y * 0.5
		hipHeights = hipHeights + (hipFrame.Position.Y - floorY)
		ankleHeights = ankleHeights + (ankleAt.Y - sole)
		soles = soles + sole
		toes = toes + (ankleAt.Z - (footCenter.Z - footSize.Z * 0.5))
		heels = heels + ((footCenter.Z + footSize.Z * 0.5) - ankleAt.Z)
	end

	rig.groundY = floorY
	rig.legLength = hipHeights * 0.5
	-- If HipHeight disagrees badly with the legs (custom rigs), trust the legs.
	local sole = soles * 0.5
	if rig.legLength <= 0.1 or math.abs(sole - floorY) > 0.6 * rig.legLength then
		rig.groundY = sole
		rig.legLength = (rig.legs.Left.restHip.Y + rig.legs.Right.restHip.Y) * 0.5 - sole
	end
	rig.ankleHeight = math.max(ankleHeights * 0.5, 0)
	rig.toeLength = math.max(toes * 0.5, 0.05)
	rig.heelLength = math.max(heels * 0.5, 0.05)

	if rig.legLength <= 0.1 then
		return nil, "could not measure leg length"
	end
	return rig
end

return Rig
