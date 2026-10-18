-- CollectVFX: everything players see when they collect. Purely visual and local;
-- the server has already decided what was earned before any of this runs.
--   shard sparkle + spin (tag "Spin"), shard flies to the player, floating "+1 Ember Shard",
--   pod shakes while Break is held, pod burst, egg wobble + hatch burst.

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ProximityPromptService = game:GetService("ProximityPromptService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")

local Theme = require(ReplicatedStorage.Shared.Theme)

local player = Players.LocalPlayer
local T = Theme.Color
local rng = Random.new()
local GRAVITY = Vector3.new(0, -60, 0)

local CollectVFX = {}

local HUD
local spinners = {} -- [BasePart] = { base, speed, axis, bob }
local shaking = {} -- [Model] = base pivot
local bits = {} -- flying pieces, updated every frame
local emitters = {} -- [Color3 key] = ParticleEmitter

local function characterRoot()
	local character = player.Character
	return character and character:FindFirstChild("HumanoidRootPart")
end

local function plural(count, word)
	return ("+%d %s%s"):format(count, word, if count == 1 then "" else "s")
end

-- ── Particles and pieces ─────────────────────────────────

local function burst(position, color, count)
	local key = color:ToHex()
	local emitter = emitters[key]
	if not emitter then
		local holder = Instance.new("Part")
		holder.Anchored = true
		holder.CanCollide = false
		holder.CanQuery = false
		holder.CanTouch = false
		holder.Transparency = 1
		holder.Size = Vector3.new(1, 1, 1)
		holder.Parent = workspace
		emitter = Instance.new("ParticleEmitter")
		emitter.Texture = "rbxasset://textures/particles/sparkles_main.dds"
		emitter.Color = ColorSequence.new(color)
		emitter.LightEmission = 1
		emitter.Rate = 0
		emitter.Lifetime = NumberRange.new(0.4, 0.9)
		emitter.Speed = NumberRange.new(8, 16)
		emitter.SpreadAngle = Vector2.new(180, 180)
		emitter.Drag = 4
		emitter.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0.6), NumberSequenceKeypoint.new(1, 0) })
		emitter.Parent = holder
		emitters[key] = emitter
	end
	emitter.Parent.CFrame = CFrame.new(position)
	emitter:Emit(count)
end

local function newPiece(color, size)
	local part = Instance.new("Part")
	part.Anchored = true
	part.CanCollide = false
	part.CanQuery = false
	part.CanTouch = false
	part.CastShadow = false
	part.Material = Enum.Material.Neon
	part.Color = color
	part.Size = Vector3.new(size, size * 1.6, size)
	part.Parent = workspace
	return part
end

-- A piece that arcs from a point into the player.
local function seek(from, color, delaySeconds)
	task.delay(delaySeconds, function()
		table.insert(bits, {
			kind = "seek",
			part = newPiece(color, 0.45),
			from = from,
			lift = Vector3.new(rng:NextNumber(-2.5, 2.5), rng:NextNumber(3, 5), rng:NextNumber(-2.5, 2.5)),
			start = os.clock(),
			duration = rng:NextNumber(0.4, 0.55),
		})
	end)
end

-- A piece thrown outward that falls and shrinks.
local function debris(from, color)
	local direction = Vector3.new(rng:NextNumber(-1, 1), rng:NextNumber(0.8, 1.6), rng:NextNumber(-1, 1)).Unit
	table.insert(bits, {
		kind = "debris",
		part = newPiece(color, rng:NextNumber(0.4, 0.8)),
		position = from,
		velocity = direction * rng:NextNumber(14, 22),
		start = os.clock(),
		duration = 0.8,
	})
end

local function floatText(message, color, row)
	local character = player.Character
	local head = character and (character:FindFirstChild("Head") or character:FindFirstChild("HumanoidRootPart"))
	if not head then
		return
	end
	local gui = Instance.new("BillboardGui")
	gui.Size = UDim2.fromOffset(260, 34)
	gui.StudsOffset = Vector3.new(0, 2.4 + row * 1.1, 0)
	gui.AlwaysOnTop = true
	gui.LightInfluence = 0
	gui.Adornee = head
	gui.Parent = player.PlayerGui

	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Size = UDim2.fromScale(1, 1)
	label.Font = Theme.Font.Title
	label.TextSize = 22
	label.TextColor3 = color
	label.Text = message
	label.Parent = gui
	local outline = Instance.new("UIStroke")
	outline.Color = T.StoneDeep
	outline.Thickness = 2
	outline.Parent = label

	TweenService
		:Create(
			gui,
			TweenInfo.new(1.2, Enum.EasingStyle.Quad),
			{ StudsOffset = gui.StudsOffset + Vector3.new(0, 2.2, 0) }
		)
		:Play()
	local fade = TweenInfo.new(0.5, Enum.EasingStyle.Linear, Enum.EasingDirection.In, 0, false, 0.7)
	TweenService:Create(label, fade, { TextTransparency = 1 }):Play()
	TweenService:Create(outline, fade, { Transparency = 1 }):Play()
	task.delay(1.3, function()
		gui:Destroy()
	end)
end

-- ── Per-frame update ─────────────────────────────────────

