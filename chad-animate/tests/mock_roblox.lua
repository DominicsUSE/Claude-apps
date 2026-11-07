-- A mock Roblox engine for smoke tests. Every class, property, method, event
-- and enum the scripts touch is checked against the real API dump (passed
-- in by run_tests.py): unknown names, read-only writes, wrong value types,
-- non-creatable classes and missing script permissions all raise errors.
--
-- Not a simulator: physics, rendering and networking are not modelled.

local M, API = ...
local CFrame, Vector3 = M.CFrame, M.Vector3

local mock = { log = {}, warnings = {}, clock = 0, context = "game" }

--============================================================
-- Datatypes the shim lacks
--============================================================

local Color3 = {}
local C3 = { __index = Color3 }
function Color3.new(r, g, b)
	return setmetatable({ R = r or 0, G = g or 0, B = b or 0, __type = "Color3" }, C3)
end
function Color3.fromRGB(r, g, b)
	return Color3.new((r or 0) / 255, (g or 0) / 255, (b or 0) / 255)
end

local UDim2 = {}
function UDim2.new(xs, xo, ys, yo)
	return { __type = "UDim2", xs = xs, xo = xo, ys = ys, yo = yo }
end
function UDim2.fromScale(x, y)
	return UDim2.new(x, 0, y, 0)
end
function UDim2.fromOffset(x, y)
	return UDim2.new(0, x, 0, y)
end

function CFrame.lookAt(at, target)
	local look = (target - at).Unit
	local up = Vector3.new(0, 1, 0)
	local right = look:Cross(up).Unit
	local up2 = right:Cross(look)
	local cf = CFrame.fromMatrix3({
		right.X, up2.X, -look.X,
		right.Y, up2.Y, -look.Y,
		right.Z, up2.Z, -look.Z,
	})
	return CFrame.new(at.X, at.Y, at.Z) * cf
end

local RAYCAST_FIELDS = {
	FilterType = true, FilterDescendantsInstances = true, IgnoreWater = true,
	RespectCanCollide = true, CollisionGroup = true, BruteForceAllSlow = true,
}
local RaycastParams = {}
function RaycastParams.new()
	return setmetatable({ __type = "RaycastParams" }, {
		__newindex = function(t, k, v)
			if not RAYCAST_FIELDS[k] then
				error("RaycastParams has no field " .. tostring(k), 2)
			end
			rawset(t, k, v)
		end,
	})
end

--============================================================
-- Enums
--============================================================

local enumCache = {}
local Enum = setmetatable({}, {
	__index = function(_, enumName)
		local items = API.enums[enumName]
		if not items then
			error("unknown enum Enum." .. tostring(enumName), 2)
		end
		if not enumCache[enumName] then
			enumCache[enumName] = setmetatable({}, {
				__index = function(t, itemName)
					local legacy = API.enumLegacy[enumName] and API.enumLegacy[enumName][itemName]
					if legacy then
						table.insert(mock.warnings, "legacy enum name Enum." .. enumName .. "." .. itemName .. " (now " .. legacy .. ")")
						return t[legacy]
					end
					if items[itemName] == nil then
						error("unknown enum item Enum." .. enumName .. "." .. tostring(itemName), 2)
					end
					local item = { EnumType = enumName, Name = itemName, Value = items[itemName], __type = "EnumItem" }
					rawset(t, itemName, item)
					return item
				end,
			})
		end
		return enumCache[enumName]
	end,
})

--============================================================
-- Signals
--============================================================

local function newSignal()
	local signal = { handlers = {} }
	function signal:Connect(fn)
		local entry = { fn = fn, Connected = true }
		table.insert(self.handlers, entry)
		function entry:Disconnect()
			self.Connected = false
		end
		return entry
	end
	function signal:Once(fn)
		return self:Connect(fn)
	end
	function signal:Wait()
		return coroutine.yield()
	end
	function signal:Fire(...)
		for _, h in ipairs(self.handlers) do
			if h.Connected then
				h.fn(...)
			end
		end
	end
	return signal
end

--============================================================
-- Instances
--============================================================

local function memberOf(className, key)
	local c = className
	while c and c ~= "" do
		local cls = API.classes[c]
		if not cls then
			return nil
		end
		local m = cls.members[key]
		if m then
			return m
		end
		c = cls.super
	end
	return nil
end

local function isA(className, target)
	local c = className
	while c and c ~= "" do
		if c == target then
			return true
		end
		local cls = API.classes[c]
		c = cls and cls.super
	end
	return false
end

