-- Runs Rig + Gait on the mock R15 rig, checks the results, and records
-- frames for the preview renderer. Called by run_tests.py with:
--   M (roblox_math), Rig, Gait, build (fixture builder)
local M, Rig, Gait, build = ...
local CFrame, Vector3 = M.CFrame, M.Vector3
local I = CFrame.new()

local results = { checks = {}, frames = {}, stats = {} }
local function check(name, ok, detail)
	table.insert(results.checks, { name = name, ok = ok and true or false, detail = detail or "" })
end

local function angleX(cf)
	-- Rotation about X for a pure X rotation: atan2(r21, r22).
	return math.atan2(cf.m[8], cf.m[9])
end

local function isNaN(x)
	return x ~= x
end

--============================================================
-- Rig
--============================================================

local fix = build()
local joints, err = Rig.findJoints(fix.character)
check("findJoints finds every R15 joint", joints ~= nil and joints.RightAnkle ~= nil, tostring(err))
check("findJoints skips the accessory's Neck decoy", joints.Neck and joints.Neck.Parent.Name == "Head")

local rig = Rig.measure(fix.humanoid, fix.root, joints)
check("measure: leg length = hip height above floor", math.abs(rig.legLength - 1.8) < 1e-6, rig.legLength)
check("measure: thigh and shin lengths", math.abs(rig.legs.Left.upper - 0.85) < 1e-6 and math.abs(rig.legs.Left.lower - 0.8) < 1e-6)
check("measure: ankle height", math.abs(rig.ankleHeight - 0.15) < 1e-6, rig.ankleHeight)
check("measure: toe and heel lengths", math.abs(rig.toeLength - 0.7) < 1e-6 and math.abs(rig.heelLength - 0.3) < 1e-6,
	rig.toeLength .. " " .. rig.heelLength)
check("measure: floor from HipHeight", math.abs(rig.groundY + 3) < 1e-6, rig.groundY)

local fixC = build({ constraints = true })
local jointsC = Rig.findJoints(fixC.character)
local rigC = jointsC and Rig.measure(fixC.humanoid, fixC.root, jointsC)
check("AnimationConstraint rigs measure the same", rigC ~= nil and math.abs(rigC.legLength - rig.legLength) < 1e-6)

local broken = build()
broken.joints.LeftKnee.Name = "SomethingElse"
local none, why = Rig.findJoints(broken.character)
check("findJoints reports a missing required joint", none == nil and why ~= nil, tostring(why))

--============================================================
-- Forward kinematics on the fixture (HRP space)
--============================================================

local function fk(pose)
	local function frames(name)
		local j = fix.joints[name]
		return j.C0, j.C1
	end
	local function child(parent, name)
		local c0, c1 = frames(name)
		return parent * c0 * (pose[name] or I) * c1:Inverse()
	end
	local function pivot(parent, name)
		local c0 = frames(name)
		return (parent * c0).Position
	end
	local out = {}
	local hrp = I
	local lt = child(hrp, "Root")
	local ut = child(lt, "Waist")
	local head = child(ut, "Neck")
	out.pelvis = lt.Position
	out.neck = pivot(ut, "Neck")
	out.head = head.Position
	out.headTop = head * Vector3.new(0, 0.5, 0)
	out.face = head * Vector3.new(0, 0, -0.5)
	for _, s in ipairs({ "Left", "Right" }) do
		local ua = child(ut, s .. "Shoulder")
		local la = child(ua, s .. "Elbow")
		local hand = child(la, s .. "Wrist")
		local ul = child(lt, s .. "Hip")
		local ll = child(ul, s .. "Knee")
		local foot = child(ll, s .. "Ankle")
		out[s .. "Shoulder"] = pivot(ut, s .. "Shoulder")
		out[s .. "Elbow"] = pivot(ua, s .. "Elbow")
		out[s .. "Wrist"] = pivot(la, s .. "Wrist")
		out[s .. "Hand"] = hand * Vector3.new(0, -0.15, 0)
		out[s .. "Hip"] = pivot(lt, s .. "Hip")
		out[s .. "Knee"] = pivot(ul, s .. "Knee")
		out[s .. "Ankle"] = pivot(ll, s .. "Ankle")
		out[s .. "Toe"] = foot * Vector3.new(0, -0.15, -0.5)
		out[s .. "Heel"] = foot * Vector3.new(0, -0.15, 0.5)
		local low = math.huge
		for _, c in ipairs({ { -0.5, -0.5 }, { 0.5, -0.5 }, { -0.5, 0.5 }, { 0.5, 0.5 } }) do
			low = math.min(low, (foot * Vector3.new(c[1], -0.15, c[2])).Y)
		end
		out[s .. "Sole"] = low
	end
	return out
