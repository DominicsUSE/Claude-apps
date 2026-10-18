--!nocheck
-- A headless stand-in for the Roblox engine: enough of it to run EMBERHATCH's real
-- scripts (loaded from EmberHatch.rbxlx) and play them from a script.
--
-- What is real: every Roblox datatype (Vector3, CFrame, Enum, ...) comes from Lune,
-- and every property read or write is checked against Roblox's reflection database,
-- so a misspelt property or a wrong value type fails just like in Studio.
-- What is simulated: time (frames advance a virtual clock), events, CollectionService,
-- DataStores (kept in memory, JSON round-tripped), raycasts (box shapes), tweens
-- (jump to their end value), and players (moved by the play script, no physics).

local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local luau = require("@lune/luau")
local fs = require("@lune/fs")

local Vector3, CFrame = roblox.Vector3, roblox.CFrame
local Enum = roblox.Enum
local db = roblox.getReflectionDatabase()
local luneTypeof = typeof

local Engine = {}
Engine.errors = {} -- script errors with tracebacks
Engine.warnings = {}
Engine.prints = {}
Engine.kicks = {}
Engine.emitted = 0

-- ── Virtual clock and task scheduler ─────────────────────

local now = 0
local START_TIME = 1760000000
local queue = {}
local cancelled = setmetatable({}, { __mode = "k" })

local function resume(co, ...)
	local ok, err = coroutine.resume(co, ...)
	if not ok then
		table.insert(Engine.errors, ("[t=%.2fs] %s"):format(now, debug.traceback(co, tostring(err))))
	end
end

local function schedule(entry)
	table.insert(queue, entry)
end

local task = {}
function task.spawn(f, ...)
	local co = if type(f) == "thread" then f else coroutine.create(f)
	resume(co, ...)
	return co
end
function task.defer(f, ...)
	local co = if type(f) == "thread" then f else coroutine.create(f)
	schedule({ at = now, co = co, args = table.pack(...) })
	return co
end
function task.delay(seconds, f, ...)
	local co = if type(f) == "thread" then f else coroutine.create(f)
	schedule({ at = now + (seconds or 0), co = co, args = table.pack(...) })
	return co
end
function task.wait(seconds)
	local co = coroutine.running()
	schedule({ at = now + (seconds or 0), co = co, waitStart = now })
	return coroutine.yield()
end
function task.cancel(co)
	cancelled[co] = true
end

Engine.task = task
function Engine.now()
	return now
end

-- ── Signals ──────────────────────────────────────────────

local Signal = {}
Signal.__index = Signal
function Signal.new()
	return setmetatable({ conns = {}, waiting = {} }, Signal)
end
function Signal:Connect(fn)
	local conn = { Connected = true }
	conn.fn = fn
	function conn.Disconnect()
		conn.Connected = false
	end
	table.insert(self.conns, conn)
	return conn
end
function Signal:Once(fn)
	local conn
	conn = self:Connect(function(...)
		conn.Disconnect()
		fn(...)
	end)
	return conn
end
function Signal:Wait()
	table.insert(self.waiting, coroutine.running())
	return coroutine.yield()
end
function Signal:Fire(...)
	for _, conn in ipairs(table.clone(self.conns)) do
		if conn.Connected then
			task.spawn(conn.fn, ...)
		end
	end
	local waiting = self.waiting
	self.waiting = {}
	for _, co in ipairs(waiting) do
		resume(co, ...)
	end
end
Engine.Signal = Signal

-- ── Instances ────────────────────────────────────────────

local data = setmetatable({}, { __mode = "k" })
local nextId = 0
local tagged = {} -- [tag] = { [instance] = true }
local tagSignals = {} -- [tag] = { added = Signal, removed = Signal }
local game

local function isInstance(v)
	return type(v) == "table" and data[v] ~= nil
end
Engine.isInstance = isInstance

local classCache = {}
local function classInfo(className)
	local cached = classCache[className]
	if cached then
		return cached
	end
	local class = db:GetClass(className)
	if not class then
		error(('Unable to create an Instance of type "%s"'):format(className), 3)
	end
	local info = { name = className, chain = {}, props = {}, defaults = {}, tags = {} }
	for _, tag in ipairs(class.Tags) do
		info.tags[tag] = true
	end
	local current = class
	while current do
		table.insert(info.chain, current.Name)
		for name, prop in pairs(current.Properties) do
			if info.props[name] == nil then
				info.props[name] = prop
			end
		end
		for name, value in pairs(current.DefaultProperties) do
			if info.defaults[name] == nil then
				info.defaults[name] = value
			end
		end
		current = current.Superclass and db:GetClass(current.Superclass)
	end
	info.isA = {}
	for _, name in ipairs(info.chain) do
		info.isA[name] = true
	end
	classCache[className] = info
	return info