local function allowed(security)
	if security == "None" then
		return true
	end
	return mock.context == "plugin" and security == "PluginSecurity"
end

local DEFAULTS = {
	bool = false, float = 0, double = 0, int = 0, int64 = 0, string = "",
}

local function defaultFor(member)
	if DEFAULTS[member.type] ~= nil then
		return DEFAULTS[member.type]
	end
	if member.type == "Vector3" then return Vector3.new() end
	if member.type == "CFrame" then return CFrame.new() end
	if member.type == "Color3" then return Color3.new() end
	if member.cat == "Enum" then
		return Enum[member.type][API.enumFirst[member.type]]
	end
	return nil
end

local function typeMatches(member, value)
	local t, cat = member.type, member.cat
	if value == nil then
		return cat == "Class"
	end
	if t == "bool" then return type(value) == "boolean" end
	if t == "float" or t == "double" or t == "int" or t == "int64" then return type(value) == "number" end
	if t == "string" or t == "Content" or t == "ContentId" then return type(value) == "string" end
	if cat == "Enum" then return type(value) == "table" and value.EnumType == t end
	if cat == "Class" then return type(value) == "table" and value.__instance and isA(value.ClassName, t) end
	if type(value) == "table" and value.__type then return value.__type == t end
	return true -- datatypes the mock doesn't model
end

local Instance = {}
local InstanceMT = {}
local METHODS = {}
local OVERRIDES = {} -- [className] = { [method] = fn }

local function newRaw(className)
	local obj = { __instance = true, __class = className, __props = {}, __children = {}, __signals = {}, __tags = {} }
	return setmetatable(obj, InstanceMT)
end

function Instance.new(className)
	local cls = API.classes[className]
	if not cls then
		error("Instance.new: unknown class " .. tostring(className), 2)
	end
	if cls.notCreatable then
		error("Instance.new: " .. className .. " is not creatable", 2)
	end
	return newRaw(className)
end
mock.newRaw = newRaw

local function setParent(obj, parent)
	local old = rawget(obj, "__parent")
	if old then
		local list = rawget(old, "__children")
		for i, c in ipairs(list) do
			if c == obj then
				table.remove(list, i)
				break
			end
		end
	end
	rawset(obj, "__parent", parent)
	if parent then
		table.insert(rawget(parent, "__children"), obj)
		local added = rawget(parent, "__signals").ChildAdded
		if added then
			added:Fire(obj)
		end
	end
end

InstanceMT.__index = function(self, key)
	local class = rawget(self, "__class")
	if key == "ClassName" then return class end
	if key == "Parent" then return rawget(self, "__parent") end
	local override = OVERRIDES[class] and OVERRIDES[class][key]
	if override then return override end
	if METHODS[key] then return METHODS[key] end
	local member = memberOf(class, key)
	if not member then
		for _, c in ipairs(rawget(self, "__children")) do
			if c.Name == key then
				return c
			end
		end
		error("mock: " .. class .. " has no member '" .. tostring(key) .. "'", 2)
	end
	if not allowed(member.readSec) then
		error("mock: " .. class .. "." .. key .. " is not readable from scripts", 2)
	end
	if member.kind == "Property" then
		local props = rawget(self, "__props")
		if props[key] == nil and key == "Name" then
			return class
		end
		if props[key] == nil then
			return defaultFor(member)
		end
		return props[key]
	elseif member.kind == "Event" then
		local signals = rawget(self, "__signals")
		signals[key] = signals[key] or newSignal()
		return signals[key]
	elseif member.kind == "Function" then
		if member.deprecated then
			table.insert(mock.warnings, "deprecated method " .. class .. ":" .. key)
		end
		return function(obj, ...)
			table.insert(mock.log, { obj = obj, method = key, args = { ... } })
			return nil
		end
	end
	error("mock: unsupported member kind for " .. class .. "." .. key, 2)
end

InstanceMT.__newindex = function(self, key, value)
	local class = rawget(self, "__class")
	if key == "Parent" then
		setParent(self, value)
		return
	end
	local member = memberOf(class, key)
	if not member or member.kind ~= "Property" then
		error("mock: " .. class .. " has no property '" .. tostring(key) .. "'", 2)
	end
	if member.readOnly then
		error("mock: " .. class .. "." .. key .. " is read-only", 2)
	end
	if not allowed(member.writeSec) then
		error("mock: " .. class .. "." .. key .. " is not writable from this context", 2)
	end
	if member.deprecated then
		table.insert(mock.warnings, "deprecated property " .. class .. "." .. key)
	end
	if not typeMatches(member, value) then
		error("mock: wrong type for " .. class .. "." .. key .. " (" .. member.type .. ")", 2)
	end
	rawget(self, "__props")[key] = value
