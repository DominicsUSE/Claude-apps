-- Minimal Roblox datatypes for running ChadAnimate modules in plain Lua 5.1.
-- Implements the subset of Vector3 / CFrame the modules use, with Roblox's
-- conventions: right-handed, -Z forward, CFrame.Angles(x, y, z) = Rx * Ry * Rz.

local Vector3 = {}
local V = {}
V.__index = function(v, key)
	if key == "X" then return v[1] end
	if key == "Y" then return v[2] end
	if key == "Z" then return v[3] end
	if key == "Magnitude" then return math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3]) end
	if key == "Unit" then
		local m = math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3])
		return Vector3.new(v[1] / m, v[2] / m, v[3] / m)
	end
	return Vector3[key]
end

function Vector3.new(x, y, z)
	return setmetatable({ x or 0, y or 0, z or 0, __type = "Vector3" }, V)
end
function Vector3.Dot(a, b) return a[1] * b[1] + a[2] * b[2] + a[3] * b[3] end
function Vector3.Cross(a, b)
	return Vector3.new(a[2] * b[3] - a[3] * b[2], a[3] * b[1] - a[1] * b[3], a[1] * b[2] - a[2] * b[1])
end
V.__add = function(a, b) return Vector3.new(a[1] + b[1], a[2] + b[2], a[3] + b[3]) end
V.__sub = function(a, b) return Vector3.new(a[1] - b[1], a[2] - b[2], a[3] - b[3]) end
V.__unm = function(a) return Vector3.new(-a[1], -a[2], -a[3]) end
V.__mul = function(a, b)
	if type(a) == "number" then return Vector3.new(a * b[1], a * b[2], a * b[3]) end
	if type(b) == "number" then return Vector3.new(a[1] * b, a[2] * b, a[3] * b) end
	return Vector3.new(a[1] * b[1], a[2] * b[2], a[3] * b[3])
end
V.__div = function(a, b) return Vector3.new(a[1] / b, a[2] / b, a[3] / b) end
V.__tostring = function(v) return string.format("(%.3f, %.3f, %.3f)", v[1], v[2], v[3]) end
Vector3.zero = Vector3.new(0, 0, 0)

-- CFrame: p = position, m = 3x3 row-major rotation.
local CFrame = {}
local C = {}

local function make(px, py, pz, m)
	return setmetatable({ p = { px, py, pz }, m = m, __type = "CFrame" }, C)
end

local function matmul(a, b)
	local r = {}
	for i = 0, 2 do
		for j = 0, 2 do
			r[i * 3 + j + 1] = a[i * 3 + 1] * b[j + 1] + a[i * 3 + 2] * b[3 + j + 1] + a[i * 3 + 3] * b[6 + j + 1]
		end
	end
	return r
end

local function transpose(m)
	return { m[1], m[4], m[7], m[2], m[5], m[8], m[3], m[6], m[9] }
end

local function rotate(m, x, y, z)
	return m[1] * x + m[2] * y + m[3] * z, m[4] * x + m[5] * y + m[6] * z, m[7] * x + m[8] * y + m[9] * z
end

local IDM = { 1, 0, 0, 0, 1, 0, 0, 0, 1 }

function CFrame.new(x, y, z)
	if type(x) == "table" and x.__type == "Vector3" then
		return make(x[1], x[2], x[3], IDM)
	end
	return make(x or 0, y or 0, z or 0, IDM)
end

function CFrame.Angles(rx, ry, rz)
	local cx, sx = math.cos(rx), math.sin(rx)
	local cy, sy = math.cos(ry), math.sin(ry)
	local cz, sz = math.cos(rz), math.sin(rz)
	local mx = { 1, 0, 0, 0, cx, -sx, 0, sx, cx }
	local my = { cy, 0, sy, 0, 1, 0, -sy, 0, cy }
	local mz = { cz, -sz, 0, sz, cz, 0, 0, 0, 1 }
	return make(0, 0, 0, matmul(mx, matmul(my, mz)))
end

function CFrame.fromMatrix3(m)
	return make(0, 0, 0, m)
end

C.__index = function(cf, key)
	if key == "Position" then return Vector3.new(cf.p[1], cf.p[2], cf.p[3]) end
	if key == "X" then return cf.p[1] end
	if key == "Y" then return cf.p[2] end
	if key == "Z" then return cf.p[3] end
	if key == "Rotation" then return make(0, 0, 0, cf.m) end
	if key == "LookVector" then return Vector3.new(-cf.m[3], -cf.m[6], -cf.m[9]) end
	if key == "RightVector" then return Vector3.new(cf.m[1], cf.m[4], cf.m[7]) end
	if key == "UpVector" then return Vector3.new(cf.m[2], cf.m[5], cf.m[8]) end
	return CFrame[key]
