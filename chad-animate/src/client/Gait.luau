--[[
	Gait (ModuleScript, child of the ChadAnimate LocalScript)

	Pure pose math. No services and no instances: the caller passes in a few
	facts about one character for this frame, and gets back a Transform
	CFrame for each R15 joint. That keeps it testable outside Roblox.

	Everything is in HumanoidRootPart space: X right, Y up, -Z forward.

	Positive Transform rotations on a standard R15 rig:
	  Hip, Shoulder   +X swings the limb forward
	  Knee            -X bends the knee (shin goes back)
	  Elbow           +X bends the elbow
	  Ankle           +X lifts the toes
	  Root, Waist     -X leans forward, +Y turns left, +Z tilts left

	Grounded legs use two-bone IK: each foot lands on a planned spot, stays
	planted while the body passes over it, and follows stairs and slopes
	when the caller supplies ground heights.

	Written in plain Lua 5.1 syntax (no type annotations or compound
	assignment) so the test suite can run it in a stock Lua VM.
]]

local Gait = {}

local IDENTITY = CFrame.new()
local PI = math.pi
local TAU = math.pi * 2
local sin, cos, sqrt, abs = math.sin, math.cos, math.sqrt, math.abs
local min, max = math.min, math.max
local atan2, acos, asin, exp = math.atan2, math.acos, math.asin, math.exp

Gait.JOINTS = {
	"Root", "Waist", "Neck",
	"LeftShoulder", "RightShoulder", "LeftElbow", "RightElbow", "LeftWrist", "RightWrist",
	"LeftHip", "RightHip", "LeftKnee", "RightKnee", "LeftAnkle", "RightAnkle",
}

local SIDES = { "Left", "Right" }
local STATES = { "ground", "air", "climb", "swim", "sit", "limp" }

-- How fast each state fades in when it becomes active (per second).
local FADE_IN = { ground = 14, air = 10, climb = 9, swim = 6, sit = 9, limp = 8 }

-- Animation style. Lengths are in leg lengths (hip height of the rig), so
-- the same numbers fit blocky, Rthro and scaled avatars.
Gait.STYLE = {
	WALK_TOP = 6.6, -- pure walk up to this speed (leg lengths per second)
	RUN_FULL = 9.5, -- pure run from this speed

	-- Step cycles per second = CADENCE + CADENCE_PER_LEG * speed.
	WALK_CADENCE = 0.85,
	WALK_CADENCE_PER_LEG = 0.19,
	RUN_CADENCE = 1.4,
	RUN_CADENCE_PER_LEG = 0.08,

	WALK_DUTY = 0.58, -- share of a cycle each foot is planted (>0.5: double support)
	RUN_DUTY = 0.32, -- (<0.5: both feet off the ground between steps)
	WALK_REACH_AHEAD = 0.45, -- a planted foot lands this far ahead of the hip
	WALK_REACH_BEHIND = 0.55, -- and pushes off this far behind it
	RUN_REACH_AHEAD = 0.36, -- runners land closer under the body
	RUN_REACH_BEHIND = 0.64,
	WALK_LIFT = 0.16, -- swing foot height
	RUN_LIFT = 0.5,
	WALK_HEEL_STRIKE = 0.22, -- toes up as the heel lands (radians)
	RUN_HEEL_STRIKE = 0.08,
	WALK_TOE_OFF = 0.45, -- toes down as the foot pushes off (radians)
	RUN_TOE_OFF = 0.8,
	TOE_OUT = 0.08,

	WALK_LEAN = 0.035, -- forward lean (radians)
	RUN_LEAN = 0.15,
	WALK_ARM = 0.5, -- arm swing (radians)
	RUN_ARM = 0.95,
	WALK_ELBOW = 0.18, -- resting elbow bend (radians)
	RUN_ELBOW = 1.5,
	WALK_PELVIS_TURN = 0.14, -- pelvis turns with the leading leg (radians)
	RUN_PELVIS_TURN = 0.14,
	WALK_HIP_DROP = 0.07, -- swing-side hip dips (radians)
	RUN_HIP_DROP = 0.03,
	WALK_SWAY = 0.035, -- body shifts over the planted foot
	RUN_BOUNCE = 0.08, -- run: body sinks at mid-stance

	TURN_BANK = 0.006, -- lean into turns: radians per (rad/s * stud/s)
	ACCEL_LEAN = 0.004, -- lean into acceleration: radians per stud/s^2
	LANDING_DEPTH = 0.3, -- deepest landing crouch
}
local STYLE = Gait.STYLE