end

local methods = {}
local events = {
	Instance = { "Destroying", "ChildAdded", "ChildRemoved", "DescendantAdded", "DescendantRemoving", "AncestryChanged", "Changed", "AttributeChanged" },
	ProximityPrompt = { "Triggered", "TriggerEnded", "PromptButtonHoldBegan", "PromptButtonHoldEnded", "PromptShown", "PromptHidden" },
	ProximityPromptService = { "PromptTriggered", "PromptTriggerEnded", "PromptButtonHoldBegan", "PromptButtonHoldEnded", "PromptShown", "PromptHidden" },
	RemoteEvent = { "OnClientEvent", "OnServerEvent" },
	Players = { "PlayerAdded", "PlayerRemoving" },
	Player = { "CharacterAdded", "CharacterRemoving" },
	RunService = { "Heartbeat", "RenderStepped", "Stepped" },
	Humanoid = { "Died" },
	GuiButton = { "MouseButton1Click", "Activated" },
}
local eventSets = {}
for className, names in pairs(events) do
	eventSets[className] = {}
	for _, name in ipairs(names) do
		eventSets[className][name] = true
	end
end

local function fullName(inst)
	local parts = {}
	local current = inst
	while current and current ~= game do
		table.insert(parts, 1, data[current].Name)
		current = data[current].Parent
	end
	return table.concat(parts, ".")
end

local function isDescendantOf(inst, ancestor)
	local current = data[inst].Parent
	while current do
		if current == ancestor then
			return true
		end
		current = data[current].Parent
	end
	return false
end

local function inGame(inst)
	return inst == game or (game ~= nil and isDescendantOf(inst, game))
end

local function descendants(inst, out)
	out = out or {}
	for _, child in ipairs(data[inst].children) do
		table.insert(out, child)
		descendants(child, out)
	end
	return out
end

local function signalOf(inst, name)
	local d = data[inst]
	local signal = d.signals[name]
	if not signal then
		signal = Signal.new()
		d.signals[name] = signal
	end
	return signal
end

local function tagSignal(tag)
	local s = tagSignals[tag]
	if not s then
		s = { added = Signal.new(), removed = Signal.new() }
		tagSignals[tag] = s
	end
	return s
end

local function typeName(v)
	if isInstance(v) then
		return "Instance"
	end
	local mt = type(v) == "table" and getmetatable(v)
	if mt and mt.__type then
		return mt.__type
	end
	return luneTypeof(v)
end
Engine.typeof = typeName

local NUMBER_TYPES = { Float32 = true, Float64 = true, Int32 = true, Int64 = true }
local STRING_TYPES = { String = true, Content = true, ContentId = true, BinaryString = true }

local function checkType(className, key, datatype, value)
	local ok
	if datatype == "Bool" then
		ok = type(value) == "boolean"
	elseif NUMBER_TYPES[datatype] then
		ok = type(value) == "number" and value == value
	elseif STRING_TYPES[datatype] then
		ok = type(value) == "string"
	elseif datatype == "Ref" then
		ok = value == nil or isInstance(value)
	elseif datatype:sub(1, 5) == "Enum." then
		ok = luneTypeof(value) == "EnumItem" and tostring(value.EnumType) == datatype
	else
		ok = typeName(value) == datatype
	end
	if not ok then
		error(("Unable to assign property %s. %s expected, got %s (%s)"):format(key, datatype, typeName(value), className), 3)
	end
end

local Inst = {}

local function fireChanged(inst, key)
	local d = data[inst]
	local s = d.propSignals[key]
	if s then
		s:Fire()
	end
	if d.signals.Changed then
		d.signals.Changed:Fire(key)
	end
end

local function setParent(inst, parent)
	local d = data[inst]
	if d.locked then
		error(("The Parent property of %s is locked"):format(d.Name), 3)
	end
	if parent ~= nil and not isInstance(parent) then
		error("Parent must be an Instance", 3)
	end
	if parent == inst or (parent and isDescendantOf(parent, inst)) then
		error("Attempt to set parent to a descendant (circular reference)", 3)
	end
	local old = d.Parent
	if old == parent then
		return
	end
	local wasInGame = inGame(inst)
	if old then
		local siblings = data[old].children
		table.remove(siblings, table.find(siblings, inst))
		if data[old].signals.ChildRemoved then
			data[old].signals.ChildRemoved:Fire(inst)
		end
	end
	d.Parent = parent
	if parent then
		table.insert(data[parent].children, inst)
	end
	local nowInGame = inGame(inst)
	local moved = { inst }
	descendants(inst, moved)
	if wasInGame ~= nowInGame then
		for _, item in ipairs(moved) do
			for tag in pairs(data[item].tags) do
				if nowInGame then
					tagSignal(tag).added:Fire(item)
				else
					tagSignal(tag).removed:Fire(item)
				end
			end
		end
	end
	if parent then
		if data[parent].signals.ChildAdded then
			data[parent].signals.ChildAdded:Fire(inst)
		end
		local ancestor = parent
		while ancestor do
			local s = data[ancestor].signals.DescendantAdded
			if s then
				for _, item in ipairs(moved) do
					s:Fire(item)
				end
			end
			ancestor = data[ancestor].Parent
		end
	end
	if d.signals.AncestryChanged then
		d.signals.AncestryChanged:Fire(inst, parent)
	end