end

InstanceMT.__tostring = function(self)
	return self:GetFullName()
end

function METHODS:IsA(className)
	return isA(rawget(self, "__class"), className)
end
function METHODS:GetChildren()
	local out = {}
	for i, c in ipairs(rawget(self, "__children")) do
		out[i] = c
	end
	return out
end
function METHODS:GetDescendants()
	local out = {}
	local function walk(o)
		for _, c in ipairs(rawget(o, "__children")) do
			table.insert(out, c)
			walk(c)
		end
	end
	walk(self)
	return out
end
function METHODS:FindFirstChild(name)
	for _, c in ipairs(rawget(self, "__children")) do
		if c.Name == name then
			return c
		end
	end
	return nil
end
function METHODS:FindFirstChildOfClass(className)
	for _, c in ipairs(rawget(self, "__children")) do
		if rawget(c, "__class") == className then
			return c
		end
	end
	return nil
end
function METHODS:FindFirstChildWhichIsA(className)
	for _, c in ipairs(rawget(self, "__children")) do
		if c:IsA(className) then
			return c
		end
	end
	return nil
end
function METHODS:WaitForChild(name)
	local c = self:FindFirstChild(name)
	if not c then
		error("mock: WaitForChild('" .. name .. "') on " .. self:GetFullName() .. " would wait forever", 2)
	end
	return c
end
function METHODS:IsDescendantOf(ancestor)
	local p = rawget(self, "__parent")
	while p do
		if p == ancestor then
			return true
		end
		p = rawget(p, "__parent")
	end
	return false
end
function METHODS:Destroy()
	setParent(self, nil)
	local d = rawget(self, "__signals").Destroying
	if d then
		d:Fire()
	end
end
function METHODS:GetFullName()
	local names = {}
	local o = self
	while o and rawget(o, "__class") ~= "DataModel" do
		table.insert(names, 1, o.Name)
		o = rawget(o, "__parent")
	end
	return table.concat(names, ".")
end
function METHODS:PivotTo(cf)
	rawget(self, "__props").__pivot = cf
end
function METHODS:GetPropertyChangedSignal(name)
	local signals = rawget(self, "__signals")
	signals["changed:" .. name] = signals["changed:" .. name] or newSignal()
	return signals["changed:" .. name]
end

-- Set a property without checks (read-only engine state in fixtures).
function mock.setRaw(obj, key, value)
	rawget(obj, "__props")[key] = value
end

--============================================================
-- Class-specific behaviour
--============================================================

local tagged = {}

OVERRIDES.CollectionService = {
	AddTag = function(_, obj, tag)
		tagged[tag] = tagged[tag] or {}
		table.insert(tagged[tag], obj)
	end,
	GetTagged = function(_, tag)
		local out = {}
		for _, o in ipairs(tagged[tag] or {}) do
			table.insert(out, o)
		end
		return out
	end,
	HasTag = function(_, obj, tag)
		for _, o in ipairs(tagged[tag] or {}) do
			if o == obj then return true end
		end
		return false
	end,
}

OVERRIDES.Humanoid = {
	GetState = function(self)
		return rawget(self, "__props").__state or Enum.HumanoidStateType.Running
	end,
	MoveTo = function(self, target)
		table.insert(mock.log, { obj = self, method = "MoveTo", args = { target } })
	end,
}

OVERRIDES.Seat = {
	Sit = function(self, humanoid)
		mock.setRaw(humanoid, "Sit", true)
		mock.setRaw(humanoid, "SeatPart", self)
		mock.setRaw(self, "Occupant", humanoid)
	end,
}

OVERRIDES.Animator = {
	GetPlayingAnimationTracks = function()
		return {}
	end,
}

OVERRIDES.Workspace = {
	Raycast = function()
		return nil
	end,
}

OVERRIDES.UserInputService = {
	GetFocusedTextBox = function()
		return nil
	end,
}

OVERRIDES.ContextActionService = {
	BindAction = function(_, name, fn)
		mock.actions = mock.actions or {}
		mock.actions[name] = fn
	end,
}

-- Assigned by the test: returns a mock character model.
OVERRIDES.Players = {
	CreateHumanoidModelFromDescriptionAsync = function(_, description, rigType)
		assert(rawget(description, "__class") == "HumanoidDescription", "expected a HumanoidDescription")
		assert(rigType == Enum.HumanoidRigType.R15, "expected an R15 rig")
		return mock.makeCharacter("NPC")
	end,
	GetPlayers = function()
		return mock.players or {}
	end,
}

