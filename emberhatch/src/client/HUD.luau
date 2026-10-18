-- HUD: stone panels with brass borders, kept to the screen edges.
--   top left    area name
--   top center  coins, gems, level, XP
--   right       starter quests
--   bottom left Ember Shards and Crystal Cores
--   bottom right recent pickups
-- All numbers come from player attributes the server sets, so the HUD can't drift.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")

local Theme = require(ReplicatedStorage.Shared.Theme)
local ZoneConfig = require(ReplicatedStorage.Shared.ZoneConfig)

local player = Players.LocalPlayer
local T = Theme.Color

local HUD = {}

local gui
local refs = {}
local feed, toasts

-- ── Small UI kit ─────────────────────────────────────────

local function make(className, props, children)
	local instance = Instance.new(className)
	for key, value in pairs(props) do
		if key ~= "Parent" then
			instance[key] = value
		end
	end
	for _, child in ipairs(children or {}) do
		child.Parent = instance
	end
	instance.Parent = props.Parent
	return instance
end

local function corner(radius)
	return make("UICorner", { CornerRadius = radius or Theme.Radius.Medium })
end

local function stroke(color, thickness)
	return make("UIStroke", { Color = color or T.Brass, Thickness = thickness or 1.5, Transparency = 0.1 })
end

-- Stone panel with brass border, soft drop shadow and a small ember accent on top.
local function panel(props)
	local frame = make("Frame", {
		Parent = props.Parent,
		Name = props.Name,
		Size = props.Size,
		Position = props.Position,
		AnchorPoint = props.AnchorPoint or Vector2.zero,
		BackgroundColor3 = T.StoneBase,
		BackgroundTransparency = 0.06,
		AutomaticSize = props.AutomaticSize or Enum.AutomaticSize.None,
	}, { corner(), stroke(T.BrassDim) })

	make("Frame", {
		Parent = frame,
		Name = "Shadow",
		ZIndex = 0,
		Size = UDim2.new(1, 4, 1, 4),
		Position = UDim2.fromOffset(-2, 3),
		BackgroundColor3 = Color3.new(0, 0, 0),
		BackgroundTransparency = 0.65,
	}, { corner() })

	make("Frame", {
		Parent = frame,
		Name = "EmberAccent",
		Size = UDim2.new(0.3, 0, 0, 2),
		Position = UDim2.new(0.5, 0, 0, 0),
		AnchorPoint = Vector2.new(0.5, 0.5),
		BackgroundColor3 = T.Amber,
		BorderSizePixel = 0,
	}, { corner(UDim.new(1, 0)) })
	return frame
end

local function text(props)
	return make("TextLabel", {
		Parent = props.Parent,
		Name = props.Name,
		Size = props.Size,
		Position = props.Position or UDim2.new(),
		AnchorPoint = props.AnchorPoint or Vector2.zero,
		BackgroundTransparency = 1,
		Text = props.Text or "",
		Font = props.Font or Theme.Font.Body,
		TextSize = props.TextSize or 14,
		TextColor3 = props.Color or T.Parchment,
		TextXAlignment = props.XAlign or Enum.TextXAlignment.Left,
		TextYAlignment = Enum.TextYAlignment.Center,
		TextTruncate = Enum.TextTruncate.AtEnd,
		RichText = props.RichText == true,
		LayoutOrder = props.LayoutOrder or 0,
		TextTransparency = props.TextTransparency or 0,
	})
end

-- Diamond or coin icon drawn from frames (no image uploads needed).
local function icon(parent, color, round, size)
	size = size or 16
	local holder =
		make("Frame", { Parent = parent, Size = UDim2.fromOffset(size + 6, size + 6), BackgroundTransparency = 1 })
	make("Frame", {
		Parent = holder,
		Size = UDim2.fromOffset(size, size),
		Position = UDim2.fromScale(0.5, 0.5),
		AnchorPoint = Vector2.new(0.5, 0.5),
		Rotation = if round then 0 else 45,
		BackgroundColor3 = color,
	}, { corner(if round then UDim.new(1, 0) else UDim.new(0, 3)), stroke(color:Lerp(Color3.new(1, 1, 1), 0.35), 1) })
	return holder