end

local function newInstance(className, internal)
	local info = classInfo(className)
	if not internal and (info.tags.NotCreatable or info.tags.Service) then
		error(('Unable to create an Instance of type "%s"'):format(className), 3)
	end
	nextId += 1
	local inst = setmetatable({}, Inst)
	data[inst] = {
		id = nextId,
		info = info,
		ClassName = className,
		Name = className,
		children = {},
		props = {},
		attrs = {},
		tags = {},
		signals = {},
		propSignals = {},
		attrSignals = {},
	}
	return inst
end
Engine.newInstance = newInstance

-- Writes a property without the read-only check (for engine-owned values).
function Engine.setRaw(inst, key, value)
	data[inst].props[key] = value
	fireChanged(inst, key)
end

function Engine.sourceOf(inst)
	return data[inst].source
end

-- Defaults the reflection database leaves out but scripts rely on.
local EXTRA_DEFAULTS = {
	Humanoid = { Health = 100, MaxHealth = 100, WalkSpeed = 16 },
}

local function readProp(inst, key)
	local d = data[inst]
	local value = d.props[key]
	if value == nil then
		value = d.info.defaults[key]
	end
	if value == nil then
		local extra = EXTRA_DEFAULTS[d.ClassName]
		value = extra and extra[key]
	end
	return value
end

local BASEPART_SPECIAL = {
	Position = true,
	CFrame = true,
	Orientation = true,
	Rotation = true,
}

function Inst.__index(inst, key)
	local d = data[inst]
	if key == "Name" or key == "ClassName" or key == "Parent" then
		return d[key]
	end
	for _, className in ipairs(d.info.chain) do
		local m = methods[className]
		if m and m[key] then
			return m[key]
		end
		local e = eventSets[className]
		if e and e[key] then
			return signalOf(inst, key)
		end
	end
	if d.info.isA.BasePart and BASEPART_SPECIAL[key] then
		local cf = d.props.CFrame or CFrame.identity
		if key == "Position" then
			return cf.Position
		elseif key == "CFrame" then
			return cf
		end
	end
	if d.info.props[key] or d.props[key] ~= nil then
		return readProp(inst, key)
	end
	for _, child in ipairs(d.children) do
		if data[child].Name == key then
			return child
		end
	end
	error(("%s is not a valid member of %s \"%s\""):format(tostring(key), d.ClassName, fullName(inst)), 2)
end

function Inst.__newindex(inst, key, value)
	local d = data[inst]
	if key == "Parent" then
		setParent(inst, value)
		return
	end
	if key == "Name" then
		if type(value) ~= "string" then
			error("Name must be a string", 2)
		end
		d.Name = value
		fireChanged(inst, key)
		return
	end
	local prop = d.info.props[key]
	if not prop then
		error(("%s is not a valid member of %s \"%s\""):format(tostring(key), d.ClassName, fullName(inst)), 2)
	end
	if prop.Scriptability == "Read" or prop.Scriptability == "None" then
		error(("Unable to assign property %s. Property is read only"):format(key), 2)
	end
	checkType(d.ClassName, key, prop.Datatype, value)
	if d.info.isA.BasePart and key == "Position" then
		local cf = d.props.CFrame or CFrame.identity
		d.props.CFrame = CFrame.new(value) * cf.Rotation
		fireChanged(inst, "CFrame")
		return
	end
	d.props[key] = value
	fireChanged(inst, key)
end

function Inst.__tostring(inst)
	return data[inst].Name
end

-- ── Instance methods ─────────────────────────────────────

local SUPPORTED_ATTRIBUTE = {
	boolean = true,
	number = true,
	string = true,
	Vector3 = true,
	Vector2 = true,
	Color3 = true,
	CFrame = true,
	UDim = true,
	UDim2 = true,
	BrickColor = true,
	NumberRange = true,
	NumberSequence = true,
	ColorSequence = true,
	Rect = true,
	Font = true,
	EnumItem = true,
}