local function step()
	local now = os.clock()
	local camera = workspace.CurrentCamera
	local cameraPosition = camera and camera.CFrame.Position or Vector3.zero

	for part, spin in pairs(spinners) do
		if (spin.base.Position - cameraPosition).Magnitude < 160 then
			local angle = now * spin.speed
			local rotation = if spin.axis == "X" then CFrame.Angles(angle, 0, 0) else CFrame.Angles(0, angle, 0)
			local bob = math.sin(now * 2 + spin.base.X) * spin.bob
			part.CFrame = CFrame.new(0, bob, 0) * spin.base * rotation
		end
	end

	for model, base in pairs(shaking) do
		local jitter = Vector3.new(rng:NextNumber(-1, 1), 0, rng:NextNumber(-1, 1)) * 0.12
		model:PivotTo(base + jitter)
	end

	local root = characterRoot()
	for i = #bits, 1, -1 do
		local bit = bits[i]
		local alpha = math.min((now - bit.start) / bit.duration, 1)
		if bit.kind == "seek" then
			local target = if root then root.Position else bit.from
			local a = alpha * alpha
			local control = bit.from + bit.lift
			local position = bit.from:Lerp(control, a):Lerp(control:Lerp(target, a), a)
			bit.part.CFrame = CFrame.new(position) * CFrame.Angles(now * 9, now * 7, 0)
		else
			local dt = now - (bit.last or bit.start)
			bit.last = now
			bit.velocity += GRAVITY * dt
			bit.position += bit.velocity * dt
			bit.part.CFrame = CFrame.new(bit.position) * CFrame.Angles(now * 6, 0, now * 4)
			bit.part.Transparency = alpha
		end
		if alpha >= 1 then
			bit.part:Destroy()
			table.remove(bits, i)
		end
	end
end

-- ── Events from the server ───────────────────────────────

function CollectVFX.Collect(payload)
	local position = payload.position
	if payload.kind == "shard" then
		seek(position, T.Shard, 0)
		task.delay(0.35, floatText, plural(payload.shards, "Ember Shard"), T.Shard, 0)
		HUD.Feed(plural(payload.shards, "Ember Shard"), T.Shard)
		return
	end

	for i = 1, math.min(payload.shards, 8) do
		seek(position + Vector3.new(0, 2, 0), T.Shard, 0.15 + i * 0.05)
	end
	local row = 0
	local function line(message, color)
		task.delay(0.5, floatText, message, color, row)
		HUD.Feed(message, color)
		row += 1
	end
	line(plural(payload.shards, "Ember Shard"), T.Shard)
	if payload.cores > 0 then
		for i = 1, payload.cores do
			seek(position + Vector3.new(0, 2.5, 0), T.Core, 0.3 + i * 0.1)
		end
		line(plural(payload.cores, "Crystal Core"), T.Core)
	end
	if payload.coins > 0 then
		line(plural(payload.coins, "Coin"), T.Coin)
	end
end

function CollectVFX.PodBurst(position, rare)
	local color = if rare then T.Core else T.Shard
	burst(position + Vector3.new(0, 2.5, 0), color, 36)
	for _ = 1, 8 do
		debris(position + Vector3.new(0, 2, 0), color)
	end
end

function CollectVFX.Hatch(eggPart, forgekinName)
	local message = ("You hatched %s!"):format(forgekinName)
	if eggPart and eggPart:IsA("BasePart") then
		local base = eggPart.CFrame
		task.spawn(function()
			for i = 1, 6 do
				local tilt = math.rad(if i % 2 == 0 then -14 else 14) * (1 - i / 8)
				local tween = TweenService:Create(
					eggPart,
					TweenInfo.new(0.11, Enum.EasingStyle.Sine),
					{ CFrame = base * CFrame.Angles(0, 0, tilt) }
				)
				tween:Play()
				tween.Completed:Wait()
			end
			eggPart.CFrame = base
			burst(base.Position, T.Amber, 48)
			for _ = 1, 10 do
				debris(base.Position, T.Parchment)
			end
			floatText(message, T.BrassBright, 0)
		end)
	end
	HUD.Toast(message, "success", "Your Forgekin follows you everywhere.")
end

-- ── Setup ────────────────────────────────────────────────

local function trackSpinner(part)
	if part:IsA("BasePart") then
		spinners[part] = {
			base = part.CFrame,
			speed = part:GetAttribute("Spin") or 1,
			axis = part:GetAttribute("SpinAxis") or "Y",
			bob = part:GetAttribute("Bob") or 0,
		}
	end
end

local function podOf(prompt)
	local holder = prompt.Parent
	local model = holder and holder.Parent
	if model and model:IsA("Model") and CollectionService:HasTag(model, "CrystalPod") then
		return model
	end
	return nil
end

local function stopShake(prompt)
	local model = podOf(prompt)
	if model and shaking[model] then
		model:PivotTo(shaking[model])
		shaking[model] = nil
	end
end

function CollectVFX.Init(hud)
	HUD = hud

	CollectionService:GetInstanceAddedSignal("Spin"):Connect(trackSpinner)
	CollectionService:GetInstanceRemovedSignal("Spin"):Connect(function(part)
		spinners[part] = nil
	end)
	for _, part in ipairs(CollectionService:GetTagged("Spin")) do
		trackSpinner(part)
	end

	ProximityPromptService.PromptButtonHoldBegan:Connect(function(prompt)
		local model = podOf(prompt)
		if model and not shaking[model] then
			shaking[model] = model:GetPivot()
		end
	end)
	ProximityPromptService.PromptButtonHoldEnded:Connect(stopShake)
	ProximityPromptService.PromptTriggered:Connect(stopShake)

	RunService.RenderStepped:Connect(step)
end

return CollectVFX