--============================================================
-- Small helpers
--============================================================

local function clamp(x, lo, hi)
	if x < lo then
		return lo
	elseif x > hi then
		return hi
	end
	return x
end

local function lerp(a, b, t)
	return a + (b - a) * t
end

-- Smooth 0..1 ramp as x goes from a to b (a may be greater than b).
local function smoothstep(a, b, x)
	local t = clamp((x - a) / (b - a), 0, 1)
	return t * t * (3 - 2 * t)
end

-- Frame-rate independent exponential approach.
local function approach(current, target, rate, dt)
	return current + (target - current) * (1 - exp(-rate * dt))
end

local function wrapAngle(a)
	return (a + PI) % TAU - PI
end

local function rotX(a)
	return CFrame.Angles(a, 0, 0)
end

local function angles(x, y, z)
	return CFrame.Angles(x, y, z)
end

-- Shoulder: swing forward/back (x), out to the side (z), then turn the
-- swung arm toward the body's midline (inward). Composed explicitly so the
-- inward turn moves the hand instead of twisting the arm about itself.
local function arm(x, z, inward)
	return CFrame.Angles(0, inward or 0, 0) * CFrame.Angles(x, 0, 0) * CFrame.Angles(0, 0, z or 0)
end

-- Weighted blend of several poses: list of { pose, weight }.
local function blend(list)
	local out = {}
	local total = 0
	for _, entry in ipairs(list) do
		local pose, weight = entry[1], entry[2]
		if weight > 1e-4 then
			total = total + weight
			local t = weight / total
			for _, name in ipairs(Gait.JOINTS) do
				local target = pose[name] or IDENTITY
				local current = out[name]
				if current == nil then
					out[name] = target
				else
					out[name] = current:Lerp(target, t)
				end
			end
		end
	end
	for _, name in ipairs(Gait.JOINTS) do
		if out[name] == nil then
			out[name] = IDENTITY
		end
	end
	return out
end
Gait.blend = blend

-- Rising-then-decaying envelope, peaks at t == tau with value 1.
local function pulse(t, tau)
	if t <= 0 then
		return 0
	end
	local x = t / tau
	return x * exp(1 - x)
end

--============================================================
-- Two-bone leg IK
--============================================================

--[[
	hipFrame: HRP-space frame of the hip joint before its Transform
	          (LowerTorso frame * hip C0).
	target:   HRP-space point the ankle joint should reach.

	The thigh is rotated by Rx(hipX) * Rz(hipZ): Rz swings the leg out to
	the side, Rx swings it forward. The knee only bends about its own X axis.
	In the thigh's frame the ankle sits at (0, -A, B) with
	A = upper + lower*cos(k) and B = lower*sin(k), where k is the knee bend.
]]
local function solveLeg(leg, hipFrame, target)
	local upper, lower = leg.upper, leg.lower
	local t = hipFrame:PointToObjectSpace(target)
	local dist = t.Magnitude
	if dist < 1e-4 then
		t = Vector3.new(0, -1, 0)
		dist = 1
	end
	local reach = clamp(dist, abs(upper - lower) + 0.05 * (upper + lower), (upper + lower) * 0.9995)
	local scale = reach / dist
	local tx, ty, tz = t.X * scale, t.Y * scale, t.Z * scale

	local cosK = clamp((reach * reach - upper * upper - lower * lower) / (2 * upper * lower), -1, 1)
	local bend = acos(cosK)
	local a = upper + lower * cosK
	local b = lower * sin(bend)

	local hipZ = asin(clamp(tx / a, -1, 1))
	local hipX = wrapAngle(atan2(tz, ty) - atan2(b, -a * cos(hipZ)))

	return rotX(hipX) * CFrame.Angles(0, 0, hipZ), rotX(-bend)
end
Gait.solveLeg = solveLeg

-- Ankle Transform that gives the foot `footRotation` (HRP space), given
-- the HRP-space frame of the ankle joint (before its Transform).
local function ankleFor(leg, ankleFrame, footRotation)
	return ankleFrame.Rotation:Inverse() * footRotation * leg.ankleRestRot
end