methods.Instance = {
	FindFirstChild = function(self, name, recursive)
		local list = if recursive then descendants(self) else data[self].children
		for _, child in ipairs(list) do
			if data[child].Name == name then
				return child
			end
		end
		return nil
	end,
	FindFirstChildOfClass = function(self, className)
		for _, child in ipairs(data[self].children) do
			if data[child].ClassName == className then
				return child
			end
		end
		return nil
	end,
	FindFirstChildWhichIsA = function(self, className, recursive)
		local list = if recursive then descendants(self) else data[self].children
		for _, child in ipairs(list) do
			if data[child].info.isA[className] then
				return child
			end
		end
		return nil
	end,
	WaitForChild = function(self, name, timeout)
		local found = self:FindFirstChild(name)
		local deadline = now + (timeout or 5)
		while not found do
			if now > deadline then
				if timeout then
					return nil
				end
				table.insert(Engine.warnings, ("Infinite yield possible on '%s:WaitForChild(\"%s\")'"):format(fullName(self), name))
				deadline = math.huge
			end
			task.wait(0.05)
			found = self:FindFirstChild(name)
		end
		return found
	end,
	GetChildren = function(self)
		return table.clone(data[self].children)
	end,
	GetDescendants = function(self)
		return descendants(self)
	end,
	IsA = function(self, className)
		return data[self].info.isA[className] == true
	end,
	IsDescendantOf = function(self, ancestor)
		return isDescendantOf(self, ancestor)
	end,
	GetFullName = function(self)
		return fullName(self)
	end,
	Destroy = function(self)
		local d = data[self]
		if d.destroyed then
			return
		end
		if d.signals.Destroying then
			d.signals.Destroying:Fire()
		end
		for _, child in ipairs(table.clone(d.children)) do
			child:Destroy()
		end
		setParent(self, nil)
		d.locked = true
		d.destroyed = true
	end,
	ClearAllChildren = function(self)
		for _, child in ipairs(table.clone(data[self].children)) do
			child:Destroy()
		end
	end,
	Clone = function(self)
		local d = data[self]
		local copy = newInstance(d.ClassName, true)
		local c = data[copy]
		c.Name = d.Name
		c.props = table.clone(d.props)
		c.attrs = table.clone(d.attrs)
		c.tags = table.clone(d.tags)
		c.source = d.source
		for tag in pairs(c.tags) do
			tagged[tag] = tagged[tag] or {}
			tagged[tag][copy] = true
		end
		for _, child in ipairs(d.children) do
			child:Clone().Parent = copy
		end
		return copy
	end,
	SetAttribute = function(self, name, value)
		if value ~= nil and not SUPPORTED_ATTRIBUTE[luneTypeof(value)] then
			error(("SetAttribute: %s is not a supported attribute type"):format(typeName(value)), 2)
		end
		local d = data[self]
		d.attrs[name] = value
		if d.attrSignals[name] then
			d.attrSignals[name]:Fire()
		end
		if d.signals.AttributeChanged then
			d.signals.AttributeChanged:Fire(name)
		end
	end,
	GetAttribute = function(self, name)
		return data[self].attrs[name]
	end,
	GetAttributes = function(self)
		return table.clone(data[self].attrs)
	end,
	GetAttributeChangedSignal = function(self, name)
		local d = data[self]
		d.attrSignals[name] = d.attrSignals[name] or Signal.new()
		return d.attrSignals[name]
	end,
	GetPropertyChangedSignal = function(self, name)
		local d = data[self]
		if not d.info.props[name] and name ~= "Name" and name ~= "Parent" then
			error(("%s is not a valid property name."):format(name), 2)
		end
		d.propSignals[name] = d.propSignals[name] or Signal.new()
		return d.propSignals[name]
	end,
}

local function bboxCenter(model)
	local sum, count = Vector3.zero, 0
	for _, part in ipairs(descendants(model)) do
		if data[part].info.isA.BasePart then
			sum += part.Position
			count += 1
		end
	end
	return if count > 0 then CFrame.new(sum / count) else CFrame.identity
end

methods.BasePart = {
	GetPivot = function(self)
		return self.CFrame
	end,
	PivotTo = function(self, cf)
		self.CFrame = cf
	end,
}
methods.Model = {
	GetPivot = function(self)
		local primary = self.PrimaryPart
		if primary then
			return primary.CFrame
		end
		return data[self].worldPivot or bboxCenter(self)
	end,
	PivotTo = function(self, cf)
		local delta = cf * self:GetPivot():Inverse()
		for _, part in ipairs(descendants(self)) do
			if data[part].info.isA.BasePart then
				part.CFrame = delta * part.CFrame
			end
		end
		if not self.PrimaryPart then
			data[self].worldPivot = cf
		end
	end,
}
methods.ParticleEmitter = {
	Emit = function(_, count)
		Engine.emitted += count or 16
	end,
	Clear = function() end,
}

-- ── Services ─────────────────────────────────────────────

Engine.clientRemoteLog = {} -- every server → client message the local player received