end

local function formatNumber(n)
	n = math.floor(n or 0)
	if n >= 1e6 then
		return ("%.1fM"):format(n / 1e6)
	end
	local s = tostring(n)
	return (s:reverse():gsub("(%d%d%d)", "%1,"):reverse():gsub("^,", ""))
end

local function pop(label)
	local scale = label:FindFirstChildOfClass("UIScale") or make("UIScale", { Parent = label })
	scale.Scale = 1.25
	TweenService:Create(scale, TweenInfo.new(0.25, Enum.EasingStyle.Back), { Scale = 1 }):Play()
end

-- ── Sections ─────────────────────────────────────────────

local function buildArea()
	local frame =
		panel({ Parent = gui, Name = "Area", Size = UDim2.fromOffset(200, 50), Position = UDim2.fromOffset(12, 8) })
	refs.areaName = text({
		Parent = frame,
		Size = UDim2.new(1, -24, 0, 24),
		Position = UDim2.fromOffset(12, 5),
		Font = Theme.Font.Title,
		TextSize = 17,
	})
	refs.areaSub = text({
		Parent = frame,
		Size = UDim2.new(1, -24, 0, 16),
		Position = UDim2.fromOffset(12, 28),
		TextSize = 12,
		Color = T.ParchmentDim,
	})
end

local function buildStats()
	local outer = panel({
		Parent = gui,
		Name = "Stats",
		Size = UDim2.fromOffset(0, 44),
		Position = UDim2.new(0.5, 0, 0, 8),
		AnchorPoint = Vector2.new(0.5, 0),
	})
	outer.AutomaticSize = Enum.AutomaticSize.X
	-- Layouts live in a content frame so they don't pick up the shadow and accent.
	local frame = make("Frame", {
		Parent = outer,
		Size = UDim2.fromOffset(0, 44),
		AutomaticSize = Enum.AutomaticSize.X,
		BackgroundTransparency = 1,
	})
	make("UIPadding", { Parent = frame, PaddingLeft = UDim.new(0, 12), PaddingRight = UDim.new(0, 14) })
	make("UIListLayout", {
		Parent = frame,
		FillDirection = Enum.FillDirection.Horizontal,
		VerticalAlignment = Enum.VerticalAlignment.Center,
		Padding = UDim.new(0, 8),
		SortOrder = Enum.SortOrder.LayoutOrder,
	})

	local function counter(order, color, round, key)
		local i = icon(frame, color, round)
		i.LayoutOrder = order
		refs[key] = text({
			Parent = frame,
			Size = UDim2.fromOffset(58, 28),
			Font = Theme.Font.Number,
			TextSize = 18,
			LayoutOrder = order + 1,
		})
	end
	counter(1, T.Coin, true, "coins")
	counter(3, T.Gem, false, "gems")

	local badge = make(
		"Frame",
		{ Parent = frame, Size = UDim2.fromOffset(46, 26), BackgroundColor3 = T.StoneRaised, LayoutOrder = 5 },
		{
			corner(Theme.Radius.Small),
			stroke(T.Brass, 1),
		}
	)
	refs.level = text({
		Parent = badge,
		Size = UDim2.fromScale(1, 1),
		Font = Theme.Font.Number,
		TextSize = 16,
		Color = T.BrassBright,
		XAlign = Enum.TextXAlignment.Center,
	})

	local bar = make(
		"Frame",
		{ Parent = frame, Size = UDim2.fromOffset(110, 14), BackgroundColor3 = T.StoneDeep, LayoutOrder = 6 },
		{
			corner(UDim.new(1, 0)),
			stroke(T.BrassDim, 1),
		}
	)
	refs.xpFill = make(
		"Frame",
		{ Parent = bar, Size = UDim2.fromScale(0, 1), BackgroundColor3 = T.Amber },
		{ corner(UDim.new(1, 0)) }
	)
	refs.xpText = text({
		Parent = bar,
		Size = UDim2.fromScale(1, 1),
		Font = Theme.Font.Number,
		TextSize = 11,
		Color = T.StoneDeep,
		XAlign = Enum.TextXAlignment.Center,
	})
	refs.xpText.ZIndex = 2