-- Positions every leg joint for a given Root Transform and ankle targets.
local function poseLegs(rig, pose, rootT, feet)
	local lowerTorso = rig.rootC0 * rootT * rig.rootC1Inv
	for _, side in ipairs(SIDES) do
		local leg = rig.legs[side]
		local foot = feet[side]
		local hipFrame = lowerTorso * leg.hipC0
		local hipT, kneeT = solveLeg(leg, hipFrame, foot.target)
		local ankleFrame = hipFrame * hipT * leg.hipToKnee * kneeT * leg.kneeToAnkle
		pose[side .. "Hip"] = hipT
		pose[side .. "Knee"] = kneeT
		pose[side .. "Ankle"] = ankleFor(leg, ankleFrame, foot.rotation)
	end
end

--============================================================
-- Memory (per character, persists between frames)
--============================================================

function Gait.newMemory(seed)
	local weights = {}
	for _, name in ipairs(STATES) do
		weights[name] = 0
	end
	weights.ground = 1

	return {
		seed = seed or 0,
		state = "ground",
		weights = weights,
		phase = 0,
		run = 0,
		move = 0,
		reach = 0,
		dirX = 0,
		dirZ = -1,
		frontness = 0,
		bank = 0,
		accelLean = 0,
		lastForward = 0,
		airTime = 0,
		airVy = 0,
		leadSide = "Left",
		landT = 10,
		landImpact = 0,
		climbPhase = 0,
		swimPhase = 0,
		toolWeight = 0,
		lookYaw = 0,
		lookPitch = 0,
		feet = nil,
	}
end

--============================================================
-- Ground: idle, walk, run (one continuous function of speed)
--============================================================

-- Where one foot is in its cycle. p = 0 is heel strike.
-- Returns distance along the travel direction (+ = ahead of the hip),
-- height above the ground, toe pitch, and whether the foot is planted.
local function footPath(p, duty, ahead, behind, lift, run)
	local strikePitch = lerp(STYLE.WALK_HEEL_STRIKE, STYLE.RUN_HEEL_STRIKE, run)
	local toeOffPitch = lerp(STYLE.WALK_TOE_OFF, STYLE.RUN_TOE_OFF, run)

	if p < duty then
		-- Planted: slides back under the body at a steady rate, so with the
		-- right stride it stays fixed relative to the ground.
		local u = p / duty
		local along = ahead - (ahead + behind) * u
		local pitch = (1 - smoothstep(0, 0.2, u)) * strikePitch - smoothstep(0.55, 1, u) * toeOffPitch
		return along, 0, pitch, true
	end

	-- Swinging: lift off behind, swing through, reach ahead for the next
	-- strike. Running lingers behind first, so the heel kicks up high.
	local u = (p - duty) / (1 - duty)
	local lag = u ^ lerp(1, 1.4, run)
	local along = -behind + (ahead + behind) * (lag * lag * (3 - 2 * lag))
	local height = lift * (sin(PI * u) ^ lerp(1.3, 0.8, run))
	local pitch = lerp(-toeOffPitch, strikePitch, smoothstep(0, 0.55, u))
	return along, height, pitch, false
end

-- How far to raise the ankle so a foot tilted by `pitch` doesn't dip its
-- toe (pitch < 0) or heel (pitch > 0) below the sole's flat height.
local function soleClearance(rig, pitch)
	local h = rig.ankleHeight
	local s, c = sin(pitch), cos(pitch)
	local toeY = -h * c + rig.toeLength * s
	local heelY = -h * c - rig.heelLength * s
	return max(0, -h - min(toeY, heelY))
end