end

local POINTS = {
	"pelvis", "neck", "head", "headTop", "face",
	"LeftShoulder", "LeftElbow", "LeftWrist", "LeftHand", "LeftHip", "LeftKnee", "LeftAnkle", "LeftToe", "LeftHeel",
	"RightShoulder", "RightElbow", "RightWrist", "RightHand", "RightHip", "RightKnee", "RightAnkle", "RightToe", "RightHeel",
}

--============================================================
-- Simulation
--============================================================

local DT = 1 / 60

-- scenario(t) -> state, velocity (HRP space), extras
local function simulate(name, duration, scenario, record)
	local mem = Gait.newMemory(1.3)
	local worldZ, worldY = 0, 0
	local frames = {}
	local stats = { kneeMax = -math.huge, soleMin = math.huge, ikErr = 0, nan = false, slide = 0, slideN = 0,
		speed = 0, flight = 0, groundFrames = 0, pelvisMin = math.huge, armLegCorr = 0, crossed = 0 }
	local lastAnkleWorld = {}
	local lastPlanted = {}
	local t = 0
	while t < duration do
		local state, vel, extra = scenario(t)
		extra = extra or {}
		local inp = {
			state = state,
			velocity = vel,
			yawRate = extra.yawRate or 0,
			time = t,
			ground = extra.ground,
			holdingTool = extra.tool,
		}
		local pose = Gait.update(mem, rig, inp, DT)
		local p = fk(pose)

		for _, jn in ipairs(Gait.JOINTS) do
			local cf = pose[jn]
			for i = 1, 9 do
				if isNaN(cf.m[i]) then stats.nan = true end
			end
			for i = 1, 3 do
				if isNaN(cf.p[i]) then stats.nan = true end
			end
		end

		for _, s in ipairs({ "Left", "Right" }) do
			stats.kneeMax = math.max(stats.kneeMax, angleX(pose[s .. "Knee"]))
		end

		if state == "ground" and mem.weights.ground > 0.99 then
			stats.groundFrames = stats.groundFrames + 1
			local airborne = 0
			for _, s in ipairs({ "Left", "Right" }) do
				local floor = rig.groundY + ((extra.ground and extra.ground[s]) or 0)
				stats.soleMin = math.min(stats.soleMin, p[s .. "Sole"] - floor)
				local foot = mem.feet[s]
				local ankleWorld = Vector3.new(p[s .. "Ankle"].X, p[s .. "Ankle"].Y, p[s .. "Ankle"].Z + worldZ)
				if foot.planted then
					stats.ikErr = math.max(stats.ikErr, (p[s .. "Ankle"] - foot.target).Magnitude)
					if lastAnkleWorld[s] and lastPlanted[s] then
						local d = ankleWorld - lastAnkleWorld[s]
						stats.slide = stats.slide + math.sqrt(d.X * d.X + d.Z * d.Z) / DT
						stats.slideN = stats.slideN + 1
					end
				end
				if p[s .. "Sole"] - floor > 0.05 then
					airborne = airborne + 1
				end
				lastAnkleWorld[s] = ankleWorld
				lastPlanted[s] = foot.planted
			end
			if airborne == 2 then
				stats.flight = stats.flight + 1
			end
			-- Arm swing against leg swing: left shoulder vs left hip.
			stats.armLegCorr = stats.armLegCorr + angleX(pose.LeftShoulder) * angleX(pose.LeftHip)
			stats.pelvisMin = math.min(stats.pelvisMin, p.pelvis.Y)
			if p.LeftAnkle.X > p.RightAnkle.X - 0.05 then
				stats.crossed = stats.crossed + 1
			end
		else
			lastAnkleWorld = {}
		end

		stats.speed = stats.speed + math.sqrt(vel.X * vel.X + vel.Z * vel.Z)
		worldZ = worldZ + vel.Z * DT

		if record then
			local f = { t = t, state = state, worldZ = worldZ, worldY = extra.worldY or 0, pts = {} }
			for _, k in ipairs(POINTS) do
				local v = p[k]
				f.pts[k] = { v.X, v.Y, v.Z }
			end
			table.insert(frames, f)
		end
		t = t + DT
	end
	local n = math.floor(duration / DT + 0.5)
	stats.speed = stats.speed / n
	stats.slide = stats.slideN > 0 and stats.slide / stats.slideN or 0
	stats.flight = stats.groundFrames > 0 and stats.flight / stats.groundFrames or 0
	results.stats[name] = stats
	if record then
		results.frames[name] = frames
	end
	return stats