local function copyArgs(value)
	if type(value) == "table" and not isInstance(value) and getmetatable(value) == nil then
		local copy = {}
		for k, v in pairs(value) do
			copy[copyArgs(k)] = copyArgs(v)
		end
		return copy
	end
	if type(value) == "function" or type(value) == "thread" then
		error("Attempt to send a " .. type(value) .. " through a remote", 3)
	end
	return value
end

methods.RemoteEvent = {
	FireClient = function(self, player, ...)
		if not isInstance(player) or not player:IsA("Player") then
			error("FireClient: Unable to cast value to Object", 2)
		end
		local args = table.pack(...)
		for i = 1, args.n do
			args[i] = copyArgs(args[i])
		end
		if player == Engine.localPlayer then
			table.insert(Engine.clientRemoteLog, { t = now, remote = self.Name, args = args })
			self.OnClientEvent:Fire(table.unpack(args, 1, args.n))
		end
	end,
	FireAllClients = function(self, ...)
		if Engine.localPlayer then
			self:FireClient(Engine.localPlayer, ...)
		end
	end,
	FireServer = function(self, ...)
		self.OnServerEvent:Fire(Engine.localPlayer, ...)
	end,
}

local services = {}

methods.ServiceProvider = {
	GetService = function(self, className)
		local service = services[className]
		if not service then
			service = newInstance(className, true)
			data[service].Name = className
			services[className] = service
			setParent(service, game)
		end
		return service
	end,
	FindService = function(_, className)
		return services[className]
	end,
}
methods.DataModel = {
	BindToClose = function(_, fn)
		table.insert(Engine.closeCallbacks, fn)
	end,
}
Engine.closeCallbacks = {}

methods.Players = {
	GetPlayers = function(self)
		local list = {}
		for _, child in ipairs(data[self].children) do
			if child:IsA("Player") then
				table.insert(list, child)
			end
		end
		return list
	end,
	GetPlayerByUserId = function(self, userId)
		for _, player in ipairs(self:GetPlayers()) do
			if player.UserId == userId then
				return player
			end
		end
		return nil
	end,
}
methods.Player = {
	Kick = function(self, message)
		table.insert(Engine.kicks, { player = self.Name, message = message, t = now })
		task.defer(function()
			Engine.removePlayer(self)
		end)
	end,
}

methods.RunService = {
	IsStudio = function()
		return Engine.isStudio == true
	end,
	IsServer = function()
		return true
	end,
	IsClient = function()
		return true
	end,
	IsRunning = function()
		return true
	end,
}

methods.CollectionService = {
	AddTag = function(_, inst, tag)
		local d = data[inst]
		if d.tags[tag] then
			return
		end
		d.tags[tag] = true
		tagged[tag] = tagged[tag] or {}
		tagged[tag][inst] = true
		if inGame(inst) then
			tagSignal(tag).added:Fire(inst)
		end
	end,
	RemoveTag = function(_, inst, tag)
		local d = data[inst]
		if not d.tags[tag] then
			return
		end
		d.tags[tag] = nil
		tagged[tag][inst] = nil
		if inGame(inst) then
			tagSignal(tag).removed:Fire(inst)
		end
	end,
	HasTag = function(_, inst, tag)
		return data[inst].tags[tag] == true
	end,
	GetTags = function(_, inst)
		local list = {}
		for tag in pairs(data[inst].tags) do
			table.insert(list, tag)
		end
		return list
	end,
	GetTagged = function(_, tag)
		local list = {}
		for inst in pairs(tagged[tag] or {}) do
			if data[inst] and inGame(inst) and not data[inst].destroyed then
				table.insert(list, inst)
			end
		end
		table.sort(list, function(a, b)
			return data[a].id < data[b].id
		end)
		return list
	end,
	GetInstanceAddedSignal = function(_, tag)
		return tagSignal(tag).added
	end,
	GetInstanceRemovedSignal = function(_, tag)
		return tagSignal(tag).removed
	end,
}

methods.HttpService = {
	JSONEncode = function(_, value)
		return serde.encode("json", value)
	end,
	JSONDecode = function(_, text)
		return serde.decode("json", text)
	end,
}

-- Tweens jump to their goal when they finish; looping tweens never finish.
methods.TweenService = {
	Create = function(_, inst, info, goals)
		if typeName(info) ~= "TweenInfo" then
			error("TweenService:Create: TweenInfo expected", 2)
		end
		for key in pairs(goals) do
			if not data[inst].info.props[key] then
				error(("TweenService:Create property named '%s' cannot be tweened"):format(key), 2)
			end
		end
		local tween = { Completed = Signal.new(), PlaybackState = Enum.PlaybackState.Begin }
		function tween.Play()
			if info.RepeatCount < 0 then
				tween.PlaybackState = Enum.PlaybackState.Playing
				return
			end
			task.delay(info.DelayTime + info.Time * (info.RepeatCount + 1), function()
				if tween.PlaybackState == Enum.PlaybackState.Cancelled or data[inst].destroyed then
					return
				end
				for key, value in pairs(goals) do
					inst[key] = value
				end
				tween.PlaybackState = Enum.PlaybackState.Completed
				tween.Completed:Fire(Enum.PlaybackState.Completed)
			end)
		end
		function tween.Cancel()
			tween.PlaybackState = Enum.PlaybackState.Cancelled
		end
		tween.Pause = tween.Cancel
		return tween
	end,
}