local function groundPose(mem, rig, inp, dt, t)
	local L = rig.legLength
	local vel = inp.velocity
	local speed = sqrt(vel.X * vel.X + vel.Z * vel.Z)
	local legSpeed = speed / L
	local yawRate = inp.yawRate or 0

	-- Turning on the spot shuffles the feet a little.
	local turnStep = smoothstep(1.5, 4, abs(yawRate)) * (1 - smoothstep(0.5, 2, legSpeed))

	mem.run = approach(mem.run, smoothstep(STYLE.WALK_TOP, STYLE.RUN_FULL, legSpeed), 5, dt)
	mem.move = approach(mem.move, max(smoothstep(0.25, 1.2, legSpeed), turnStep * 0.6), 9, dt)
	local run, move = mem.run, mem.move
	local still = 1 - move

	if speed > 0.3 then
		mem.dirX = vel.X / speed
		mem.dirZ = vel.Z / speed
	end
	local forwardness = -mem.dirZ -- 1 forward, -1 backward, 0 sideways

	local cadence = lerp(
		STYLE.WALK_CADENCE + STYLE.WALK_CADENCE_PER_LEG * legSpeed,
		STYLE.RUN_CADENCE + STYLE.RUN_CADENCE_PER_LEG * legSpeed,
		run
	)
	mem.phase = (mem.phase + cadence * dt) % 1

	local duty = lerp(STYLE.WALK_DUTY, STYLE.RUN_DUTY, run)
	local stride = speed / cadence -- distance covered in one full cycle
	-- Planted feet travel duty * stride under the body; cap it at what the
	-- legs can reach (past that, feet slide a little rather than overstride).
	local aheadMax = lerp(STYLE.WALK_REACH_AHEAD, STYLE.RUN_REACH_AHEAD, run)
	local behindMax = lerp(STYLE.WALK_REACH_BEHIND, STYLE.RUN_REACH_BEHIND, run)
	local travel = min(duty * stride, (aheadMax + behindMax) * L)
	mem.reach = approach(mem.reach, max(travel, turnStep * 0.12 * L), 12, dt)
	local ahead = mem.reach * aheadMax / (aheadMax + behindMax)
	local behind = mem.reach - ahead
	local lift = lerp(STYLE.WALK_LIFT, STYLE.RUN_LIFT, run) * L
		* max(smoothstep(0.2, 3, legSpeed), turnStep * 0.5) * move

	-- Feet ---------------------------------------------------------------
	local width = lerp(1.05, 0.72, run * move)
	local feet = {}
	for _, side in ipairs(SIDES) do
		local leg = rig.legs[side]
		local p = mem.phase
		if side == "Right" then
			p = (p + 0.5) % 1
		end
		local along, height, pitch, planted = footPath(p, duty, ahead, behind, lift, run)
		pitch = pitch * move

		-- A tilted foot pivots on its toe or heel: raise the ankle so the
		-- lowest corner stays on (or above) the ground.
		local tilt = soleClearance(rig, pitch)

		local ground = 0
		if inp.ground then
			ground = inp.ground[side] or 0
		end

		-- Sidestepping: feet may spread wide but never cross the midline.
		local rest = leg.restAnkle
		local x = rest.X * width + mem.dirX * along
		if rest.X < 0 then
			x = min(x, rest.X * 0.35)
		else
			x = max(x, rest.X * 0.35)
		end
		local sideSign = (side == "Left") and 1 or -1
		feet[side] = {
			target = Vector3.new(
				x,
				rig.groundY + rig.ankleHeight + ground + max(height, tilt),
				rest.Z + mem.dirZ * along
			),
			rotation = CFrame.Angles(0, STYLE.TOE_OUT * sideSign, 0) * rotX(pitch),
			planted = planted or move < 0.3,
			height = height,
			ground = ground,
		}
	end
	mem.feet = feet

	-- Pelvis -------------------------------------------------------------
	local frontness = 0
	if mem.reach > 1e-3 then
		frontness = clamp((feet.Right.target.Z - feet.Left.target.Z) / mem.reach, -1, 1)
	end
	mem.frontness = frontness

	-- Running bounce: lowest at mid-stance, highest mid-flight.
	local bounce
	local uL = mem.phase / duty
	local uR = ((mem.phase + 0.5) % 1) / duty
	if uL < 1 then
		bounce = -sin(PI * uL)
	elseif uR < 1 then
		bounce = -sin(PI * uR)
	else
		local f = clamp((mem.phase % 0.5 - duty) / max(0.5 - duty, 1e-3), 0, 1)
		bounce = 0.5 * sin(PI * f)
	end

	local breath = sin(t * TAU / 3.8 + mem.seed)
	local shift = 0.7 * sin(t * TAU / 9 + mem.seed * 1.7) + 0.3 * sin(t * TAU / 4.1 + mem.seed * 3.1)

	local pelvisY = -L * (0.015 + lerp(0.025, 0.04, run) * move)
		+ bounce * STYLE.RUN_BOUNCE * L * run * move
		+ breath * 0.003 * L * still

	-- Landing: sink and recover. IK keeps the feet planted, so the knees bend.
	local land = mem.landImpact * pulse(mem.landT, 0.07 + 0.06 * mem.landImpact)
	pelvisY = pelvisY - land * STYLE.LANDING_DEPTH * L

	local swayX = -STYLE.WALK_SWAY * L * cos(TAU * (mem.phase - duty * 0.5)) * move * (1 - run)
		+ shift * 0.05 * L * still

	local pelvisTurn = -lerp(STYLE.WALK_PELVIS_TURN, STYLE.RUN_PELVIS_TURN, run) * frontness * move

	local hipDrop = 0
	if lift > 1e-3 then
		hipDrop = lerp(STYLE.WALK_HIP_DROP, STYLE.RUN_HIP_DROP, run) * (feet.Left.height - feet.Right.height) / lift
	end

	mem.bank = approach(mem.bank, clamp(yawRate * speed * STYLE.TURN_BANK, -0.35, 0.35) * move, 6, dt)
	local bank = mem.bank

	local lean = lerp(STYLE.WALK_LEAN, STYLE.RUN_LEAN, run) * move * forwardness + mem.accelLean
	local pelvisRoll = hipDrop + bank * 0.4 + shift * 0.035 * still

	local pelvisTilt = CFrame.new(swayX, 0, 0)
		* CFrame.Angles(0, pelvisTurn, 0)
		* rotX(-lean)
		* CFrame.Angles(0, 0, pelvisRoll)

	-- Never lift the hips higher than the planted legs can reach. Uses the
	-- turned and tilted pelvis, which shortens the reach to each foot.
	local lowerTorso = rig.rootC0 * pelvisTilt * rig.rootC1Inv
	for _, side in ipairs(SIDES) do
		local foot = feet[side]
		if foot.planted then
			local leg = rig.legs[side]
			local hip = (lowerTorso * leg.hipC0).Position
			local limit = (leg.upper + leg.lower) * 0.992
			local dx = foot.target.X - hip.X
			local dz = foot.target.Z - hip.Z
			local vertical = sqrt(max(limit * limit - dx * dx - dz * dz, 0))
			pelvisY = min(pelvisY, foot.target.Y + vertical - hip.Y)
		end
	end

	local rootT = CFrame.new(0, pelvisY, 0) * pelvisTilt

	local pose = { Root = rootT }
	poseLegs(rig, pose, rootT, feet)

	-- Upper body ----------------------------------------------------------
	local waistTurn = -pelvisTurn * lerp(1.6, 1.9, run)
	local waistPitch = -lerp(0.02, 0.09, run) * move * forwardness - mem.accelLean * 0.6
		+ breath * 0.012 * still - land * 0.3
	local waistRoll = -pelvisRoll * 0.7 + bank * 0.5

	local look = 0.22 * sin(t * 0.31 + mem.seed) * sin(t * 0.11 + mem.seed * 2) * still
	local neckTurn = -(pelvisTurn + waistTurn) * 0.85 + look
	local neckPitch = (lean - waistPitch) * 0.7 - breath * 0.008 * still + land * 0.18
	local neckRoll = -(pelvisRoll + waistRoll) * 0.6

	pose.Waist = CFrame.Angles(0, waistTurn, 0) * rotX(waistPitch) * CFrame.Angles(0, 0, waistRoll)
	pose.Neck = CFrame.Angles(0, neckTurn, 0) * rotX(neckPitch) * CFrame.Angles(0, 0, neckRoll)

	-- Arms swing against the legs: left foot ahead means left arm back.
	local swing = lerp(STYLE.WALK_ARM, STYLE.RUN_ARM, run) * move * clamp(0.35 + legSpeed / 5, 0, 1)
	local armPhase = cos(TAU * (mem.phase - 0.03)) * mem.dirZ
	local elbowBase = lerp(STYLE.WALK_ELBOW, STYLE.RUN_ELBOW, run * move)
	for _, side in ipairs(SIDES) do
		local sideSign = (side == "Left") and 1 or -1
		local forward = armPhase * sideSign -- +1 = this arm fully forward
		local x
		if forward > 0 then
			x = forward * swing
		else
			x = forward * swing * lerp(0.6, 0.7, run)
		end
		x = x + lerp(0, 0.15, run) * move + breath * 0.015 * still + land * 0.35
		local out = -(0.06 + 0.06 * run + breath * 0.01 * still + land * 0.25) * sideSign
		local inward = -0.25 * max(0, forward) * run * move * sideSign
		pose[side .. "Shoulder"] = arm(x, out, -inward)
		pose[side .. "Elbow"] = rotX(elbowBase + max(0, forward) * lerp(0.25, 0.4, run) * move)
		pose[side .. "Wrist"] = rotX(-0.1 * run * move)
	end

	return pose