end

local function constant(state, vx, vy, vz, extra)
	return function()
		return state, Vector3.new(vx, vy, vz), extra
	end
end

local GRAVITY = 196.2

local idle = simulate("idle", 6, constant("ground", 0, 0, 0), true)
local walk = simulate("walk", 3, constant("ground", 0, 0, -12), true)
local slow = simulate("stroll", 3, constant("ground", 0, 0, -5), true)
local run = simulate("run", 3, constant("ground", 0, 0, -24), true)
local back = simulate("backwards", 2, constant("ground", 0, 0, 8))
local strafe = simulate("strafe", 2, constant("ground", 10, 0, 0), true)

simulate("sprint start and stop", 4, function(t)
	local v
	if t < 0.5 then v = 0 elseif t < 1.0 then v = 12 elseif t < 3.0 then v = 24 elseif t < 3.3 then v = 8 else v = 0 end
	return "ground", Vector3.new(0, 0, -v)
end, true)

-- Running jump: ground, then a ballistic arc, then landing.
local jumpStart, jumpV = 0.6, 53
local airTime = 2 * jumpV / GRAVITY
local landed = simulate("jump", 2.2, function(t)
	if t >= jumpStart and t < jumpStart + airTime then
		local ta = t - jumpStart
		return "air", Vector3.new(0, jumpV - GRAVITY * ta, -16), { worldY = jumpV * ta - 0.5 * GRAVITY * ta * ta }
	end
	return "ground", Vector3.new(0, 0, -16)
end, true)

local stand = simulate("standing jump", 1.6, function(t)
	if t >= 0.3 and t < 0.3 + airTime then
		local ta = t - 0.3
		return "air", Vector3.new(0, jumpV - GRAVITY * ta, 0), { worldY = jumpV * ta - 0.5 * GRAVITY * ta * ta }
	end
	return "ground", Vector3.new(0, 0, 0)
end, true)

-- Long drop: 1.8 s of freefall then a hard landing.
local drop = simulate("long fall", 2.6, function(t)
	if t < 1.8 then
		local h = 0.5 * GRAVITY * 1.8 * 1.8
		return "air", Vector3.new(0, -GRAVITY * t, 0), { worldY = h - 0.5 * GRAVITY * t * t }
	end
	return "ground", Vector3.new(0, 0, 0)
end, true)

simulate("climb", 2.5, constant("climb", 0, 8, 0), true)
simulate("swim", 2.5, constant("swim", 0, 0, -10), true)
simulate("tread water", 2.5, constant("swim", 0, 0, 0))
simulate("sit", 1.5, constant("sit", 0, 0, 0), true)
simulate("walk holding tool", 2, constant("ground", 0, 0, -12, { tool = true }))

-- Stairs: 1-stud steps every 2 studs going up ahead. Ground heights under
-- each foot come from its last target, as the client does with raycasts.
do
	local mem = Gait.newMemory(0.7)
	local worldZ = 0
	local frames = {}
	local maxSoleErr = 0
	local function stepHeight(z)
		if z > -4 then return 0 end
		return math.min(math.floor((-z - 4) / 2) + 1, 10)
	end
	local ground = { Left = 0, Right = 0 }
	for i = 0, 180 do
		local t = i * DT
		local under = stepHeight(worldZ)
		local pose = Gait.update(mem, rig, {
			state = "ground", velocity = Vector3.new(0, 0, -8), yawRate = 0, time = t, ground = ground,
		}, DT)
		local p = fk(pose)
		for _, s in ipairs({ "Left", "Right" }) do
			local target = mem.feet[s].target
			ground[s] = stepHeight(worldZ + target.Z) - under
			if mem.feet[s].planted and i > 30 then
				local floor = rig.groundY + mem.feet[s].ground
				maxSoleErr = math.max(maxSoleErr, math.abs(p[s .. "Sole"] - floor))
			end
		end
		local f = { t = t, state = "ground", worldZ = worldZ, worldY = under, pts = {} }
		for _, k in ipairs(POINTS) do
			local v = p[k]
			f.pts[k] = { v.X, v.Y, v.Z }
		end
		table.insert(frames, f)
		worldZ = worldZ - 8 * DT
	end
	results.frames.stairs = frames
	check("stairs: planted soles rest on their own step", maxSoleErr < 0.35, string.format("%.3f", maxSoleErr))