--============================================================
-- DataModel
--============================================================

function mock.newGame()
	tagged = {}
	local game = newRaw("DataModel")
	local services = {}
	local function service(name)
		if not services[name] then
			local s = newRaw(name)
			setParent(s, game)
			services[name] = s
		end
		return services[name]
	end
	OVERRIDES.DataModel = {
		GetService = function(_, name)
			if not API.classes[name] then
				error("mock: GetService: unknown service " .. tostring(name), 2)
			end
			return service(name)
		end,
	}
	local ws = service("Workspace")
	local terrain = newRaw("Terrain")
	setParent(terrain, ws)
	mock.setRaw(ws, "Terrain", terrain)
	local camera = newRaw("Camera")
	setParent(camera, ws)
	mock.setRaw(ws, "CurrentCamera", camera)
	local sp = service("StarterPlayer")
	setParent(newRaw("StarterPlayerScripts"), sp)
	setParent(newRaw("StarterCharacterScripts"), sp)
	mock.game = game
	return game
end

--============================================================
-- Running scripts
--============================================================

local threads = {}
local requireCache = {}

local task = {
	spawn = function(fn, ...)
		local co = coroutine.create(fn)
		table.insert(threads, co)
		local ok, err = coroutine.resume(co, ...)
		if not ok then error(err, 0) end
		return co
	end,
	defer = function(fn, ...)
		local args = { ... }
		local co = coroutine.create(function() return fn(unpack(args)) end)
		table.insert(threads, co)
		return co
	end,
	wait = function(t)
		coroutine.yield()
		return t or 0
	end,
}

function mock.stepThreads()
	local live = {}
	for _, co in ipairs(threads) do
		if coroutine.status(co) == "suspended" then
			local ok, err = coroutine.resume(co)
			if not ok then
				error(err, 0)
			end
		end
		if coroutine.status(co) ~= "dead" then
			table.insert(live, co)
		end
	end
	threads = live
end

-- Luau's pcall can yield (task.wait inside pcall); Lua 5.1's can't.
-- Run the call in its own coroutine and pass yields through.
local function ypcall(f, ...)
	local co = coroutine.create(f)
	local result = { coroutine.resume(co, ...) }
	while coroutine.status(co) ~= "dead" do
		local resumed = { coroutine.yield(unpack(result, 2)) }
		result = { coroutine.resume(co, unpack(resumed)) }
	end
	return unpack(result)
end

local function envFor(scriptInstance)
	local tbl = {}
	for k, v in pairs(table) do tbl[k] = v end
	tbl.clear = function(t) for k in pairs(t) do t[k] = nil end end
	local env = {
		game = mock.game,
		workspace = mock.game:GetService("Workspace"),
		script = scriptInstance,
		Instance = Instance, Enum = Enum, Vector3 = Vector3, CFrame = CFrame,
		Color3 = Color3, UDim2 = UDim2, RaycastParams = RaycastParams,
		task = task, math = math, string = string, table = tbl,
		os = { clock = function() return mock.clock end, time = function() return mock.clock end },
		print = function() end,
		warn = function(...)
			local parts = {}
			for i = 1, select("#", ...) do parts[i] = tostring(select(i, ...)) end
			table.insert(mock.warnings, table.concat(parts, " "))
		end,
		pcall = ypcall, ipairs = ipairs, pairs = pairs, next = next, select = select,
		tostring = tostring, tonumber = tonumber, type = type, error = error,
		assert = assert, unpack = unpack, setmetatable = setmetatable, getmetatable = getmetatable,
		rawget = rawget, rawset = rawset,
	}
	env.require = function(module)
		if type(module) ~= "table" or not module.__instance or not module:IsA("ModuleScript") then
			error("require expects a ModuleScript", 2)
		end
		if requireCache[module] == nil then
			requireCache[module] = mock.run(module)
		end
		return requireCache[module]
	end
	return env
end

function mock.run(scriptInstance)
	local source = rawget(scriptInstance, "__props").Source
	local fn, err = loadstring(source, "@" .. scriptInstance:GetFullName())
	if not fn then
		error(err, 0)
	end
	setfenv(fn, envFor(scriptInstance))
	return fn()
end

function mock.runSource(source, name)
	local holder = newRaw("Script")
	mock.setRaw(holder, "Name", name)
	mock.setRaw(holder, "Source", source)
	return mock.run(holder)
end

mock.Enum = Enum
mock.Instance = Instance
mock.Color3 = Color3
mock.isA = isA
return mock