end

--============================================================
-- Air: jump, leap, fall, long-fall flail
--============================================================

local function airPose(mem, rig, inp, t)
	local vel = inp.velocity
	local vy = vel.Y
	local legSpeed = sqrt(vel.X * vel.X + vel.Z * vel.Z) / rig.legLength
	local rising = smoothstep(-8, 25, vy)
	local leap = smoothstep(4, 8, legSpeed)
	-- Flail only on real drops: long airtime AND falling fast (a normal jump
	-- lands at about -53 studs/s).
	local flail = smoothstep(0.35, 0.8, mem.airTime) * smoothstep(-70, -110, vy)

	-- Standing jump: knees tucked, arms thrown up.
	local tuck = {
		Root = rotX(-0.04),
		Waist = rotX(-0.06),
		Neck = rotX(0.1),
		LeftHip = rotX(0.8),
		RightHip = rotX(0.65),
		LeftKnee = rotX(-1.25),
		RightKnee = rotX(-1.0),
		LeftAnkle = rotX(-0.35),
		RightAnkle = rotX(-0.3),
		LeftShoulder = arm(1.9, -0.3),
		RightShoulder = arm(1.9, 0.3),
		LeftElbow = rotX(0.35),
		RightElbow = rotX(0.35),
	}

	-- Running jump: lead leg reaches forward, trail leg folds back,
	-- opposite arm drives forward.
	local lead = mem.leadSide
	local trail = (lead == "Left") and "Right" or "Left"
	local leapPose = {
		Root = rotX(-0.12),
		Waist = rotX(-0.08),
		Neck = rotX(0.12),
	}
	leapPose[lead .. "Hip"] = rotX(0.95)
	leapPose[lead .. "Knee"] = rotX(-0.55)
	leapPose[lead .. "Ankle"] = rotX(0.15)
	leapPose[trail .. "Hip"] = rotX(-0.5)
	leapPose[trail .. "Knee"] = rotX(-1.25)
	leapPose[trail .. "Ankle"] = rotX(-0.4)
	local leadSign = (lead == "Left") and 1 or -1
	leapPose[trail .. "Shoulder"] = arm(1.1, 0.12 * leadSign)
	leapPose[trail .. "Elbow"] = rotX(0.9)
	leapPose[lead .. "Shoulder"] = arm(-0.7, -0.12 * leadSign)
	leapPose[lead .. "Elbow"] = rotX(0.5)

	-- Coming down: legs reach for the ground, arms out for balance.
	local fall = {
		Waist = rotX(0.05),
		Neck = rotX(-0.1),
		LeftHip = rotX(0.35),
		RightHip = rotX(0.15),
		LeftKnee = rotX(-0.45),
		RightKnee = rotX(-0.7),
		LeftAnkle = rotX(-0.15),
		RightAnkle = rotX(-0.1),
		LeftShoulder = arm(0.5, -1.0),
		RightShoulder = arm(0.5, 1.0),
		LeftElbow = rotX(0.3),
		RightElbow = rotX(0.3),
	}

	-- Long drop: windmilling arms and pedalling legs.
	local w = t * 8
	local flailPose = {
		Waist = CFrame.Angles(0.1 * sin(t * 5), 0, 0.08 * sin(t * 3.3)),
		Neck = rotX(0.2),
		LeftShoulder = arm(w, -0.6),
		RightShoulder = arm(w + PI, 0.6),
		LeftElbow = rotX(0.4),
		RightElbow = rotX(0.4),
		LeftHip = rotX(0.55 + 0.55 * sin(t * 7)),
		RightHip = rotX(0.55 - 0.55 * sin(t * 7)),
		LeftKnee = rotX(-1.0 - 0.6 * sin(t * 7 + 1)),
		RightKnee = rotX(-1.0 + 0.6 * sin(t * 7 + 1)),
	}

	local up = blend({ { tuck, 1 - leap }, { leapPose, leap } })
	local down = blend({ { fall, 1 - leap * 0.5 }, { leapPose, leap * 0.5 } })
	return blend({ { up, rising * (1 - flail) }, { down, (1 - rising) * (1 - flail) }, { flailPose, flail } })
