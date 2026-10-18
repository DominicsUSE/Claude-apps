--!nocheck
-- Builds the finished game file. Runs the game's own world builders once (in the
-- playtest engine) and saves the result into the place, so Ember Hollow, the
-- Sunken Grove, every shard and pod, and the lighting are there the moment the
-- file opens in Studio, ready to edit by hand.
--
-- Run from the emberhatch folder after `rojo build default.project.json -o build/scripts.rbxlx`:
--   lune run tools/bake.luau
-- Writes EmberHatch.rbxl (binary) and EmberHatch.rbxlx (XML).

local fs = require("@lune/fs")
local roblox = require("@lune/roblox")

local Engine = require("../playtest/engine")

local SCRIPTS_PLACE = "build/scripts.rbxlx"
local BAKE = { "EmberHollow", "SunkenGrove", "Resources" } -- Workspace folders to keep
local SKIP = { NPCs = true } -- created fresh by HubNPCService every time the server starts

Engine.boot(SCRIPTS_PLACE)
Engine.runServerScripts()
Engine.frame(1 / 30)
if #Engine.errors > 0 then
	error("World builders failed:\n" .. table.concat(Engine.errors, "\n"))
end

local place = roblox.deserializePlace(fs.readFile(SCRIPTS_PLACE))
local luneOf = {} -- [engine instance] = Lune instance
local refs = {}
local failures = {}

local function convert(inst, parent)
	local d = Engine.dataOf(inst)
	local out = roblox.Instance.new(d.ClassName)
	out.Name = d.Name
	for key, value in pairs(d.props) do
		if Engine.isInstance(value) then
			table.insert(refs, { out, key, value })
		else
			local ok, err = pcall(function()
				if key == "Font" and typeof(value) == "EnumItem" then
					out.FontFace = roblox.Font.fromEnum(value) -- the saved form of Font
				else
					out[key] = value
				end
			end)
			if not ok then
				table.insert(failures, ("%s.%s: %s"):format(inst:GetFullName(), key, tostring(err):match("^[^\n]*")))
			end
		end
	end
	for name, value in pairs(d.attrs) do
		out:SetAttribute(name, value)
	end
	for tag in pairs(d.tags) do
		out:AddTag(tag)
	end
	luneOf[inst] = out
	for _, child in ipairs(inst:GetChildren()) do
		if not SKIP[child.Name] then
			convert(child, out)
		end
	end
	out.Parent = parent
	return out
end

local workspace = place:GetService("Workspace")
for _, name in ipairs(BAKE) do
	local folder = Engine.workspace:FindFirstChild(name)
	assert(folder, "missing workspace." .. name)
	convert(folder, workspace)
end

local lighting = place:GetService("Lighting")
for key, value in pairs(Engine.dataOf(Engine.game:GetService("Lighting")).props) do
	lighting[key] = value
end
for _, child in ipairs(Engine.game:GetService("Lighting"):GetChildren()) do
	convert(child, lighting)
end

for _, ref in ipairs(refs) do
	local target = luneOf[ref[3]]
	if target then
		ref[1][ref[2]] = target
	end
end

if #failures > 0 then
	error("Some properties couldn't be saved:\n" .. table.concat(failures, "\n"))
end

fs.writeFile("EmberHatch.rbxl", roblox.serializePlace(place))
fs.writeFile("EmberHatch.rbxlx", roblox.serializePlace(place, true))

local parts = 0
for _, inst in ipairs(workspace:GetDescendants()) do
	if inst:IsA("BasePart") then
		parts += 1
	end
end
print(("Baked %d parts into EmberHatch.rbxl and EmberHatch.rbxlx"):format(parts))