end

C.__mul = function(a, b)
	if b.__type == "Vector3" then
		local x, y, z = rotate(a.m, b[1], b[2], b[3])
		return Vector3.new(x + a.p[1], y + a.p[2], z + a.p[3])
	end
	local x, y, z = rotate(a.m, b.p[1], b.p[2], b.p[3])
	return make(x + a.p[1], y + a.p[2], z + a.p[3], matmul(a.m, b.m))
end

C.__tostring = function(cf)
	return string.format("CFrame(%.3f, %.3f, %.3f)", cf.p[1], cf.p[2], cf.p[3])
end

function CFrame.Inverse(cf)
	local t = transpose(cf.m)
	local x, y, z = rotate(t, -cf.p[1], -cf.p[2], -cf.p[3])
	return make(x, y, z, t)
end

function CFrame.PointToObjectSpace(cf, v)
	local t = transpose(cf.m)
	local x, y, z = rotate(t, v[1] - cf.p[1], v[2] - cf.p[2], v[3] - cf.p[3])
	return Vector3.new(x, y, z)
end

function CFrame.PointToWorldSpace(cf, v)
	return cf * v
end

function CFrame.VectorToObjectSpace(cf, v)
	local x, y, z = rotate(transpose(cf.m), v[1], v[2], v[3])
	return Vector3.new(x, y, z)
end

function CFrame.VectorToWorldSpace(cf, v)
	local x, y, z = rotate(cf.m, v[1], v[2], v[3])
	return Vector3.new(x, y, z)
end

-- Rotation matrix <-> quaternion (w, x, y, z).
local function toQuat(m)
	local tr = m[1] + m[5] + m[9]
	local w, x, y, z
	if tr > 0 then
		local s = math.sqrt(tr + 1) * 2
		w = 0.25 * s
		x = (m[8] - m[6]) / s
		y = (m[3] - m[7]) / s
		z = (m[4] - m[2]) / s
	elseif m[1] > m[5] and m[1] > m[9] then
		local s = math.sqrt(1 + m[1] - m[5] - m[9]) * 2
		w = (m[8] - m[6]) / s
		x = 0.25 * s
		y = (m[2] + m[4]) / s
		z = (m[3] + m[7]) / s
	elseif m[5] > m[9] then
		local s = math.sqrt(1 + m[5] - m[1] - m[9]) * 2
		w = (m[3] - m[7]) / s
		x = (m[2] + m[4]) / s
		y = 0.25 * s
		z = (m[6] + m[8]) / s
	else
		local s = math.sqrt(1 + m[9] - m[1] - m[5]) * 2
		w = (m[4] - m[2]) / s
		x = (m[3] + m[7]) / s
		y = (m[6] + m[8]) / s
		z = 0.25 * s
	end
	return w, x, y, z
end

local function fromQuat(w, x, y, z)
	local n = math.sqrt(w * w + x * x + y * y + z * z)
	w, x, y, z = w / n, x / n, y / n, z / n
	return {
		1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
		2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
		2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
	}
end

function CFrame.Lerp(a, b, t)
	local aw, ax, ay, az = toQuat(a.m)
	local bw, bx, by, bz = toQuat(b.m)
	local dot = aw * bw + ax * bx + ay * by + az * bz
	if dot < 0 then
		bw, bx, by, bz, dot = -bw, -bx, -by, -bz, -dot
	end
	local wa, wb
	if dot > 0.9995 then
		wa, wb = 1 - t, t
	else
		local theta = math.acos(dot)
		local s = math.sin(theta)
		wa, wb = math.sin((1 - t) * theta) / s, math.sin(t * theta) / s
	end
	local m = fromQuat(aw * wa + bw * wb, ax * wa + bx * wb, ay * wa + by * wb, az * wa + bz * wb)
	return make(
		a.p[1] + (b.p[1] - a.p[1]) * t,
		a.p[2] + (b.p[2] - a.p[2]) * t,
		a.p[3] + (b.p[3] - a.p[3]) * t,
		m
	)
end

CFrame.identity = CFrame.new()

-- Luau math extensions the modules may use.
math.clamp = math.clamp or function(x, lo, hi)
	if x < lo then return lo elseif x > hi then return hi end
	return x
end
math.sign = math.sign or function(x)
	if x > 0 then return 1 elseif x < 0 then return -1 end
	return 0
end

return { Vector3 = Vector3, CFrame = CFrame }