-- DataStores live in memory and every write is JSON round-tripped, so anything
-- that couldn't be saved (an Instance, a Vector3, a mixed table) fails here too.
Engine.stores = {}
Engine.storeFailure = nil -- set to an error message to make every DataStore call fail
Engine.storeCalls = 0

local function storeCall()
	Engine.storeCalls += 1
	if Engine.storeFailure then
		error(Engine.storeFailure, 3)
	end
end

methods.DataStoreService = {
	GetDataStore = function(_, name)
		local entries = Engine.stores[name]
		if not entries then
			entries = {}
			Engine.stores[name] = entries
		end
		local store = {}
		function store.GetAsync(_, key)
			storeCall()
			return if entries[key] then serde.decode("json", entries[key]) else nil
		end
		function store.SetAsync(_, key, value)
			storeCall()
			entries[key] = serde.encode("json", value)
		end
		function store.UpdateAsync(_, key, transform)
			storeCall()
			local old = if entries[key] then serde.decode("json", entries[key]) else nil
			local new = transform(old)
			if new ~= nil then
				entries[key] = serde.encode("json", new)
			end
			return new
		end
		function store.RemoveAsync(_, key)
			storeCall()
			entries[key] = nil
		end
		return store
	end,
	GetRequestBudgetForRequestType = function()
		return 100
	end,
}

-- Raycasts treat every part as a box.
local function rayBox(origin, direction, part)
	local cf, half = part.CFrame, part.Size / 2
	local o = cf:PointToObjectSpace(origin)
	local d = cf:VectorToObjectSpace(direction)
	local tmin, tmax = 0, 1
	local normalAxis, normalSign = nil, 1
	for _, axis in ipairs({ "X", "Y", "Z" }) do
		local oa, da, ha = o[axis], d[axis], half[axis]
		if math.abs(da) < 1e-9 then
			if math.abs(oa) > ha then
				return nil
			end
		else
			local t1, t2 = (-ha - oa) / da, (ha - oa) / da
			local sign = -1
			if t1 > t2 then
				t1, t2 = t2, t1
				sign = 1
			end
			if t1 > tmin then
				tmin, normalAxis, normalSign = t1, axis, sign
			end
			tmax = math.min(tmax, t2)
			if tmin > tmax then
				return nil
			end
		end
	end
	local localNormal = Vector3.new(
		if normalAxis == "X" then normalSign else 0,
		if normalAxis == "Y" then normalSign else 0,
		if normalAxis == "Z" then normalSign else 0
	)
	return tmin, cf:VectorToWorldSpace(localNormal)
end

methods.WorldRoot = {
	Raycast = function(self, origin, direction, params)
		local include = params and params.FilterType == Enum.RaycastFilterType.Include
		local filter = params and params.FilterDescendantsInstances or {}
		local best
		for _, part in ipairs(descendants(self)) do
			local d = data[part]
			if d.info.isA.BasePart and (readProp(part, "CanQuery") ~= false or readProp(part, "CanCollide") ~= false) then
				local listed = false
				for _, item in ipairs(filter) do
					if part == item or isDescendantOf(part, item) then
						listed = true
						break
					end
				end
				if listed == include then
					local t, normal = rayBox(origin, direction, part)
					if t and (not best or t < best.t) then
						best = { t = t, part = part, normal = normal }
					end
				end
			end
		end
		if not best then
			return nil
		end
		return {
			Instance = best.part,
			Position = origin + direction * best.t,
			Normal = best.normal,
			Distance = direction.Magnitude * best.t,
			Material = readProp(best.part, "Material"),
		}
	end,
}

-- ── Script environment ───────────────────────────────────

local function makeType(name, fields)
	return setmetatable(fields, { __type = name })
end

local TweenInfo = {
	new = function(time, style, direction, repeatCount, reverses, delayTime)
		return makeType("TweenInfo", {
			Time = time or 1,
			EasingStyle = style or Enum.EasingStyle.Quad,
			EasingDirection = direction or Enum.EasingDirection.Out,
			RepeatCount = repeatCount or 0,
			Reverses = reverses or false,
			DelayTime = delayTime or 0,
		})
	end,
}