end

--============================================================
-- Climb, swim, sit
--============================================================

local function climbPose(mem, rig, inp, dt)
	-- One full cycle (each hand moves once) per two studs climbed.
	mem.climbPhase = (mem.climbPhase + TAU * inp.velocity.Y * dt / 2) % TAU
	local s = sin(mem.climbPhase)
	return {
		Root = CFrame.new(0, 0.03 * rig.legLength * sin(mem.climbPhase * 2), 0) * rotX(-0.05),
		Neck = rotX(0.25),
		LeftShoulder = arm(2.5 + 0.45 * s, -0.15),
		RightShoulder = arm(2.5 - 0.45 * s, 0.15),
		LeftElbow = rotX(0.5 - 0.35 * s),
		RightElbow = rotX(0.5 + 0.35 * s),
		LeftHip = rotX(0.55 - 0.45 * s),
		RightHip = rotX(0.55 + 0.45 * s),
		LeftKnee = rotX(-(0.9 - 0.6 * s)),
		RightKnee = rotX(-(0.9 + 0.6 * s)),
		LeftAnkle = rotX(0.2),
		RightAnkle = rotX(0.2),
	}
end

local function swimPose(mem, rig, inp, dt, t)
	local speed = inp.velocity.Magnitude
	local moving = smoothstep(2, 6, speed)
	mem.swimPhase = (mem.swimPhase + dt * lerp(2.6, 4.2, moving)) % TAU
	local a = mem.swimPhase

	-- Front crawl: body flat, arms circle continuously, legs flutter.
	local kick = sin(a * 3)
	local crawl = {
		Root = rotX(-1.3),
		Neck = rotX(0.9),
		LeftShoulder = arm(a, -0.2),
		RightShoulder = arm(a + PI, 0.2),
		LeftElbow = rotX(0.35 + 0.3 * max(0, sin(a))),
		RightElbow = rotX(0.35 + 0.3 * max(0, -sin(a))),
		LeftHip = rotX(0.18 * kick),
		RightHip = rotX(-0.18 * kick),
		LeftKnee = rotX(-0.3 - 0.15 * kick),
		RightKnee = rotX(-0.3 + 0.15 * kick),
		LeftAnkle = rotX(-0.6),
		RightAnkle = rotX(-0.6),
	}

	-- Treading water: upright, arms sculling, legs pedalling.
	local scull = sin(t * 3)
	local pedal = sin(t * 2.4)
	local tread = {
		Root = CFrame.new(0, 0.04 * rig.legLength * sin(t * 2.4 * 2), 0),
		Neck = rotX(0.1),
		LeftShoulder = arm(0.3 + 0.2 * cos(t * 3), -(1.0 + 0.25 * scull)),
		RightShoulder = arm(0.3 + 0.2 * cos(t * 3), 1.0 + 0.25 * scull),
		LeftElbow = rotX(0.6),
		RightElbow = rotX(0.6),
		LeftHip = rotX(0.5 + 0.35 * pedal),
		RightHip = rotX(0.5 - 0.35 * pedal),
		LeftKnee = rotX(-0.9 - 0.5 * pedal),
		RightKnee = rotX(-0.9 + 0.5 * pedal),
	}

	return blend({ { tread, 1 - moving }, { crawl, moving } })
