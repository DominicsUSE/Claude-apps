--[[
	ChadWorld (Script in ServerScriptService)
	Children: World (ModuleScript), Npcs (ModuleScript)

	Builds the test world if the place doesn't have one yet (the installer
	normally builds it in Studio), then starts the demo NPCs.
]]

local Workspace = game:GetService("Workspace")

local World = require(script:WaitForChild("World"))
local Npcs = require(script:WaitForChild("Npcs"))

if not Workspace:FindFirstChild(World.FOLDER_NAME) then
	World.build()
end

Npcs.start()