local RaycastParams = {
	new = function()
		return makeType("RaycastParams", {
			FilterType = Enum.RaycastFilterType.Exclude,
			FilterDescendantsInstances = {},
		})
	end,
}

local RandomMeta = {
	__type = "Random",
	__index = {
		NextInteger = function(_, a, b)
			return math.random(a, b)
		end,
		NextNumber = function(_, a, b)
			a, b = a or 0, b or 1
			return a + math.random() * (b - a)
		end,
	},
}
local Random = {
	new = function()
		return setmetatable({}, RandomMeta)
	end,
}

local InstanceLib = {
	new = function(className, parent)
		local inst = newInstance(className, false)
		if parent then
			inst.Parent = parent
		end
		return inst
	end,
}

local requireCache = {}
local baseEnv

local function compile(scriptInst)
	local source = data[scriptInst].source
	local env = setmetatable({ script = scriptInst }, { __index = baseEnv })
	return luau.load(source, { debugName = fullName(scriptInst), environment = env, injectGlobals = false })
end

local function scriptRequire(module)
	if not isInstance(module) or not module:IsA("ModuleScript") then
		error("Attempted to call require with invalid argument(s).", 2)
	end
	local cached = requireCache[module]
	if cached then
		return cached.value
	end
	local results = table.pack(compile(module)())
	if results.n ~= 1 then
		error(("Module code did not return exactly one value (%s)"):format(fullName(module)), 2)
	end
	requireCache[module] = { value = results[1] }
	return results[1]
end

baseEnv = {
	-- Luau standard library
	math = math,
	string = string,
	table = table,
	coroutine = coroutine,
	utf8 = utf8,
	bit32 = bit32,
	buffer = buffer,
	debug = debug,
	assert = assert,
	error = error,
	ipairs = ipairs,
	pairs = pairs,
	next = next,
	select = select,
	type = type,
	tonumber = tonumber,
	tostring = tostring,
	pcall = pcall,
	xpcall = xpcall,
	setmetatable = setmetatable,
	getmetatable = getmetatable,
	rawget = rawget,
	rawset = rawset,
	rawequal = rawequal,
	rawlen = rawlen,
	unpack = table.unpack,
	newproxy = newproxy,
	os = {
		clock = function()
			return now
		end,
		time = function()
			return START_TIME + math.floor(now)
		end,
		date = os.date,
	},
	-- Roblox globals
	print = function(...)
		local parts = table.pack(...)
		for i = 1, parts.n do
			parts[i] = tostring(parts[i])
		end
		table.insert(Engine.prints, table.concat(parts, " "))
	end,
	warn = function(...)
		local parts = table.pack(...)
		for i = 1, parts.n do
			parts[i] = tostring(parts[i])
		end
		table.insert(Engine.warnings, ("[t=%.2fs] %s"):format(now, table.concat(parts, " ")))
	end,
	typeof = typeName,
	require = scriptRequire,
	task = task,
	wait = task.wait,
	Instance = InstanceLib,
	Enum = Enum,
	Vector3 = Vector3,
	Vector2 = roblox.Vector2,
	CFrame = CFrame,
	Color3 = roblox.Color3,
	BrickColor = roblox.BrickColor,
	UDim = roblox.UDim,
	UDim2 = roblox.UDim2,
	Rect = roblox.Rect,
	NumberRange = roblox.NumberRange,
	NumberSequence = roblox.NumberSequence,
	NumberSequenceKeypoint = roblox.NumberSequenceKeypoint,
	ColorSequence = roblox.ColorSequence,
	ColorSequenceKeypoint = roblox.ColorSequenceKeypoint,
	Font = roblox.Font,
	TweenInfo = TweenInfo,
	RaycastParams = RaycastParams,
	Random = Random,
}

-- ── World setup ──────────────────────────────────────────

function Engine.boot(placePath)
	game = newInstance("DataModel", true)
	data[game].Name = "Game"
	data[game].props.JobId = "mock-server-1"
	baseEnv.game = game
	Engine.game = game

	local workspace = game:GetService("Workspace")
	baseEnv.workspace = workspace
	Engine.workspace = workspace
	local camera = newInstance("Camera", true)
	camera.Name = "Camera"
	Engine.setRaw(camera, "ViewportSize", roblox.Vector2.new(1280, 720))
	camera.Parent = workspace
	Engine.setRaw(workspace, "CurrentCamera", camera)
	for _, name in ipairs({
		"ReplicatedStorage",
		"ServerScriptService",
		"StarterPlayer",
		"Players",
		"Lighting",
		"RunService",
		"TweenService",
		"CollectionService",
		"HttpService",
		"DataStoreService",
		"UserInputService",
		"ProximityPromptService",
	}) do
		game:GetService(name)
	end

	local place = roblox.deserializePlace(fs.readFile(placePath))
	local function copy(source, target)
		for _, child in ipairs(source:GetChildren()) do
			local inst = newInstance(child.ClassName, true)
			data[inst].Name = child.Name
			if child:IsA("LuaSourceContainer") then
				data[inst].source = child.Source
			end
			copy(child, inst)
			inst.Parent = target
		end
	end
	for _, service in ipairs(place:GetChildren()) do
		if services[service.ClassName] then
			copy(service, services[service.ClassName])
		end
	end