end

local function sitPose(mem, t)
	local breath = sin(t * TAU / 3.8 + mem.seed)
	return {
		Waist = rotX(-0.03 + breath * 0.012),
		Neck = rotX(0.02 - breath * 0.008),
		LeftHip = rotX(PI / 2),
		RightHip = rotX(PI / 2),
		LeftKnee = rotX(-PI / 2),
		RightKnee = rotX(-PI / 2),
		LeftShoulder = arm(0.35 + breath * 0.015, -0.05),
		RightShoulder = arm(0.35 + breath * 0.015, 0.05),
		LeftElbow = rotX(0.85),
		RightElbow = rotX(0.85),
	}
end

--============================================================
-- Public entry point
--============================================================

--[[
	inp fields:
	  state        "ground" | "air" | "climb" | "swim" | "sit" | "limp"
	  velocity     Vector3, HRP space
	  yawRate      radians/second, + = turning left
	  time         seconds (any steady clock)
	  ground       optional { Left = number, Right = number }: ground height
	               under each foot relative to the flat floor under the HRP
	  holdingTool  optional boolean
	  look         optional Vector3, HRP-space direction to turn the head toward

	Returns a { [jointName] = CFrame } Transform table.
	After the call, mem.feet[side].target holds this frame's ankle targets
	(HRP space) so the caller can probe the ground under them.
]]
function Gait.update(mem, rig, inp, dt)
	local t = inp.time
	local state = inp.state

	if state ~= mem.state then
		if mem.state == "air" and state == "ground" then
			mem.landT = 0
			mem.landImpact = clamp((-mem.airVy - 15) / 85, 0, 1)
		end
		if state == "air" then
			mem.airTime = 0
			mem.leadSide = (mem.frontness >= 0) and "Left" or "Right"
		end
		mem.state = state
	end
	if state == "air" then
		mem.airTime = mem.airTime + dt
		mem.airVy = inp.velocity.Y
	end
	mem.landT = mem.landT + dt

	local forward = -inp.velocity.Z
	if dt > 1e-4 then
		local accel = (forward - mem.lastForward) / dt
		mem.accelLean = approach(mem.accelLean, clamp(accel * STYLE.ACCEL_LEAN, -0.1, 0.18), 4, dt)
	end
	mem.lastForward = forward

	local rate = FADE_IN[state] or 10
	for _, name in ipairs(STATES) do
		local target = (name == state) and 1 or 0
		mem.weights[name] = approach(mem.weights[name], target, rate, dt)
	end

	local w = mem.weights
	local layers = {}
	if w.ground > 1e-3 or state == "ground" then
		table.insert(layers, { groundPose(mem, rig, inp, dt, t), w.ground })
	end
	if w.air > 1e-3 then
		table.insert(layers, { airPose(mem, rig, inp, t), w.air })
	end
	if w.climb > 1e-3 then
		table.insert(layers, { climbPose(mem, rig, inp, dt), w.climb })
	end
	if w.swim > 1e-3 then
		table.insert(layers, { swimPose(mem, rig, inp, dt, t), w.swim })
	end
	if w.sit > 1e-3 then
		table.insert(layers, { sitPose(mem, t), w.sit })
	end
	if w.limp > 1e-3 then
		table.insert(layers, { {}, w.limp })
	end
	local pose = blend(layers)

	-- Holding a tool: right arm forward, as Roblox's default tool pose.
	local toolOk = inp.holdingTool and state ~= "swim" and state ~= "climb" and state ~= "limp"
	mem.toolWeight = approach(mem.toolWeight, toolOk and 1 or 0, 10, dt)
	if mem.toolWeight > 1e-3 then
		local k = mem.toolWeight
		pose.RightShoulder = pose.RightShoulder:Lerp(arm(1.5 + 0.05 * sin(TAU * mem.phase), 0.05), k)
		pose.RightElbow = pose.RightElbow:Lerp(rotX(0.1), k)
		pose.RightWrist = pose.RightWrist:Lerp(IDENTITY, k)
	end

	-- Head follows the camera (local player only).
	local yawTarget, pitchTarget = 0, 0
	if inp.look and (state == "ground" or state == "air" or state == "sit") then
		local look = inp.look
		local yaw = atan2(-look.X, -look.Z)
		if abs(yaw) < 1.9 then -- camera not facing the character's front
			yawTarget = clamp(yaw, -1, 1)
			pitchTarget = clamp(asin(clamp(look.Y, -1, 1)), -0.6, 0.6)
		end
	end
	mem.lookYaw = approach(mem.lookYaw, yawTarget, 8, dt)
	mem.lookPitch = approach(mem.lookPitch, pitchTarget, 8, dt)
	if abs(mem.lookYaw) + abs(mem.lookPitch) > 1e-3 then
		pose.Neck = CFrame.Angles(0, mem.lookYaw * 0.65, 0) * pose.Neck * rotX(mem.lookPitch * 0.55)
		pose.Waist = CFrame.Angles(0, mem.lookYaw * 0.3, 0) * pose.Waist
	end

	return pose
end

return Gait