end

--============================================================
-- Checks on the simulations
--============================================================

for name, s in pairs(results.stats) do
	check(name .. ": no NaN", not s.nan)
	check(name .. ": knees never bend forward", s.kneeMax < 0.02, string.format("max %.3f", s.kneeMax))
end

for _, name in ipairs({ "idle", "walk", "stroll", "run", "backwards", "strafe" }) do
	local s = results.stats[name]
	check(name .. ": planted ankles hit their IK targets", s.ikErr < 0.02, string.format("%.4f", s.ikErr))
	check(name .. ": feet stay above the floor", s.soleMin > -0.03, string.format("%.3f", s.soleMin))
end

check("idle: feet planted (no sliding)", idle.slide < 0.15, string.format("%.3f studs/s", idle.slide))
check("stroll: planted feet slide under a quarter of body speed", slow.slide < 0.25 * slow.speed,
	string.format("%.2f of %.1f studs/s", slow.slide, slow.speed))
check("walk: planted feet slide under 55% of body speed", walk.slide < 0.55 * walk.speed,
	string.format("%.2f of %.1f studs/s", walk.slide, walk.speed))
check("run: planted feet slide under 55% of body speed", run.slide < 0.55 * run.speed,
	string.format("%.2f of %.1f studs/s", run.slide, run.speed))
check("strafe: feet never cross", strafe.crossed == 0, tostring(strafe.crossed))
check("walk: always a foot on the ground", walk.flight < 0.02, string.format("%.3f", walk.flight))
check("run: both feet leave the ground between steps", run.flight > 0.05, string.format("%.3f", run.flight))
check("walk: arms swing against legs", walk.armLegCorr < 0, string.format("%.3f", walk.armLegCorr))
check("run: arms swing against legs", run.armLegCorr < 0, string.format("%.3f", run.armLegCorr))
check("run: body lower than walk at mid-stance", run.pelvisMin < walk.pelvisMin,
	string.format("%.3f vs %.3f", run.pelvisMin, walk.pelvisMin))

-- Landing crouch: lowest pelvis after a hard landing is below idle.
check("hard landing crouches deeper than a hop", drop.pelvisMin < stand.pelvisMin - 0.1,
	string.format("%.3f vs %.3f", drop.pelvisMin, stand.pelvisMin))
check("landing keeps feet planted", drop.soleMin > -0.03 and drop.ikErr < 0.02,
	string.format("sole %.3f ik %.4f", drop.soleMin, drop.ikErr))

-- Tool pose: right arm points forward.
do
	local mem = Gait.newMemory(0)
	local pose
	for i = 1, 60 do
		pose = Gait.update(mem, rig, { state = "ground", velocity = Vector3.new(0, 0, 0), time = i * DT, holdingTool = true }, DT)
	end
	local p = fk(pose)
	local dir = p.RightWrist - p.RightShoulder
	check("tool: right arm held forward", dir.Z < -0.6 and math.abs(dir.Y) < 0.35, tostring(dir))
end

-- Sit: thighs forward and level, shins hang down.
do
	local mem = Gait.newMemory(0)
	local pose
	for i = 1, 90 do
		pose = Gait.update(mem, rig, { state = "sit", velocity = Vector3.new(0, 0, 0), time = i * DT }, DT)
	end
	local p = fk(pose)
	local thigh = p.LeftKnee - p.LeftHip
	local shin = p.LeftAnkle - p.LeftKnee
	check("sit: thigh points forward", thigh.Z < -0.7 and math.abs(thigh.Y) < 0.1, tostring(thigh))
	check("sit: shin hangs down", shin.Y < -0.7 and math.abs(shin.Z) < 0.1, tostring(shin))
end

-- Head look: camera looking left turns the face left.
do
	local mem = Gait.newMemory(0)
	local pose
	for i = 1, 60 do
		pose = Gait.update(mem, rig, { state = "ground", velocity = Vector3.new(0, 0, 0), time = 0,
			look = Vector3.new(-0.7, 0, -0.7) }, DT)
	end
	local p = fk(pose)
	local faceDir = p.face - p.head
	check("look: face turns toward the camera's side", faceDir.X < -0.15, tostring(faceDir))
end

return results