end

-- The value a ModuleScript returned to the game (the same table the game uses).
function Engine.moduleValue(inst)
	local cached = requireCache[inst]
	return cached and cached.value
end

Engine.services = services

function Engine.runServerScripts()
	for _, inst in ipairs(descendants(services.ServerScriptService)) do
		if inst.ClassName == "Script" then
			task.spawn(compile(inst))
		end
	end
end

-- ── Players ──────────────────────────────────────────────

function Engine.addPlayer(userId, name, isLocal)
	local player = newInstance("Player", true)
	data[player].Name = name
	Engine.setRaw(player, "UserId", userId)
	Engine.setRaw(player, "DisplayName", name)
	local gui = newInstance("PlayerGui", true)
	gui.Name = "PlayerGui"
	gui.Parent = player
	local scripts = newInstance("PlayerScripts", true)
	scripts.Name = "PlayerScripts"
	scripts.Parent = player
	if isLocal then
		Engine.localPlayer = player
		Engine.setRaw(services.Players, "LocalPlayer", player)
	end
	player.Parent = services.Players
	services.Players.PlayerAdded:Fire(player)
	if isLocal then
		-- StarterPlayerScripts are copied into PlayerScripts and their LocalScripts run.
		local starter = services.StarterPlayer:FindFirstChildOfClass("StarterPlayerScripts")
		for _, child in ipairs(starter and starter:GetChildren() or {}) do
			child:Clone().Parent = scripts
		end
		for _, inst in ipairs(descendants(scripts)) do
			if inst.ClassName == "LocalScript" then
				task.spawn(compile(inst))
			end
		end
	end
	return player
end

function Engine.spawnCharacter(player)
	local character = newInstance("Model", true)
	character.Name = player.Name
	local root = InstanceLib.new("Part")
	root.Name = "HumanoidRootPart"
	root.Size = Vector3.new(2, 2, 1)
	root.Transparency = 1
	root.Parent = character
	local head = InstanceLib.new("Part")
	head.Name = "Head"
	head.Size = Vector3.new(2, 1, 1)
	head.Parent = character
	InstanceLib.new("Humanoid").Parent = character
	character.PrimaryPart = root

	local spawnCf = CFrame.new(0, 5, 0)
	for _, inst in ipairs(descendants(Engine.workspace)) do
		if inst.ClassName == "SpawnLocation" then
			spawnCf = inst.CFrame + Vector3.new(0, inst.Size.Y / 2 + 3, 0)
			break
		end
	end
	root.CFrame = spawnCf
	head.CFrame = spawnCf * CFrame.new(0, 1.5, 0)
	character.Parent = Engine.workspace
	player.Character = character
	player.CharacterAdded:Fire(character)
	return character
end

function Engine.removePlayer(player)
	if not player.Parent then
		return
	end
	services.Players.PlayerRemoving:Fire(player)
	if player.Character then
		player.Character:Destroy()
	end
	player.Parent = nil
end

function Engine.shutdown()
	for _, fn in ipairs(Engine.closeCallbacks) do
		task.spawn(fn)
	end
end

-- ── Driving time ─────────────────────────────────────────

-- Advances the clock one frame: resumes due threads, then fires Heartbeat/RenderStepped.
function Engine.frame(dt)
	now += dt
	local due = {}
	local i = 1
	while i <= #queue do
		if queue[i].at <= now then
			table.insert(due, table.remove(queue, i))
		else
			i += 1
		end
	end
	table.sort(due, function(a, b)
		return a.at < b.at
	end)
	for _, entry in ipairs(due) do
		if not cancelled[entry.co] and coroutine.status(entry.co) == "suspended" then
			if entry.waitStart then
				resume(entry.co, now - entry.waitStart)
			elseif entry.args then
				resume(entry.co, table.unpack(entry.args, 1, entry.args.n))
			else
				resume(entry.co)
			end
		end
	end
	local runService = services.RunService
	runService.Heartbeat:Fire(dt)
	runService.RenderStepped:Fire(dt)
end

-- Runs a play script (which may task.wait) while frames advance underneath it.
function Engine.play(scenario, fps)
	local dt = 1 / (fps or 30)
	local co = coroutine.create(scenario)
	resume(co)
	while coroutine.status(co) ~= "dead" do
		Engine.frame(dt)
	end
end

return Engine