end

local function buildResources()
	local frame = panel({
		Parent = gui,
		Name = "Resources",
		Size = UDim2.fromOffset(176, 74),
		Position = UDim2.new(0, 12, 1, -12),
		AnchorPoint = Vector2.new(0, 1),
	})
	for row, def in ipairs({
		{ "shards", "Ember Shards", T.Shard },
		{ "cores", "Crystal Cores", T.Core },
	}) do
		local y = 8 + (row - 1) * 31
		local i = icon(frame, def[3], false, 14)
		i.Position = UDim2.fromOffset(10, y + 2)
		text({
			Parent = frame,
			Size = UDim2.fromOffset(90, 26),
			Position = UDim2.fromOffset(36, y),
			Text = def[2],
			TextSize = 13,
			Color = T.ParchmentDim,
		})
		refs[def[1]] = text({
			Parent = frame,
			Size = UDim2.fromOffset(50, 26),
			Position = UDim2.new(1, -10, 0, y),
			AnchorPoint = Vector2.new(1, 0),
			Font = Theme.Font.Number,
			TextSize = 19,
			XAlign = Enum.TextXAlignment.Right,
		})
	end
end

local function buildQuests()
	local outer = panel({
		Parent = gui,
		Name = "Quests",
		Size = UDim2.fromOffset(236, 0),
		Position = UDim2.new(1, -12, 0, 64),
		AnchorPoint = Vector2.new(1, 0),
	})
	outer.AutomaticSize = Enum.AutomaticSize.Y
	local frame = make("Frame", {
		Parent = outer,
		Size = UDim2.fromScale(1, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundTransparency = 1,
	})
	make("UIPadding", {
		Parent = frame,
		PaddingTop = UDim.new(0, 8),
		PaddingBottom = UDim.new(0, 10),
		PaddingLeft = UDim.new(0, 12),
		PaddingRight = UDim.new(0, 12),
	})
	make("UIListLayout", { Parent = frame, Padding = UDim.new(0, 4), SortOrder = Enum.SortOrder.LayoutOrder })
	refs.questHeader = text({
		Parent = frame,
		Size = UDim2.new(1, 0, 0, 20),
		Font = Theme.Font.Title,
		TextSize = 14,
		Color = T.BrassBright,
	})
	refs.questFrame = frame
	refs.questPanel = outer
end

local function buildFeedAndToasts()
	-- On touch screens the jump button sits bottom right, so the feed moves up.
	local lift = if UserInputService.TouchEnabled then 170 else 12
	feed = make("Frame", {
		Parent = gui,
		Name = "PickupFeed",
		Size = UDim2.fromOffset(210, 160),
		Position = UDim2.new(1, -12, 1, -lift),
		AnchorPoint = Vector2.new(1, 1),
		BackgroundTransparency = 1,
	}, {
		make("UIListLayout", {
			VerticalAlignment = Enum.VerticalAlignment.Bottom,
			HorizontalAlignment = Enum.HorizontalAlignment.Right,
			Padding = UDim.new(0, 4),
			SortOrder = Enum.SortOrder.LayoutOrder,
		}),
	})

	toasts = make("Frame", {
		Parent = gui,
		Name = "Toasts",
		Size = UDim2.fromOffset(360, 120),
		Position = UDim2.new(0.5, 0, 0, 60),
		AnchorPoint = Vector2.new(0.5, 0),
		BackgroundTransparency = 1,
	}, {
		make("UIListLayout", {
			HorizontalAlignment = Enum.HorizontalAlignment.Center,
			Padding = UDim.new(0, 4),
			SortOrder = Enum.SortOrder.LayoutOrder,
		}),
	})
end

-- ── Live updates ─────────────────────────────────────────

local function refreshArea()
	local zone = ZoneConfig.Zones[player:GetAttribute("Zone") or ZoneConfig.Hub] or ZoneConfig.Zones[ZoneConfig.Hub]
	refs.areaName.Text = zone.displayName
	refs.areaSub.Text = zone.subtitle
end

local function refreshStats()
	refs.coins.Text = formatNumber(player:GetAttribute("Coins"))
	refs.gems.Text = formatNumber(player:GetAttribute("Gems"))
	refs.level.Text = "Lv " .. (player:GetAttribute("Level") or 1)
	local xp, nextXp = player:GetAttribute("XP") or 0, player:GetAttribute("XPNext") or 1
	refs.xpText.Text = ("%d / %d"):format(xp, nextXp)
	TweenService:Create(refs.xpFill, TweenInfo.new(0.3), { Size = UDim2.fromScale(math.clamp(xp / nextXp, 0, 1), 1) })
		:Play()
end

local function refreshResources()
	refs.shards.Text = formatNumber(player:GetAttribute("EmberShards"))
	refs.cores.Text = formatNumber(player:GetAttribute("CrystalCores"))
end

local function refreshQuests()
	local ok, quests = pcall(HttpService.JSONDecode, HttpService, player:GetAttribute("QuestState") or "[]")
	if not ok then
		return
	end
	for _, child in ipairs(refs.questFrame:GetChildren()) do
		if child:GetAttribute("QuestRow") then
			child:Destroy()
		end
	end

	local done, shown, hinted = 0, 0, false
	for index, quest in ipairs(quests) do
		if quest.done then
			done += 1
		elseif shown < 3 then
			shown += 1
			local row = make("Frame", {
				Parent = refs.questFrame,
				Size = UDim2.new(1, 0, 0, 0),
				AutomaticSize = Enum.AutomaticSize.Y,
				BackgroundTransparency = 1,
				LayoutOrder = index,
			})
			row:SetAttribute("QuestRow", true)
			make("UIListLayout", { Parent = row, SortOrder = Enum.SortOrder.LayoutOrder })

			local progress = if quest.target > 1 then ("  %d/%d"):format(quest.progress, quest.target) else ""
			local title = text({
				Parent = row,
				Size = UDim2.new(1, 0, 0, 18),
				Text = "◆ " .. quest.title .. progress,
				TextSize = 13,
				LayoutOrder = 1,
			})
			title.TextTruncate = Enum.TextTruncate.None
			title.TextWrapped = true
			title.AutomaticSize = Enum.AutomaticSize.Y
			if not hinted then
				hinted = true
				local hint = text({
					Parent = row,
					Size = UDim2.new(1, 0, 0, 16),
					Text = "    " .. quest.hint,
					TextSize = 12,
					Color = T.Amber,
					LayoutOrder = 2,
				})
				hint.TextWrapped = true
				hint.TextTruncate = Enum.TextTruncate.None
				hint.AutomaticSize = Enum.AutomaticSize.Y
			end
		end
	end
	refs.questHeader.Text = ("Starter Quests   %d/%d"):format(done, #quests)
	refs.questPanel.Visible = #quests > 0
end

-- ── Public ───────────────────────────────────────────────

function HUD.Build()
	gui = make("ScreenGui", {
		Parent = player:WaitForChild("PlayerGui"),
		Name = "EmberHatchHUD",
		ResetOnSpawn = false,
		ZIndexBehavior = Enum.ZIndexBehavior.Global, -- lets panel shadows (ZIndex 0) sit under their panel
	})
	make("UIScale", { Parent = gui, Scale = 1 })

	buildArea()
	buildStats()
	buildResources()
	buildQuests()
	buildFeedAndToasts()

	local watch = {
		Zone = refreshArea,
		Coins = refreshStats,
		Gems = refreshStats,
		Level = refreshStats,
		XP = refreshStats,
		XPNext = refreshStats,
		EmberShards = refreshResources,
		CrystalCores = refreshResources,
		QuestState = refreshQuests,
	}
	for attribute, refresh in pairs(watch) do
		player:GetAttributeChangedSignal(attribute):Connect(refresh)
	end
	player:GetAttributeChangedSignal("Coins"):Connect(function()
		pop(refs.coins)
	end)
	player:GetAttributeChangedSignal("Gems"):Connect(function()
		pop(refs.gems)
	end)
	player:GetAttributeChangedSignal("EmberShards"):Connect(function()
		pop(refs.shards)
	end)
	player:GetAttributeChangedSignal("CrystalCores"):Connect(function()
		pop(refs.cores)
	end)
	player:GetAttributeChangedSignal("Level"):Connect(function()
		pop(refs.level)
	end)

	refreshArea()
	refreshStats()
	refreshResources()
	refreshQuests()

	-- Scale up a little on big screens; phones stay at 1.
	local camera = workspace.CurrentCamera
	local function rescale()
		gui.UIScale.Scale = math.clamp(camera.ViewportSize.Y / 720, 0.9, 1.3)
	end
	camera:GetPropertyChangedSignal("ViewportSize"):Connect(rescale)
	rescale()

	if player:GetAttribute("SaveMode") == "offline" then
		HUD.Toast("Saving is off in this test. Enable Studio API access to save.", "info")
	end
	player:GetAttributeChangedSignal("SaveMode"):Connect(function()
		if player:GetAttribute("SaveMode") == "offline" then
			HUD.Toast("Saving is off in this test. Enable Studio API access to save.", "info")
		end
	end)
end

-- Short message under the stats bar. kind: "info" | "success" | "error".
function HUD.Toast(message, kind, detail)
	local color = if kind == "success" then T.Success elseif kind == "error" then T.Error else T.Amber
	local frame = panel({ Parent = toasts, Size = UDim2.fromOffset(340, if detail then 48 else 32) })
	frame.UIStroke.Color = color
	text({
		Parent = frame,
		Size = UDim2.new(1, -20, 0, 24),
		Position = UDim2.fromOffset(10, 4),
		Text = message,
		TextSize = 14,
		XAlign = Enum.TextXAlignment.Center,
	})
	if detail then
		text({
			Parent = frame,
			Size = UDim2.new(1, -20, 0, 16),
			Position = UDim2.fromOffset(10, 26),
			Text = detail,
			TextSize = 12,
			Color = color,
			XAlign = Enum.TextXAlignment.Center,
		})
	end
	local children = toasts:GetChildren()
	if #children > 4 then -- layout + 3 toasts
		for _, child in ipairs(children) do
			if child:IsA("Frame") and child ~= frame then
				child:Destroy()
				break
			end
		end
	end
	task.delay(3.5, function()
		if frame.Parent then
			frame:Destroy()
		end
	end)
end

-- One line in the bottom-right pickup feed.
local feedOrder = 0
function HUD.Feed(message, color)
	feedOrder += 1
	local frame = panel({ Parent = feed, Size = UDim2.fromOffset(0, 28) })
	frame.AutomaticSize = Enum.AutomaticSize.X
	frame.LayoutOrder = feedOrder
	frame.EmberAccent.Visible = false
	local content = make("Frame", {
		Parent = frame,
		Size = UDim2.fromOffset(0, 28),
		AutomaticSize = Enum.AutomaticSize.X,
		BackgroundTransparency = 1,
	})
	make("UIPadding", { Parent = content, PaddingLeft = UDim.new(0, 8), PaddingRight = UDim.new(0, 12) })
	make("UIListLayout", {
		Parent = content,
		FillDirection = Enum.FillDirection.Horizontal,
		VerticalAlignment = Enum.VerticalAlignment.Center,
		Padding = UDim.new(0, 6),
	})
	icon(content, color, false, 10)
	local label = text({ Parent = content, Size = UDim2.fromOffset(0, 24), Text = message, TextSize = 14 })
	label.AutomaticSize = Enum.AutomaticSize.X

	local rows = {}
	for _, child in ipairs(feed:GetChildren()) do
		if child:IsA("Frame") then
			table.insert(rows, child)
		end
	end
	table.sort(rows, function(a, b)
		return a.LayoutOrder < b.LayoutOrder
	end)
	for i = 1, #rows - 4 do
		rows[i]:Destroy()
	end

	task.delay(3, function()
		if frame.Parent then
			TweenService:Create(frame, TweenInfo.new(0.4), { BackgroundTransparency = 1 }):Play()
			TweenService:Create(label, TweenInfo.new(0.4), { TextTransparency = 1 }):Play()
			task.wait(0.4)
			frame:Destroy()
		end
	end)
end

-- Full-screen tint while a portal moves you.
function HUD.Flash(color, title)
	local flash = make("Frame", {
		Parent = gui,
		Size = UDim2.new(1, 0, 1, 80),
		Position = UDim2.fromOffset(0, -60),
		BackgroundColor3 = color,
		BackgroundTransparency = 0.2,
		ZIndex = 50,
	})
	TweenService:Create(
		flash,
		TweenInfo.new(0.6, Enum.EasingStyle.Quad, Enum.EasingDirection.In, 0, false, 0.25),
		{ BackgroundTransparency = 1 }
	):Play()
	task.delay(1, function()
		flash:Destroy()
	end)
	HUD.Toast("Entering " .. title, "info")
end

-- Game title card, shown once on join in the upper third (never the center).
function HUD.TitleCard()
	local card = make("Frame", {
		Parent = gui,
		Size = UDim2.fromOffset(420, 90),
		Position = UDim2.fromScale(0.5, 0.16),
		AnchorPoint = Vector2.new(0.5, 0),
		BackgroundTransparency = 1,
	})
	local title = text({
		Parent = card,
		Size = UDim2.new(1, 0, 0, 56),
		Text = Theme.Game.Title,
		Font = Theme.Font.Display,
		TextSize = 52,
		Color = T.BrassBright,
		XAlign = Enum.TextXAlignment.Center,
		TextTransparency = 1,
	})
	local sub = text({
		Parent = card,
		Size = UDim2.new(1, 0, 0, 22),
		Position = UDim2.fromOffset(0, 58),
		Text = Theme.Game.Subtitle,
		Font = Theme.Font.Title,
		TextSize = 16,
		Color = T.Parchment,
		XAlign = Enum.TextXAlignment.Center,
		TextTransparency = 1,
	})
	make("UIStroke", { Parent = title, Color = T.StoneDeep, Thickness = 2, Transparency = 1 })

	local show, hide = TweenInfo.new(0.6), TweenInfo.new(0.8)
	TweenService:Create(title, show, { TextTransparency = 0 }):Play()
	TweenService:Create(title.UIStroke, show, { Transparency = 0.2 }):Play()
	TweenService:Create(sub, show, { TextTransparency = 0 }):Play()
	task.delay(3.5, function()
		TweenService:Create(title, hide, { TextTransparency = 1 }):Play()
		TweenService:Create(title.UIStroke, hide, { Transparency = 1 }):Play()
		TweenService:Create(sub, hide, { TextTransparency = 1 }):Play()
		task.wait(0.9)
		card:Destroy()
	end)
end

return HUD
